// api/cron.js
import Parser from "rss-parser";

const parser = new Parser();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const UPSTASH_REDIS_REST = process.env.UPSTASH_REDIS_REST;
const UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_TOKEN;

const MIN_SCORE = Number(process.env.MIN_SCORE ?? "3");
// bump default so a weekly run can post more than 3 stories if needed
const POST_MAX = Number(process.env.POST_MAX_PER_RUN ?? "10");

// Updated sources: TechCrunch + The Tech Capital + DatacenterDynamics
const RSS_FEEDS = JSON.parse(
  process.env.RSS_FEEDS ??
    JSON.stringify([
      "https://techcrunch.com/feed/",
      "https://www.datacenterknowledge.com/rss.xml?utm_source=chatgpt.com",
      // DatacenterDynamics RSS (official)
      "https://www.datacenterdynamics.com/rss/"
    ])
);

// --- helpers ---

function sha1Hex(input) {
  // Minimal SHA-1 using WebCrypto (available in Node 18+ on Vercel)
  const enc = new TextEncoder();
  return crypto.subtle.digest("SHA-1", enc.encode(input)).then((buf) =>
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
    "breach",
    "open source",
    "partnership",
    "launch",
    "announced",
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
  const infra = ["h100", "h200", "mi300", "gpu", "accelerator", "nvidia", "amd", "intel", "groq", "google", "gb300", "gb200", "rubin", "alphabet", "softbank", "oracle", "aws", "meta"];

  for (const h of high) if (txt.includes(h)) s += 3;
  for (const g of infra) if (txt.includes(g)) s += 2;

  return s;
}

async function postToSlack({ title, url, summary, source, score }) {
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${title.slice(0, 300)}*` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${(summary ?? "").slice(0, 700)}\n\n<${url}|Read article>`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Source: ${source} • Score: ${score}`,
        },
      ],
    },
  ];

  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text: `${title} - ${url}`,
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
      // keep going if one feed fails
    }
  }

  // Score + filter
  const scored = items
    .map((it) => ({
      ...it,
      score: scoreArticle({ title: it.title, contentSnippet: it.summary }),
    }))
    .filter((it) => it.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  let posted = 0;

  // Post each new article as its own Slack message
  for (const it of scored) {
    const key = await sha1Hex(it.url);
    const seen = await upstashGet(key);
    if (seen) continue;

    await postToSlack({
      title: it.title,
      url: it.url,
      summary: it.summary,
      source: it.source,
      score: it.score,
    });

    // mark as seen for 7 days (weekly cadence)
    await upstashSetEx(key, "1", 7 * 86400);
    posted += 1;
    if (posted >= POST_MAX) break;
  }

  return res.status(200).send(`OK - posted ${posted}`);
}
