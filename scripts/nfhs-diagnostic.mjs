import fs from "node:fs/promises";
import * as cheerio from "cheerio";

const DEFAULT_CATEGORY = "USA | NFHS Network";

const GLOBAL_PAGES = [
  "https://get.nfhsnetwork.com/watch-events",
  "https://www.nfhsnetwork.com/watch-events"
];

const EVENTS = [
  {
    role: "target",
    label: "Clinch County vs. Brantley County",
    event_id: "gamb8ad8195a3",
    provider_nfhs_number: null,
    provider_stream_id: null
  },
  {
    role: "control",
    label: "Long County vs. St. Vincent's Academy",
    event_id: "gam302604b4e5",
    provider_nfhs_number: 3455,
    provider_stream_id: 2066857
  },
  {
    role: "control",
    label: "Camden County vs. Savannah Country Day",
    event_id: "gamd493cc6a81",
    provider_nfhs_number: 3572,
    provider_stream_id: 2066737
  },
  {
    role: "control",
    label: "Frederica Academy vs. Bradwell Institute",
    event_id: "gamee5d943f7a",
    provider_nfhs_number: 3596,
    provider_stream_id: 2066711
  }
];

function cleanSpace(s = "") {
  return String(s)
    .replace(/\u00a0/g, " ")
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
        "User-Agent": "Mozilla/5.0 Georgia-NFHS-Diagnostic/5.0"
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

async function extractGlobalPage(url) {
  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    const events = [];
    const seen = new Set();

    $("a").each((_, el) => {
      let href = cleanSpace($(el).attr("href") || "");
      const text = cleanSpace($(el).text());

      if (!href) return;

      if (href.startsWith("/")) {
        href = `https://www.nfhsnetwork.com${href}`;
      }

      const m = href.match(
        /\/events\/[^/]+\/([a-z0-9]+)(?:[/?#]|$)/i
      );

      if (!m) return;

      const eventId = m[1];

      if (seen.has(eventId)) return;
      seen.add(eventId);

      events.push({
        index: events.length + 1,
        event_id: eventId,
        text,
        href
      });
    });

    return {
      ok: true,
      url,
      event_count: events.length,
      events
    };

  } catch (err) {
    return {
      ok: false,
      url,
      event_count: 0,
      events: [],
      error: String(err?.message || err)
    };
  }
}

function findProviderStream(provider, streamId) {
  if (!streamId) return null;

  const s = provider.streams.find(
    x => Number(x.stream_id) === Number(streamId)
  );

  if (!s) return null;

  return {
    stream_id: s.stream_id,
    provider_nfhs_number: providerNumber(s.name || ""),
    provider_name: cleanSpace(s.name || ""),
    provider_added: s.added ?? null
  };
}

function comparePage(page, provider) {
  return EVENTS.map(event => {
    const pageEvent = page.events.find(
      x => x.event_id === event.event_id
    );

    const providerStream =
      findProviderStream(
        provider,
        event.provider_stream_id
      );

    return {
      role: event.role,
      label: event.label,
      event_id: event.event_id,

      global_page_found: Boolean(pageEvent),

      global_page_index:
        pageEvent?.index ?? null,

      global_page_text:
        pageEvent?.text ?? null,

      provider_nfhs_number:
        providerStream?.provider_nfhs_number ??
        event.provider_nfhs_number,

      provider_stream_id:
        providerStream?.stream_id ??
        event.provider_stream_id,

      provider_name:
        providerStream?.provider_name ?? null,

      provider_added:
        providerStream?.provider_added ?? null
    };
  });
}

async function main() {
  const provider = await getProvider();

  const pages = [];

  for (const url of GLOBAL_PAGES) {
    pages.push(
      await extractGlobalPage(url)
    );
  }

  const comparisons = pages.map(page => ({
    page_url: page.url,
    page_ok: page.ok,
    event_count: page.event_count,
    rows: comparePage(page, provider)
  }));

  const targetNeighborhoods = [];

  for (const page of pages) {
    const target = page.events.find(
      x => x.event_id === "gamb8ad8195a3"
    );

    if (!target) {
      targetNeighborhoods.push({
        page_url: page.url,
        target_found: false,
        rows: []
      });

      continue;
    }

    targetNeighborhoods.push({
      page_url: page.url,
      target_found: true,
      target_index: target.index,

      rows: page.events.filter(
        x => Math.abs(x.index - target.index) <= 10
      )
    });
  }

  const payload = {
    generated_at: new Date().toISOString(),

    diagnostic_only: true,

    modifies_epg: false,

    diagnostic_version: 5,

    purpose:
      "Test whether provider NFHS numbering follows NFHS nationwide Watch Events ordering.",

    provider: {
      category:
        provider.category?.category_name ||
        DEFAULT_CATEGORY,

      source_stream_count:
        provider.streams.length
    },

    pages: pages.map(page => ({
      url: page.url,
      ok: page.ok,
      event_count: page.event_count,
      error: page.error ?? null
    })),

    comparisons,

    target_neighborhoods
  };

  await fs.mkdir(
    "public",
    { recursive: true }
  );

  await fs.writeFile(
    "public/nfhs-diagnostic.json",
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );

  console.log("Diagnostic v5 complete.");
  console.log("public/events.json was NOT modified.");
}

main().catch(err => {
  console.error(
    err?.stack ||
    err?.message ||
    String(err)
  );

  process.exit(1);
});
