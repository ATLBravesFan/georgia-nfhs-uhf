import fs from "node:fs/promises";
import crypto from "node:crypto";
import { DateTime } from "luxon";

const EASTERN = "America/New_York";
const DEFAULT_CATEGORY = "USA | NFHS Network";
const SEARCH_BASE = "https://search-api.nfhsnetwork.com";
const UNITY_BASE = "https://cfunity.nfhsnetwork.com";
const SAMPLE_COUNT = 36;
const SEARCH_SIZE = 25;
const CONTROL_NUMBERS = [3343, 3455, 3552, 3572, 3596];

function cleanSpace(s = "") {
  return String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalize(s = "") {
  return cleanSpace(s)
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/\bsaint\b/g, "st")
    .replace(/\bmount\b/g, "mt")
    .replace(/\bhigh school\b/g, " ")
    .replace(/\bmiddle school\b/g, " ")
    .replace(/\belementary school\b/g, " ")
    .replace(/\bschool\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function providerNumber(name = "") {
  const m = String(name).match(/^NFHS\s+Network\s+(\d+)\s*:/i);
  return m ? Number(m[1]) : null;
}

function providerCore(name = "") {
  return cleanSpace(
    String(name)
      .replace(/^NFHS\s+Network\s+\d+\s*:\s*/i, "")
      .replace(/\s+@\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*ET\s*$/i, "")
  );
}


function buildSearchTerms(core = "") {
  const scrub = cleanSpace(
    core
      .replace(/\b(?:Junior Varsity|Varsity|Freshman|Middle School|JV|MS)\b/gi, " ")
      .replace(/\b(?:Girls|Boys|Coed)\b/gi, " ")
      .replace(/\b(?:Flag Football|Football|Volleyball|Basketball|Baseball|Softball|Soccer|Wrestling|Lacrosse|Field Hockey|Ice Hockey|Hockey|Tennis|Swimming|Track(?: and Field)?|Cross Country|Golf|Badminton|Cheerleading|Assembly|Sports Show|News)\b/gi, " ")
      .replace(/\bHigh School\b/gi, " ")
      .replace(/\bMiddle School\b/gi, " ")
      .replace(/\bSchool\b/gi, " ")
      .replace(/\s+/g, " ")
  );

  const sides = scrub.split(/\s+vs\.?\s+|\s+versus\s+/i).map(cleanSpace).filter(Boolean);
  const out = [];

  const add = value => {
    const q = cleanSpace(value).split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
    if (q && !out.includes(q)) out.push(q);
  };

  if (sides.length >= 2) {
    add(sides[0]);
    add(sides[1]);
    add([
      ...sides[0].split(/\s+/).filter(Boolean).slice(0, 2),
      ...sides[1].split(/\s+/).filter(Boolean).slice(0, 2)
    ].join(" "));
  } else {
    add(scrub);
  }

  return out.slice(0, 3);
}

function parseProviderStart(name, now = DateTime.now().setZone(EASTERN)) {
  const m = String(name).match(/@\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET\s*$/i);
  if (!m) return null;

  const [, dayS, monS, hourS, minS, ampm] = m;
  const month = DateTime.fromFormat(monS, "LLL", { zone: EASTERN }).month;
  if (!month) return null;

  let hour = Number(hourS) % 12;
  if (ampm.toUpperCase() === "PM") hour += 12;

  let dt = DateTime.fromObject(
    { year: now.year, month, day: Number(dayS), hour, minute: Number(minS), second: 0 },
    { zone: EASTERN }
  );

  if (!dt.isValid) return null;
  if (dt.diff(now, "days").days > 180) dt = dt.minus({ years: 1 });
  if (dt.diff(now, "days").days < -180) dt = dt.plus({ years: 1 });

  return dt;
}

function tokenSet(s = "") {
  return new Set(
    normalize(s)
      .split(" ")
      .filter(w => w.length >= 3)
      .filter(w => !["varsity","junior","freshman","girls","boys","coed","football","volleyball","basketball","softball","baseball","soccer","wrestling","field","hockey","flag","sports","show","episode"].includes(w))
  );
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);

  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.97;

  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;

  const overlap = [...A].filter(x => B.has(x)).length;
  const coverage = overlap / Math.min(A.size, B.size);
  const jaccard = overlap / new Set([...A, ...B]).size;

  return Number((0.7 * coverage + 0.3 * jaccard).toFixed(4));
}

function sha20(value) {
  if (value === null || value === undefined || value === "") return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 Georgia-NFHS-Deep-Link-Diagnostic/1.0" }
    });

    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${text.slice(0, 180)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 20000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

async function getProvider() {
  const base = cleanSpace(process.env.XTREAM_BASE_URL || "").replace(/\/+$/, "");
  const username = process.env.XTREAM_USERNAME || "";
  const password = process.env.XTREAM_PASSWORD || "";

  if (!base || !username || !password) {
    throw new Error("Missing XTREAM_BASE_URL, XTREAM_USERNAME, or XTREAM_PASSWORD.");
  }

  const auth = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  const categories = await fetchJson(
    `${base}/player_api.php?${auth}&action=get_live_categories`
  );

  const wanted = cleanSpace(process.env.NFHS_CATEGORY_NAME || DEFAULT_CATEGORY).toLowerCase();

  let category = categories.find(
    c => cleanSpace(c.category_name).toLowerCase() === wanted
  );

  if (!category) category = categories.find(c => /nfhs/i.test(String(c.category_name || "")));
  if (!category) throw new Error("Could not find NFHS category.");

  let streams = await fetchJson(
    `${base}/player_api.php?${auth}&action=get_live_streams&category_id=${encodeURIComponent(category.category_id)}`
  );

  if (!Array.isArray(streams)) throw new Error("Provider stream response was not an array.");

  streams = streams
    .filter(s => providerNumber(s.name || "") !== null)
    .map(s => {
      const start = parseProviderStart(s.name || "");
      return {
        provider_nfhs_number: providerNumber(s.name || ""),
        stream_id: Number(s.stream_id),
        title: cleanSpace(s.name || ""),
        core: providerCore(s.name || ""),
        provider_start: start?.toISO() || null,
        provider_day: start?.toISODate() || null,
        added: Number(s.added || 0) || null
      };
    })
    .sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number);

  return { category, streams };
}

