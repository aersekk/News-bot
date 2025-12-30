// api/cron.js
import Parser from "rss-parser";

const parser = new Parser();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const UPSTASH_REDIS_REST = process.env.UPSTASH_REDIS_REST;
const UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_TOKEN;

const MIN_SCORE = Number(process.env.MIN_SCORE ?? "3");
const POST_MAX = Number(process.env.POST_MAX_PER_RUN ?? "10"); // bump a bit for a weekly digest

const RSS_FEEDS = JSON.parse(
  process.env.RSS_FEEDS ??
    '["https://techcrunch.com/feed/","https://www.crn.com/news/data-center/rss.xml"]'
);

// ---- Helpers ----

function sha1Hex(input) {
  // Minimal SHA-1 using WebCrypto (available in Node 18+ on Vercel)
  const enc = new TextEncoder();
  return crypto.subtle
    .digest("SHA-1", enc.encode(input))
    .then((buf) =>
      Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
}

async function upstashGet(key) {
  const r = await fetch(`${UPSTASH_REDIS_REST}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_TOKEN}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.result;
}

async function upstashSetEx(key, value, exSeconds) {
  const url = new URL(`${UPSTASH_REDIS_REST}/set/${key}/${value}`);
  url.searchParams.set("ex", String(exSeconds));
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_TOKEN}` },
  });
  return r.ok;
}

function scoreArticle({ title = "", contentSnippet = "" }) {
  const txt = `${title} ${contentSnippet}`.toLowerCase();
  let s = 0;

  const high = [
    "funding",
    "raises",
    "acquisition",
    "acqui",
    "outage",
    "breach",
    "open source",
    "partnership",
    "launch",
    "announced",
    "milestone",
    "data center",
    "datacentre",
    "colocation",
    "colo",
    "hyperscale",
    "megawatt",
    "grid",
    "cooling",
    "liquid cooling",
  ];
  const infra = ["h100", "h200", "mi300", "gpu", "accelerator", "nvidia", "amd", "intel"];

  for (const h of high) if (txt.includes(h)) s += 3;
  for (const g of infra) if (txt.includes(g)) s += 2;

  return s;
}

// Turn a summary string into up to 2 bullet lines
function makeSummaryBullets(summary, maxBullets = 2) {
  if (!summary) return [];

  const cleaned = summary.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  // Naive sentence split
  const sentences = cleaned
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length >= maxBullets) {
    return sentences.slice(0, maxBullets);
  }

  // If only one long sentence, split roughly in half
  if (sentences.length === 1 && cleaned.length > 180) {
    const mid = Math.floor(cleaned.length / 2);
    const splitIdx = cleaned.indexOf(" ", mid);
    if (splitIdx > -1) {
      return [
        cleaned.slice(0, splitIdx).trim(),
        cleaned.slice(splitIdx).trim(),
      ];
    }
  }

  return sentences;
}

// Post *one* digest message for all articles
async function postDigestToSlack(items) {
  if (!items.length) return;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const headerText = `*Weekly Infra & AI News Digest – ${today}*`;

  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: headerText },
    },
    { type: "divider" },
  ];

  for (const it of items) {
    const bullets = makeSummaryBullets(it.summary, 2);

    // Bullet header + sub-bullets
    const lines = [
      `• *${it.title.slice(0, 300)}*`,
      ...bullets.map((b) => `   • ${b}`),
      `   • <${it.url}|Read article> • Source: ${it.source} • Score: ${it.score}`,
    ].join("\n");

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: lines,
      },
    });

    blocks.push({ type: "divider" });
  }

  // Fallback text for notifications / when blocks aren't rendered
  const fallbackText = items
    .map((it) => `• ${it.title} - ${it.url}`)
    .join("\n");

  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text: fallbackText,
      blocks,
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    throw new Error(`Slack post failed: ${r.status} ${JSON.stringify(data)}`);
  }
}

export default async function handler(req, res) {
  // Basic env check
  const missing = [];
  for (const k of [
    "SLACK_BOT_TOKEN",
    "SLACK_CHANNEL_ID",
    "UPSTASH_REDIS_REST",
    "UPSTASH_REDIS_TOKEN",
  ]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) {
    return res.status(500).send(`Missing env vars: ${missing.join(", ")}`);
  }

  // Fetch RSS items
  let items = [];
  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      const source = feed.title ?? feedUrl;
      for (const it of feed.items ?? []) {
        const link = it.link ?? it.guid ?? "";
        if (!link) continue;
        items.push({
          title: it.title ?? "",
          url: link,
          summary: it.contentSnippet ?? it.content ?? "",
          source,
          published: it.isoDate ?? it.pubDate ?? "",
        });
      }
    } catch (e) {
      // ignore a failing feed and continue
    }
  }

  // Score, filter, and sort
  const scored = items
    .map((it) => ({
      ...it,
      score: scoreArticle({ title: it.title, contentSnippet: it.summary }),
    }))
    .filter((it) => it.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  // Collect new, unseen items up to POST_MAX
  const fresh = [];
  for (const it of scored) {
    const key = await sha1Hex(it.url);
    const seen = await upstashGet(key);
    if (seen) continue;

    fresh.push({ ...it, _redisKey: key });
    if (fresh.length >= POST_MAX) break;
  }

  if (!fresh.length) {
    return res.status(200).send("OK - no new items");
  }

  // Post single digest
  await postDigestToSlack(fresh);

  // Mark all as seen for 7 days
  await Promise.all(
    fresh.map((it) => upstashSetEx(it._redisKey, "1", 7 * 86400))
  );

  return res.status(200).send(`OK - posted digest with ${fresh.length} items`);
}
