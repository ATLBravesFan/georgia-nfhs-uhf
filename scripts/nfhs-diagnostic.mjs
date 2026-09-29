import fs from "node:fs/promises";
import * as cheerio from "cheerio";

const DEFAULT_CATEGORY = "USA | NFHS Network";
const GHSA_PAGE = "https://get.nfhsnetwork.com/associations/ghsa/";
const TARGET_ID = "gamb8ad8195a3";

function cleanSpace(s = "") {
  return String(s)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(s = "") {
  return cleanSpace(s)
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\bhigh school\b/g, " ")
    .replace(/\bschool\b/g, " ")
    .replace(/\bacademy\b/g, " academy ")
    .replace(/\bjunior varsity\b/g, " jv ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 Georgia-NFHS-Diagnostic/4.0"
      }
    });

    const text = await r.text();

    if (!r.ok) {
      throw new Error(`${r.status} ${r.statusText}`);
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 20000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

async function getProvider() {
  const base = cleanSpace(
    process.env.XTREAM_BASE_URL || ""
  ).replace(/\/+$/, "");

  const username = process.env.XTREAM_USERNAME || "";
  const password = process.env.XTREAM_PASSWORD || "";

  if (!base || !username || !password) {
    throw new Error("Missing Xtream GitHub secrets.");
  }

  const auth =
    `username=${encodeURIComponent(username)}` +
    `&password=${encodeURIComponent(password)}`;

  const categories = await fetchJson(
    `${base}/player_api.php?${auth}&action=get_live_categories`
  );

  const wanted = cleanSpace(
    process.env.NFHS_CATEGORY_NAME || DEFAULT_CATEGORY
  ).toLowerCase();

  let category = categories.find(
    c => cleanSpace(c.category_name).toLowerCase() === wanted
  );

  if (!category) {
    category = categories.find(
      c => /nfhs/i.test(String(c.category_name || ""))
    );
  }

  if (!category) {
    throw new Error("NFHS category not found.");
  }

  let streams = await fetchJson(
    `${base}/player_api.php?${auth}` +
    `&action=get_live_streams` +
    `&category_id=${encodeURIComponent(category.category_id)}`
  );

  streams = streams.filter(
    s =>
      String(s.category_id) === String(category.category_id) ||
      !s.category_id
  );

  return {
    category,
    streams
  };
}

function providerNumber(name = "") {
  const m = String(name).match(
    /^NFHS\s+Network\s+(\d+)\s*:/i
  );

  return m ? Number(m[1]) : null;
}

function providerBody(name = "") {
  return cleanSpace(name)
    .replace(/^NFHS\s+Network\s+\d+\s*:\s*/i, "")
    .replace(
      /\s*@\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*ET\s*$/i,
      ""
    );
}

function importantTokens(text = "") {
  const ignored = new Set([
    "high",
    "school",
    "academy",
    "the",
    "and",
    "vs",
    "girls",
    "boys",
    "varsity",
    "junior",
    "jv",
    "freshman",
    "middle",
    "volleyball",
    "football",
    "basketball",
    "softball",
    "baseball",
    "soccer",
    "sep",
    "utc",
    "2026"
  ]);

  return normalize(text)
    .split(" ")
    .filter(
      x =>
        x.length >= 4 &&
        !ignored.has(x)
    );
}

function similarity(a, b) {
  const aa = new Set(importantTokens(a));
  const bb = new Set(importantTokens(b));

  if (!aa.size || !bb.size) return 0;

  let common = 0;

  for (const token of aa) {
    if (bb.has(token)) common++;
  }

  return common / Math.max(
    Math.min(aa.size, bb.size),
    1
  );
}

async function getGhsaEvents() {
  const html = await fetchText(GHSA_PAGE);
  const $ = cheerio.load(html);

  const events = [];
  const seen = new Set();

  $("a").each((_, el) => {
    const text = cleanSpace($(el).text());

    let href =
      cleanSpace($(el).attr("href") || "");

    if (!href) return;

    if (href.startsWith("/")) {
      href =
        `https://www.nfhsnetwork.com${href}`;
    }

    const m = href.match(
      /\/events\/[^/]+\/([a-z0-9]+)(?:[/?#]|$)/i
    );

    if (!m) return;

    const eventId = m[1];

    if (seen.has(eventId)) return;

    seen.add(eventId);

    events.push({
      page_index: events.length + 1,
      event_id: eventId,
      text,
      href
    });
  });

  return events;
}

function findBestProviderMatch(event, streams) {
  let best = null;

  for (const stream of streams) {
    const name =
      cleanSpace(stream.name || "");

    if (!name) continue;

    const score = similarity(
      event.text,
      providerBody(name)
    );

    if (
      !best ||
      score > best.score
    ) {
      best = {
        score,
        stream_id: stream.stream_id,
        provider_nfhs_number:
          providerNumber(name),
        provider_name: name,
        provider_added:
          stream.added ?? null
      };
    }
  }

  if (!best || best.score < 0.66) {
    return null;
  }

  return best;
}

async function main() {
  const provider =
    await getProvider();

  const events =
    await getGhsaEvents();

  const rows = events.map(event => {
    const match =
      findBestProviderMatch(
        event,
        provider.streams
      );

    return {
      page_index:
        event.page_index,

      event_id:
        event.event_id,

      is_target:
        event.event_id === TARGET_ID,

      nfhs_text:
        event.text,

      provider_match_score:
        match?.score ?? null,

      provider_nfhs_number:
        match?.provider_nfhs_number ?? null,

      provider_stream_id:
        match?.stream_id ?? null,

      provider_name:
        match?.provider_name ?? null,

      provider_added:
        match?.provider_added ?? null
    };
  });

  const matched =
    rows.filter(
      x =>
        x.provider_nfhs_number !== null
    );

  const target =
    rows.find(
      x => x.is_target
    ) || null;

  let targetNeighborhood = [];

  if (target) {
    targetNeighborhood =
      rows.filter(
        x =>
          Math.abs(
            x.page_index -
            target.page_index
          ) <= 5
      );
  }

  const payload = {
    generated_at:
      new Date().toISOString(),

    diagnostic_only:
      true,

    modifies_epg:
      false,

    diagnostic_version:
      4,

    purpose:
      "Compare NFHS GHSA page ordering against provider NFHS channel ordering.",

    provider: {
      category:
        provider.category?.category_name ||
        DEFAULT_CATEGORY,

      source_stream_count:
        provider.streams.length
    },

    ghsa_event_count:
      events.length,

    provider_match_count:
      matched.length,

    target,

    target_neighborhood:
      targetNeighborhood,

    matched_events:
      matched,

    all_events:
      rows
  };

  await fs.mkdir(
    "public",
    { recursive: true }
  );

  await fs.writeFile(
    "public/nfhs-diagnostic.json",
    JSON.stringify(
      payload,
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(
    `Diagnostic v4 matched ` +
    `${matched.length} of ` +
    `${events.length} NFHS events.`
  );

  console.log(
    "public/events.json was NOT modified."
  );
}

main().catch(err => {
  console.error(
    err?.stack ||
    err?.message ||
    String(err)
  );

  process.exit(1);
});