function chooseSamples(streams) {
  const dated = streams.filter(x => x.provider_day);
  const days = [...new Set(dated.map(x => x.provider_day))].sort();
  const latestDay = days.at(-1) || null;
  const pool = latestDay ? dated.filter(x => x.provider_day === latestDay) : dated;

  const chosen = new Map();

  for (const n of CONTROL_NUMBERS) {
    const s = streams.find(x => x.provider_nfhs_number === n);
    if (s) chosen.set(s.provider_nfhs_number, s);
  }

  if (pool.length) {
    const count = Math.min(SAMPLE_COUNT, pool.length);

    for (let i = 0; i < count; i++) {
      const idx = count === 1 ? 0 : Math.round(i * (pool.length - 1) / (count - 1));
      const s = pool[idx];
      if (s) chosen.set(s.provider_nfhs_number, s);
    }
  }

  return {
    latest_provider_day: latestDay,
    pool_count: pool.length,
    samples: [...chosen.values()].sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number)
  };
}

function flattenSearchItems(items) {
  const out = [];

  for (const event of items || []) {
    const pubs = Array.isArray(event.publishers) ? event.publishers : [];

    if (!pubs.length) {
      out.push({
        event_key: event.key || null,
        event_title: event.title || null,
        sport: event.sport || null,
        event_start: event.start_time || null,
        publisher_name: null,
        publisher_slug: null,
        association: null,
        broadcast_key: null,
        broadcast_game_key: null,
        broadcast_start: null,
        broadcast_status: null,
        broadcast_is_live: null,
        broadcast_subheadline: null,
        view_url: null
      });
      continue;
    }

    for (const pub of pubs) {
      const broadcasts = Array.isArray(pub.broadcasts) ? pub.broadcasts : [];

      if (!broadcasts.length) {
        out.push({
          event_key: event.key || null,
          event_title: event.title || null,
          sport: event.sport || null,
          event_start: event.start_time || null,
          publisher_name: pub.headline_short_name || pub.formatted_name || null,
          publisher_slug: pub.slug || null,
          association: pub.state_association_acronym || null,
          broadcast_key: null,
          broadcast_game_key: null,
          broadcast_start: null,
          broadcast_status: null,
          broadcast_is_live: null,
          broadcast_subheadline: null,
          view_url: null
        });
        continue;
      }

      for (const b of broadcasts) {
        out.push({
          event_key: event.key || null,
          event_title: event.title || null,
          sport: event.sport || null,
          event_start: event.start_time || null,
          publisher_name: pub.headline_short_name || pub.formatted_name || null,
          publisher_slug: pub.slug || null,
          association: pub.state_association_acronym || null,
          broadcast_key: b.key || null,
          broadcast_game_key: b.game_key || null,
          broadcast_start: b.start_time || null,
          broadcast_status: b.status || null,
          broadcast_is_live: b.is_live ?? null,
          broadcast_subheadline: b.subheadline || null,
          view_url: b.view_url || null
        });
      }
    }
  }

  return out;
}

function safeTimeDiffMinutes(a, b) {
  if (!a || !b) return null;
  const aa = DateTime.fromISO(a, { setZone: true });
  const bb = DateTime.fromISO(b, { setZone: true });
  if (!aa.isValid || !bb.isValid) return null;
  return Math.abs(aa.diff(bb, "minutes").minutes);
}

function bestCandidate(provider, candidates) {
  let best = null;

  for (const c of candidates) {
    const textOptions = [
      c.broadcast_subheadline,
      c.event_title,
      [c.publisher_name, c.event_title].filter(Boolean).join(" ")
    ].filter(Boolean);

    const textScore = Math.max(0, ...textOptions.map(t => similarity(provider.core, t)));
    const start = c.broadcast_start || c.event_start;
    const diff = safeTimeDiffMinutes(provider.provider_start, start);

    let score = textScore;
    if (diff !== null && diff <= 2) score += 0.35;
    else if (diff !== null && diff <= 10) score += 0.25;
    else if (diff !== null && diff <= 30) score += 0.12;

    const candidate = {
      ...c,
      text_score: Number(textScore.toFixed(4)),
      minutes_apart: diff === null ? null : Number(diff.toFixed(2)),
      combined_score: Number(score.toFixed(4))
    };

    if (
      !best ||
      candidate.combined_score > best.combined_score ||
      (
        candidate.combined_score === best.combined_score &&
        (candidate.minutes_apart ?? 999999) < (best.minutes_apart ?? 999999)
      )
    ) {
      best = candidate;
    }
  }

  return best;
}

