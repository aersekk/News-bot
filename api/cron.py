# api/cron.py
from http import HTTPStatus
from zoneinfo import ZoneInfo
from datetime import datetime, timezone
import os
import json
import hashlib
import logging

import requests
import feedparser

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# --- Required env vars ---
SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN")       # xoxb-...
SLACK_CHANNEL_ID = os.environ.get("SLACK_CHANNEL_ID")     # e.g. C01234567
UPSTASH_REDIS_REST = os.environ.get("UPSTASH_REDIS_REST") # https://<id>.redis.upstash.io
UPSTASH_REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_TOKEN")

# --- Optional env vars ---
MIN_SCORE = int(os.environ.get("MIN_SCORE", "3"))
POST_MAX = int(os.environ.get("POST_MAX_PER_RUN", "1"))
RSS_FEEDS = json.loads(os.environ.get(
    "RSS_FEEDS",
    '["https://techcrunch.com/feed/", "https://www.crn.com/news/data-center/rss.xml"]'
))

# DST-safe schedule: function can be called hourly, but only posts at these local hours
TARGET_HOURS_LONDON = [8, 17]  # 08:00 and 17:00 Europe/London

def sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()

# -------- Upstash Redis helpers (HTTP API) --------
def upstash_get(key: str):
    url = f"{UPSTASH_REDIS_REST}/get/{key}"
    headers = {"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}"}
    r = requests.get(url, headers=headers, timeout=8)
    if not r.ok:
        logger.warning("Upstash GET failed %s %s", r.status_code, r.text)
        return None
    return r.json().get("result")

def upstash_setex(key: str, value: str, ex_seconds: int) -> bool:
    url = f"{UPSTASH_REDIS_REST}/set/{key}/{value}"
    headers = {"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}"}
    params = {"ex": ex_seconds}  # TTL
    r = requests.post(url, headers=headers, params=params, timeout=8)
    if not r.ok:
        logger.warning("Upstash SETEX failed %s %s", r.status_code, r.text)
        return False
    return True

# -------- RSS fetch & scoring --------
def fetch_feeds(feeds):
    items = []
    for f in feeds:
        try:
            feed = feedparser.parse(f)
            source_title = getattr(feed, "feed", {}).get("title", "") or ""
            for e in getattr(feed, "entries", []):
                url = e.get("link") or e.get("id") or ""
                title = e.get("title", "")
                summary = e.get("summary", "") or e.get("description", "")
                published = e.get("published") or e.get("updated") or ""
                items.append({
                    "title": title,
                    "url": url,
                    "summary": summary,
                    "published": published,
                    "source": source_title,
                })
        except Exception:
            logger.exception("Failed to parse feed %s", f)
    return items

def score_article(item) -> int:
    txt = (item.get("title", "") + " " + item.get("summary", "")).lower()
    s = 0

    high = [
        "funding", "raises", "acquisition", "acqui", "outage", "breach",
        "open source", "partnership", "launch", "announced", "milestone"
    ]
    infra = ["h100", "h200", "mi300", "gpu", "accelerator", "nvidia", "amd", "intel"]

    for h in high:
        if h in txt:
            s += 3
    for g in infra:
        if g in txt:
            s += 2

    return s

def build_blocks(item, score: int):
    title = (item.get("title") or "")[:300]
    url = item.get("url") or ""
    summary = (item.get("summary") or "")[:700]
    source = item.get("source") or ""

    blocks = [
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*{title}*"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"{summary}\n\n<{url}|Read article>"}},
        {"type": "context", "elements": [{"type": "mrkdwn", "text": f"Source: {source} • Score: {score}"}]},
    ]
    return blocks

def post_to_slack(blocks, fallback_text: str):
    api = "https://slack.com/api/chat.postMessage"
    headers = {
        "Authorization": f"Bearer {SLACK_BOT_TOKEN}",
        "Content-Type": "application/json; charset=utf-8",
    }
    payload = {
        "channel": SLACK_CHANNEL_ID,
        "blocks": blocks,
        "text": fallback_text,
    }
    r = requests.post(api, headers=headers, json=payload, timeout=10)
    data = r.json() if r.ok else {}
    if not r.ok or not data.get("ok"):
        raise RuntimeError(f"Slack post failed: status={r.status_code}, body={r.text}")
    return data

# -------- Vercel handler --------
def handler(request):
    # Basic config check
    missing = [k for k in ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID", "UPSTASH_REDIS_REST", "UPSTASH_REDIS_TOKEN"]
               if not os.environ.get(k)]
    if missing:
        return (f"Missing env vars: {', '.join(missing)}", HTTPStatus.INTERNAL_SERVER_ERROR)

    now_utc = datetime.now(timezone.utc)
    now_london = now_utc.astimezone(ZoneInfo("Europe/London"))
    logger.info("Now London: %s", now_london.isoformat())

    # DST-safe: only post at 08:00 or 17:00 local time
    if now_london.hour not in TARGET_HOURS_LONDON:
        return ("OK - not a posting hour", HTTPStatus.OK)

    items = fetch_feeds(RSS_FEEDS)
    scored = []
    for it in items:
        if not it.get("url"):
            continue
        s = score_article(it)
        if s >= MIN_SCORE:
            it["score"] = s
            scored.append(it)

    scored.sort(key=lambda x: (-x["score"], x.get("published", "")))

    posted = 0
    for it in scored:
        key = sha1(it["url"])
        if upstash_get(key):
            continue

        blocks = build_blocks(it, it["score"])
        post_to_slack(blocks, f"{it.get('title')} - {it.get('url')}")

        # Dedupe for 7 days
        upstash_setex(key, "1", 7 * 86400)

        posted += 1
        if posted >= POST_MAX:
            break

    return (f"OK - posted {posted}", HTTPStatus.OK)