async function enrichUnity(match) {
  if (!match?.event_key) return null;

  try {
    const data = await fetchJson(
      `${UNITY_BASE}/v2/game_or_event/${encodeURIComponent(match.event_key)}`
    );

    const pubs = Array.isArray(data?.publishers) ? data.publishers : [];
    const allBroadcasts = pubs.flatMap(p =>
      (Array.isArray(p?.broadcasts) ? p.broadcasts : []).map(b => ({ p, b }))
    );

    let pair = null;

    if (match.broadcast_key) {
      pair = allBroadcasts.find(x => String(x.b?.key || "") === String(match.broadcast_key));
    }

    if (!pair) pair = allBroadcasts[0] || null;

    const p = pair?.p || pubs[0] || null;
    const b = pair?.b || null;

    return {
      event_key: data?.key || match.event_key,
      local_start_time: data?.local_start_time || null,
      state_name: data?.state_name || null,
      city: data?.city || null,
      publisher_key: p?.key || p?.publisher_key || null,
      publisher_name: p?.formatted_name || p?.name || null,
      broadcast_key: b?.key || null,
      game_key: b?.game_key || null,
      status: b?.status || null,
      pixellot_event_id: b?.pixellot_event_id || null,
      pixellot_id: b?.pixellot_id || null,
      pixellot_key: b?.pixellot_key || null,
      producer_key: b?.producer_key || null,
      ingest_point_fingerprint: sha20(b?.ingest_point),
      raw_playback_url_recorded: false
    };
  } catch (err) {
    return {
      error: String(err?.message || err).slice(0, 300)
    };
  }
}


async function probeOfficialFeed(knownRows) {
  const sizes = [5000, 2000, 1000, 500, 250, 100];
  let data = null;
  let usedSize = null;
  let error = null;

  for (const size of sizes) {
    try {
      data = await fetchJson(`${SEARCH_BASE}/v3/search/events?size=${size}`);
      usedSize = size;
      break;
    } catch (err) {
      error = String(err?.message || err).slice(0, 300);
    }
  }

  if (!data) {
    return { ok: false, error };
  }

  const items = Array.isArray(data.items) ? data.items : [];
  const topLevelMetadata = {};

  for (const [k, v] of Object.entries(data)) {
    if (k === "items") continue;
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
      topLevelMetadata[k] = v;
    } else if (Array.isArray(v)) {
      topLevelMetadata[k] = { type: "array", length: v.length };
    } else if (typeof v === "object") {
      topLevelMetadata[k] = v;
    }
  }

  const flattened = flattenSearchItems(items);
  const eventOrder = [];
  const seen = new Set();

  for (const row of flattened) {
    const key = row.event_key || row.broadcast_game_key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    eventOrder.push({
      event_key: key,
      start_time: row.broadcast_start || row.event_start || null,
      publisher_slug: row.publisher_slug || null,
      subheadline: row.broadcast_subheadline || null
    });
  }

  const known = knownRows
    .filter(x => x?.unity?.event_key)
    .map(x => {
      const eventKey = x.unity.event_key;
      const pos = eventOrder.findIndex(e => e.event_key === eventKey);
      return {
        provider_nfhs_number: x.provider.provider_nfhs_number,
        event_key: eventKey,
        official_start: x.best_match?.broadcast_start || x.best_match?.event_start || null,
        feed_position_zero_based: pos >= 0 ? pos : null
      };
    });

  const found = known.filter(x => x.feed_position_zero_based !== null);

  let providerVsFeedOrderAgreement = null;
  if (found.length >= 2) {
    const byProvider = [...found].sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number);
    let ok = 0;
    let total = 0;
    for (let i = 1; i < byProvider.length; i++) {
      total++;
      if (byProvider[i].feed_position_zero_based > byProvider[i - 1].feed_position_zero_based) ok++;
    }
    providerVsFeedOrderAgreement = {
      agreeing_adjacent_pairs: ok,
      total_adjacent_pairs: total,
      percent: total ? Number((ok / total * 100).toFixed(2)) : null
    };
  }

  return {
    ok: true,
    requested_size_used: usedSize,
    item_count: items.length,
    unique_event_count: eventOrder.length,
    top_level_metadata: topLevelMetadata,
    first_events: eventOrder.slice(0, 12),
    last_events: eventOrder.slice(-12),
    known_matches_found_in_feed: found.length,
    known_matches_total: known.length,
    provider_vs_feed_order_agreement: providerVsFeedOrderAgreement,
    known_positions: known
  };
}


function pickSafeFields(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const keep = [
    "key","game_key","event_key","broadcast_key","start_time","local_start_time",
    "status","headline","subheadline","pixellot_event_id","pixellot_id",
    "producer_key","publisher_key","sport","state_name","city"
  ];
  const out = {};
  for (const k of keep) {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  }
  return out;
}

function collectKnownIds(strongRows) {
  const map = new Map();
  for (const x of strongRows) {
    const n = x?.provider?.provider_nfhs_number;
    if (!Number.isFinite(n)) continue;

    const vals = [
      ["event_key", x?.unity?.event_key],
      ["broadcast_key", x?.unity?.broadcast_key],
      ["game_key", x?.unity?.game_key],
      ["pixellot_event_id", x?.unity?.pixellot_event_id]
    ];

    for (const [kind, value] of vals) {
      if (value) map.set(String(value), { kind, provider_nfhs_number: n });
    }
  }
  return map;
}

function inspectJsonForKnownIds(data, knownMap) {
  const hits = [];
  const arraySummaries = [];
  const seenArrays = new Set();
  let nodes = 0;
  const MAX_NODES = 200000;

  function walk(value, path, depth) {
    if (nodes++ > MAX_NODES || depth > 10) return;

    if (typeof value === "string") {
      const hit = knownMap.get(value);
      if (hit) hits.push({ path, value, ...hit });
      return;
    }

    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      if (!seenArrays.has(value)) {
        seenArrays.add(value);
        arraySummaries.push({
          path,
          length: value.length,
          first_safe: value.length ? pickSafeFields(value[0]) : null,
          last_safe: value.length ? pickSafeFields(value[value.length - 1]) : null
        });
      }
      for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`, depth + 1);
      return;
    }

    for (const [k, v] of Object.entries(value)) {
      walk(v, path ? `${path}.${k}` : k, depth + 1);
    }
  }

  walk(data, "$", 0);

  const providerOrder = hits
    .map(h => {
      const m = h.path.match(/\[(\d+)\]/);
      return m ? { ...h, first_array_index: Number(m[1]) } : { ...h, first_array_index: null };
    })
    .filter(h => h.first_array_index !== null)
    .sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number);

  let agreement = null;
  if (providerOrder.length >= 2) {
    let ok = 0;
    let total = 0;
    for (let i = 1; i < providerOrder.length; i++) {
      if (providerOrder[i].provider_nfhs_number === providerOrder[i - 1].provider_nfhs_number) continue;
      total++;
      if (providerOrder[i].first_array_index > providerOrder[i - 1].first_array_index) ok++;
    }
    agreement = {
      agreeing_adjacent_provider_pairs: ok,
      total_adjacent_provider_pairs: total,
      percent: total ? Number((ok / total * 100).toFixed(2)) : null
    };
  }

  return {
    known_id_hits: hits.length,
    hits: hits.slice(0, 250),
    array_summaries: arraySummaries.slice(0, 50),
    provider_order_vs_first_array_index: agreement
  };
}

async function probeUnityFleetFeeds(strongRows) {
  const knownMap = collectKnownIds(strongRows);
  const endpoints = [
    "/v2/upcoming",
    "/v2/upcoming_by_quality",
    "/v2/current_by_quality"
  ];
  const results = [];

  for (const path of endpoints) {
    try {
      const data = await fetchJson(`${UNITY_BASE}${path}`, 30000);
      const inspected = inspectJsonForKnownIds(data, knownMap);
      results.push({
        endpoint: path,
        ok: true,
        top_level_type: Array.isArray(data) ? "array" : typeof data,
        top_level_length: Array.isArray(data) ? data.length : null,
        top_level_keys: data && typeof data === "object" && !Array.isArray(data)
          ? Object.keys(data).slice(0, 50)
          : null,
        ...inspected
      });
    } catch (err) {
      results.push({
        endpoint: path,
        ok: false,
        error: String(err?.message || err).slice(0, 400)
      });
    }
  }

  return results;
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function probeSearchApiControls() {
  const queries = [
    { name: "default", qs: "size=5" },
    { name: "sort_start_asc", qs: "size=5&sort=start_time%3Aasc" },
    { name: "sort_start_asc_key_asc", qs: "size=5&sort=start_time%3Aasc%7Ckey.keyword%3Aasc" },
    { name: "start_100000", qs: "size=5&start=100000" },
    { name: "start_500000", qs: "size=5&start=500000" }
  ];

  const out = [];

  for (const q of queries) {
    try {
      const data = await fetchJson(`${SEARCH_BASE}/v3/search/events?${q.qs}`, 30000);
      const items = Array.isArray(data?.items) ? data.items : [];
      out.push({
        name: q.name,
        ok: true,
        start: data?.start ?? null,
        size: data?.size ?? null,
        total: data?.total ?? null,
        cursor_decoded: decodeCursor(data?.cursor),
        first: items.length ? {
          key: items[0]?.key || null,
          start_time: items[0]?.start_time || null
        } : null,
        last: items.length ? {
          key: items[items.length - 1]?.key || null,
          start_time: items[items.length - 1]?.start_time || null
        } : null
      });
    } catch (err) {
      out.push({
        name: q.name,
        ok: false,
        error: String(err?.message || err).slice(0, 400)
      });
    }
  }

  return out;
}


function encodeSearchCursor(startIso, key = "") {
  const dt = DateTime.fromISO(startIso, { setZone: true });
  if (!dt.isValid) return null;
  const payload = {
    version: 1,
    sort: "start_time:desc|key.keyword:asc",
    values: [dt.toMillis(), key]
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

async function probeTargetDateCursor(strongRows) {
  const targetIso = "2026-09-29T21:05:00.000Z";
  const cursor = encodeSearchCursor(targetIso, "");
  const known = strongRows
    .filter(x => x?.unity?.event_key)
    .map(x => ({
      provider_nfhs_number: x.provider.provider_nfhs_number,
      stream_id: x.provider.stream_id,
      event_key: x.unity.event_key,
      official_start: x.best_match?.broadcast_start || x.best_match?.event_start || null
    }))
    .sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number);

  try {
    const data = await fetchJson(
      `${SEARCH_BASE}/v3/search/events?size=500&cursor=${encodeURIComponent(cursor)}`,
      30000
    );

    const items = Array.isArray(data?.items) ? data.items : [];
    const eventOrder = items.map((event, index) => ({
      index,
      event_key: event?.key || null,
      start_time: event?.start_time || null,
      sport: event?.sport || null,
      publisher_slugs: Array.isArray(event?.publishers)
        ? event.publishers.map(p => p?.slug).filter(Boolean).slice(0, 3)
        : []
    }));

    const pos = new Map(eventOrder.filter(x => x.event_key).map(x => [x.event_key, x.index]));
    const found = known
      .map(x => ({ ...x, feed_index: pos.has(x.event_key) ? pos.get(x.event_key) : null }))
      .filter(x => x.feed_index !== null);

    const offsets = found.map(x => x.provider_nfhs_number - x.feed_index);
    const offsetCounts = {};
    for (const off of offsets) offsetCounts[off] = (offsetCounts[off] || 0) + 1;

    let bestOffset = null;
    let bestCount = 0;
    for (const [off, count] of Object.entries(offsetCounts)) {
      if (count > bestCount) {
        bestOffset = Number(off);
        bestCount = count;
      }
    }

    let adjacentGapAgreement = null;
    if (found.length >= 2) {
      const byProvider = [...found].sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number);
      let sameGap = 0;
      let total = 0;
      const pairs = [];

      for (let i = 1; i < byProvider.length; i++) {
        const a = byProvider[i - 1];
        const b = byProvider[i];
        const providerGap = b.provider_nfhs_number - a.provider_nfhs_number;
        const feedGap = b.feed_index - a.feed_index;
        total++;
        if (providerGap === feedGap) sameGap++;
        pairs.push({
          from_event: a.event_key,
          to_event: b.event_key,
          provider_gap: providerGap,
          feed_gap: feedGap,
          gap_difference: providerGap - feedGap
        });
      }

      adjacentGapAgreement = {
        exact_gap_matches: sameGap,
        total_pairs: total,
        percent: total ? Number((sameGap / total * 100).toFixed(2)) : null,
        pairs
      };
    }

    return {
      ok: true,
      target_cursor_start: targetIso,
      returned_start: data?.start ?? null,
      returned_size: data?.size ?? null,
      returned_total: data?.total ?? null,
      returned_cursor_decoded: decodeCursor(data?.cursor),
      first_event: eventOrder[0] || null,
      last_event: eventOrder.at(-1) || null,
      known_matches_found: found.length,
      known_matches_total: known.length,
      dominant_provider_minus_feed_index_offset: bestOffset,
      dominant_offset_support: bestCount,
      offset_counts: offsetCounts,
      adjacent_gap_agreement: adjacentGapAgreement,
      known_positions: found,
      target_window_events: eventOrder.filter(x => {
        const t = DateTime.fromISO(x.start_time || "", { setZone: true });
        return t.isValid &&
          t >= DateTime.fromISO("2026-09-29T19:00:00.000Z") &&
          t <= DateTime.fromISO("2026-09-29T21:05:00.000Z");
      })
    };
  } catch (err) {
    return {
      ok: false,
      target_cursor_start: targetIso,
      error: String(err?.message || err).slice(0, 500)
    };
  }
}


async function probeExactFourPmBlock(providerStreams) {
  const targetIso = "2026-09-29T20:00:00.000Z";
  const targetMillis = DateTime.fromISO(targetIso, { setZone: true }).toMillis();
  const initialCursor = encodeSearchCursor(targetIso, "");
  const official = [];
  let cursor = initialCursor;
  let pages = 0;
  let stoppedBecause = null;

  while (cursor && pages < 12) {
    const data = await fetchJson(
      `${SEARCH_BASE}/v3/search/events?size=500&cursor=${encodeURIComponent(cursor)}`,
      30000
    );
    pages++;

    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      stoppedBecause = "empty_page";
      break;
    }

    let sawOlder = false;

    for (const event of items) {
      const dt = DateTime.fromISO(event?.start_time || "", { setZone: true });
      if (!dt.isValid) continue;
      const ms = dt.toMillis();

      if (ms < targetMillis) {
        sawOlder = true;
        continue;
      }
      if (ms > targetMillis) continue;

      const pubs = Array.isArray(event?.publishers) ? event.publishers : [];
      const broadcasts = [];

      for (const pub of pubs) {
        for (const b of (Array.isArray(pub?.broadcasts) ? pub.broadcasts : [])) {
          const bdt = DateTime.fromISO(b?.start_time || event?.start_time || "", { setZone: true });
          if (!bdt.isValid || bdt.toMillis() !== targetMillis) continue;

          broadcasts.push({
            broadcast_key: b?.key || null,
            game_key: b?.game_key || event?.key || null,
            subheadline: b?.subheadline || null,
            status: b?.status || null,
            is_live: b?.is_live ?? null,
            view_url_present: Boolean(b?.view_url),
            publisher_slug: pub?.slug || null,
            publisher_name: pub?.headline_short_name || pub?.formatted_name || null,
            association: pub?.state_association_acronym || null
          });
        }
      }

      official.push({
        event_key: event?.key || null,
        start_time: event?.start_time || null,
        sport: event?.sport || null,
        broadcast_count: broadcasts.length,
        broadcasts
      });
    }

    if (sawOlder) {
      stoppedBecause = "passed_target_time";
      break;
    }

    cursor = data?.cursor || null;
    if (!cursor) {
      stoppedBecause = "no_cursor";
      break;
    }
  }

  official.sort((a, b) => String(a.event_key || "").localeCompare(String(b.event_key || "")));
  official.forEach((x, i) => { x.full_feed_index = i; });

  const broadcastBearing = official.filter(x => x.broadcast_count > 0);
  broadcastBearing.forEach((x, i) => { x.broadcast_feed_index = i; });

  const provider4pm = providerStreams
    .filter(x => {
      const dt = DateTime.fromISO(x.provider_start || "", { setZone: true });
      return dt.isValid && dt.toUTC().toMillis() === targetMillis;
    })
    .sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number);

  const candidates = [];
  for (const event of broadcastBearing) {
    for (const b of event.broadcasts) {
      candidates.push({
        event_key: event.event_key,
        full_feed_index: event.full_feed_index,
        broadcast_feed_index: event.broadcast_feed_index,
        sport: event.sport,
        broadcast_key: b.broadcast_key,
        subheadline: b.subheadline,
        publisher_slug: b.publisher_slug,
        association: b.association,
        status: b.status,
        view_url_present: b.view_url_present
      });
    }
  }

  const matches = provider4pm.map(p => {
    let best = null;
    for (const cand of candidates) {
      const score = similarity(p.core, cand.subheadline || "");
      if (!best || score > best.text_score) best = { ...cand, text_score: score };
    }
    const strong = Boolean(best) && best.text_score >= 0.90;
    return {
      provider_nfhs_number: p.provider_nfhs_number,
      stream_id: p.stream_id,
      provider_title: p.title,
      best_match: best,
      strong_match: strong
    };
  });

  const strong = matches.filter(x => x.strong_match && x.best_match);
  const onePerEvent = [];
  const used = new Set();

  for (const m of [...strong].sort((a, b) =>
    b.best_match.text_score - a.best_match.text_score ||
    a.provider_nfhs_number - b.provider_nfhs_number
  )) {
    if (used.has(m.best_match.event_key)) continue;
    used.add(m.best_match.event_key);
    onePerEvent.push(m);
  }

  onePerEvent.sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number);

  function compareIndex(field) {
    if (onePerEvent.length < 2) return null;
    let increasing = 0;
    let exactGap = 0;
    let total = 0;
    const pairs = [];

    for (let i = 1; i < onePerEvent.length; i++) {
      const a = onePerEvent[i - 1];
      const b = onePerEvent[i];
      const ai = a.best_match[field];
      const bi = b.best_match[field];
      if (!Number.isFinite(ai) || !Number.isFinite(bi)) continue;

      total++;
      if (bi > ai) increasing++;

      const providerGap = b.provider_nfhs_number - a.provider_nfhs_number;
      const feedGap = bi - ai;
      if (providerGap === feedGap) exactGap++;

      pairs.push({
        from_provider: a.provider_nfhs_number,
        to_provider: b.provider_nfhs_number,
        from_event: a.best_match.event_key,
        to_event: b.best_match.event_key,
        provider_gap: providerGap,
        feed_gap: feedGap,
        gap_difference: providerGap - feedGap
      });
    }

    return {
      increasing_pairs: increasing,
      total_pairs: total,
      percent_increasing: total ? Number((increasing / total * 100).toFixed(2)) : null,
      exact_gap_pairs: exactGap,
      percent_exact_gap: total ? Number((exactGap / total * 100).toFixed(2)) : null,
      pairs
    };
  }

  const providerRankVsOfficialRank = onePerEvent.map((m, i) => ({
    provider_rank: i,
    provider_nfhs_number: m.provider_nfhs_number,
    event_key: m.best_match.event_key,
    full_feed_index: m.best_match.full_feed_index,
    broadcast_feed_index: m.best_match.broadcast_feed_index,
    text_score: m.best_match.text_score
  }));

  const sequenceAlignment = alignProviderToOfficial(provider4pm, broadcastBearing);

  return {
    ok: true,
    target_start: targetIso,
    pages_fetched: pages,
    stopped_because: stoppedBecause,
    official_events_exact_time: official.length,
    official_events_with_broadcasts: broadcastBearing.length,
    official_broadcast_candidates: candidates.length,
    provider_titles_exact_time: provider4pm.length,
    strong_local_matches: strong.length,
    unique_event_strong_matches: onePerEvent.length,
    full_feed_order_check: compareIndex("full_feed_index"),
    broadcast_feed_order_check: compareIndex("broadcast_feed_index"),
    sequence_alignment: sequenceAlignment,
    matched_positions: providerRankVsOfficialRank,
    unmatched_provider_samples: matches.filter(x => !x.strong_match).slice(0, 30)
  };
}


function providerSportFromTitle(title = "") {
  const s = String(title).toLowerCase();
  const sports = [
    ["flag football", "Flag Football"],
    ["field hockey", "Field Hockey"],
    ["cross country", "Cross Country"],
    ["ice hockey", "Ice Hockey"],
    ["volleyball", "Volleyball"],
    ["basketball", "Basketball"],
    ["football", "Football"],
    ["softball", "Softball"],
    ["baseball", "Baseball"],
    ["soccer", "Soccer"],
    ["wrestling", "Wrestling"],
    ["lacrosse", "Lacrosse"],
    ["badminton", "Badminton"],
    ["tennis", "Tennis"],
    ["golf", "Golf"],
    ["hockey", "Hockey"]
  ];
  for (const [needle, label] of sports) {
    if (s.includes(needle)) return label;
  }
  return null;
}

function sportEqual(a, b) {
  if (!a || !b) return null;
  const aa = normalize(a).replace(/\b(?:boys|girls|coed|varsity|junior|freshman|middle)\b/g, "").trim();
  const bb = normalize(b).replace(/\b(?:boys|girls|coed|varsity|junior|freshman|middle)\b/g, "").trim();
  return aa === bb;
}

function alignProviderToOfficial(providerRows, officialRows) {
  const P = providerRows;
  const O = officialRows;
  const n = P.length;
  const m = O.length;
  const NEG = -1e15;

  function officialTitle(o) {
    return o?.broadcasts?.[0]?.subheadline || "";
  }

  function matchScore(p, o) {
    const text = similarity(p.core, officialTitle(o));
    const ps = providerSportFromTitle(p.title);
    const sportMatch = sportEqual(ps, o.sport);

    let score = text * 12;
    if (sportMatch === true) score += 4;
    else if (sportMatch === false) score -= 5;

    if (text >= 0.96) score += 3;
    else if (text >= 0.80) score += 1;
    else if (text < 0.35) score -= 5;

    return { score, text, provider_sport: ps, official_sport: o.sport, sport_match: sportMatch };
  }

  // Constrained alignment: map every provider slot to one official event,
  // allowing official events to be skipped. Here m-n should equal the provider filter count.
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const prev = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));

  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) dp[i][j] = NEG;
  dp[0][0] = 0;

  const SKIP_OFFICIAL = -0.75;

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const cur = dp[i][j];
      if (cur <= NEG / 2) continue;

      if (j < m) {
        const v = cur + SKIP_OFFICIAL;
        if (v > dp[i][j + 1]) {
          dp[i][j + 1] = v;
          prev[i][j + 1] = 1; // skipped official
        }
      }

      if (i < n && j < m) {
        const ms = matchScore(P[i], O[j]).score;
        const v = cur + ms;
        if (v > dp[i + 1][j + 1]) {
          dp[i + 1][j + 1] = v;
          prev[i + 1][j + 1] = 2; // matched
        }
      }
    }
  }

  let i = n;
  let j = m;
  const mapping = [];
  const skipped = [];

  while (i > 0 || j > 0) {
    const p = prev[i][j];
    if (p === 2) {
      const pr = P[i - 1];
      const or = O[j - 1];
      const ms = matchScore(pr, or);
      mapping.push({
        provider_nfhs_number: pr.provider_nfhs_number,
        stream_id: pr.stream_id,
        provider_title: pr.title,
        provider_sport: ms.provider_sport,
        official_index: j - 1,
        event_key: or.event_key,
        official_sport: or.sport,
        official_subheadline: officialTitle(or),
        text_score: Number(ms.text.toFixed(4)),
        sport_match: ms.sport_match,
        alignment_score: Number(ms.score.toFixed(4))
      });
      i--; j--;
    } else if (p === 1) {
      const or = O[j - 1];
      skipped.push({
        official_index: j - 1,
        event_key: or.event_key,
        sport: or.sport,
        subheadline: officialTitle(or),
        broadcast_key: or?.broadcasts?.[0]?.broadcast_key || null,
        publisher_slug: or?.broadcasts?.[0]?.publisher_slug || null,
        association: or?.broadcasts?.[0]?.association || null,
        status: or?.broadcasts?.[0]?.status || null
      });
      j--;
    } else {
      // Should not occur for this constrained problem, but prevents an infinite loop.
      if (j > 0) j--;
      else if (i > 0) i--;
    }
  }

  mapping.reverse();
  skipped.reverse();

  let monotonic = 0;
  for (let k = 1; k < mapping.length; k++) {
    if (mapping[k].official_index > mapping[k - 1].official_index) monotonic++;
  }

  const highConfidence = mapping.filter(x => x.text_score >= 0.96 && x.sport_match !== false);
  const lowConfidence = mapping.filter(x => x.text_score < 0.80 || x.sport_match === false);

  return {
    provider_count: n,
    official_count: m,
    expected_official_skips: m - n,
    mapped_count: mapping.length,
    skipped_official_count: skipped.length,
    monotonic_pairs: monotonic,
    monotonic_pairs_total: Math.max(0, mapping.length - 1),
    high_confidence_mapping_count: highConfidence.length,
    low_confidence_mapping_count: lowConfidence.length,
    mapping,
    skipped_official_events: skipped,
    low_confidence_mappings: lowConfidence
  };
}

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;

  for (let i = 0; i < n; i++) {
    const ax = xs[i] - mx;
    const ay = ys[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }

  if (!dx || !dy) return null;
  return Number((num / Math.sqrt(dx * dy)).toFixed(6));
}

async function main() {
  const provider = await getProvider();
  const selected = chooseSamples(provider.streams);

  console.log(`Deep-link diagnostic: testing ${selected.samples.length} provider-title anchors from ${selected.latest_provider_day}.`);

  const rows = [];

  for (let i = 0; i < selected.samples.length; i++) {
    const p = selected.samples[i];
    console.log(`Search ${i + 1}/${selected.samples.length}: NFHS ${p.provider_nfhs_number}`);

    const searchTerms = buildSearchTerms(p.core);
    const candidateMap = new Map();
    const attempts = [];

    for (const term of searchTerms) {
      try {
        const search = await fetchJson(
          `${SEARCH_BASE}/v3/search/events?search_term=${encodeURIComponent(term)}&size=${SEARCH_SIZE}`
        );
        const flat = flattenSearchItems(search?.items || []);
        for (const item of flat) {
          const key = [
            item.event_key || "",
            item.broadcast_key || "",
            item.broadcast_start || item.event_start || "",
            item.publisher_slug || ""
          ].join("|");
          candidateMap.set(key, item);
        }
        attempts.push({ term, ok: true, item_count: Array.isArray(search?.items) ? search.items.length : 0 });
      } catch (err) {
        attempts.push({ term, ok: false, error: String(err?.message || err).slice(0, 200) });
      }
    }

    const candidates = [...candidateMap.values()];

    if (!attempts.some(x => x.ok)) {
      rows.push({
        provider: p,
        search_ok: false,
        search_terms: searchTerms,
        search_attempts: attempts,
        search_error: "All compact NFHS Search API queries failed."
      });
      continue;
    }

    const best = bestCandidate(p, candidates);

    const strong =
      Boolean(best) &&
      (
        (best.text_score >= 0.90 && (best.minutes_apart === null || best.minutes_apart <= 60)) ||
        (best.text_score >= 0.70 && best.minutes_apart !== null && best.minutes_apart <= 10)
      );

    let unity = null;
    if (strong) unity = await enrichUnity(best);

    rows.push({
      provider: p,
      search_ok: true,
      search_terms: searchTerms,
      search_attempts: attempts,
      unique_candidate_count: candidates.length,
      best_match: best,
      strong_match: strong,
      unity
    });
  }

  const strongRows = rows.filter(x => x.strong_match && x.best_match);
  const exactTextRows = strongRows.filter(x => x.best_match.text_score >= 0.97);
  const timePairs = strongRows
    .map(x => {
      const t = x.best_match.broadcast_start || x.best_match.event_start;
      if (!t) return null;
      const dt = DateTime.fromISO(t, { setZone: true });
      if (!dt.isValid) return null;
      return {
        provider_number: x.provider.provider_nfhs_number,
        official_ms: dt.toMillis()
      };
    })
    .filter(Boolean);

  const byStart = {};
  for (const x of strongRows) {
    const t = x.best_match.broadcast_start || x.best_match.event_start || "unknown";
    if (!byStart[t]) byStart[t] = [];
    byStart[t].push(x.provider.provider_nfhs_number);
  }

  for (const key of Object.keys(byStart)) {
    byStart[key].sort((a, b) => a - b);
  }

  const officialFeedProbe = await probeOfficialFeed(strongRows);
  const unityFleetFeeds = await probeUnityFleetFeeds(strongRows);
  const searchApiControls = await probeSearchApiControls();
  const targetDateCursorProbe = await probeTargetDateCursor(strongRows);
  const exactFourPmBlockProbe = await probeExactFourPmBlock(provider.streams);

  const exactZeroMinuteRows = strongRows.filter(
    x => x.best_match && x.best_match.minutes_apart === 0
  );

  const orderingChecks = (() => {
    const rows = exactZeroMinuteRows
      .map(x => ({
        provider_nfhs_number: x.provider.provider_nfhs_number,
        official_start: x.best_match.broadcast_start || x.best_match.event_start || null,
        event_key: x.unity?.event_key || x.best_match.event_key || null
      }))
      .filter(x => x.official_start && x.event_key)
      .sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number);

    const cmp = (a, b) => {
      const ta = Date.parse(a.official_start);
      const tb = Date.parse(b.official_start);
      if (ta !== tb) return ta - tb;
      return String(a.event_key).localeCompare(String(b.event_key));
    };

    let agreeing = 0;
    let total = 0;
    const violations = [];

    for (let i = 1; i < rows.length; i++) {
      total++;
      if (cmp(rows[i - 1], rows[i]) <= 0) agreeing++;
      else violations.push([rows[i - 1], rows[i]]);
    }

    return {
      exact_zero_minute_matches: rows.length,
      adjacent_pairs_agree_with_start_then_event_key: agreeing,
      adjacent_pairs_total: total,
      percent_agreement: total ? Number((agreeing / total * 100).toFixed(2)) : null,
      violations
    };
  })();

  const payload = {
    generated_at: new Date().toISOString(),
    diagnostic_only: true,
    modifies_epg: false,
    diagnostic_version: "deep-link-9",
    purpose:
      "Use NFHS Search API and Unity API to convert provider channel titles back into official NFHS event/broadcast identifiers, then test whether provider slot numbering tracks official event start ordering. No media URLs or protected video are saved.",
    safety: {
      public_events_json_modified: false,
      provider_video_accessed: false,
      nfhs_video_accessed: false,
      signed_playback_urls_saved: false,
      credentials_written_to_output: false
    },
    provider: {
      category: provider.category?.category_name || DEFAULT_CATEGORY,
      nfhs_stream_count: provider.streams.length,
      latest_title_day: selected.latest_provider_day,
      latest_title_day_stream_count: selected.pool_count
    },
    summary: {
      samples_tested: rows.length,
      search_api_successes: rows.filter(x => x.search_ok).length,
      strong_official_matches: strongRows.length,
      near_exact_metadata_matches: exactTextRows.length,
      strong_matches_with_unity_event: strongRows.filter(x => x.unity && !x.unity.error).length,
      provider_number_vs_official_start_pearson:
        timePairs.length >= 2
          ? pearson(
              timePairs.map(x => x.provider_number),
              timePairs.map(x => x.official_ms)
            )
          : null
    },
    ordering_checks: orderingChecks,
    official_feed_probe: officialFeedProbe,
    unity_fleet_feed_probe: unityFleetFeeds,
    search_api_control_probe: searchApiControls,
    target_date_cursor_probe: targetDateCursorProbe,
    exact_four_pm_block_probe: exactFourPmBlockProbe,
    official_start_groups_to_provider_numbers: byStart,
    rows
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile(
    "public/nfhs-deep-link-diagnostic.json",
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );

  console.log("NFHS deep-link diagnostic complete.");
  console.log(JSON.stringify(payload.summary, null, 2));
  console.log("public/events.json was NOT modified.");
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
