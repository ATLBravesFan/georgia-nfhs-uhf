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
        added: Number(s.added || 0) || null,
        epg_channel_id: s.epg_channel_id || null,
        custom_sid: s.custom_sid || null,
        tv_archive: s.tv_archive ?? null,
        tv_archive_duration: s.tv_archive_duration ?? null,
        container_extension: s.container_extension || null,
        direct_source_hash: sha20(s.direct_source),
        has_direct_source: Boolean(s.direct_source)
      };
    })
    .sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number);

  return { category, streams, base, auth };
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
  const twoSidedSequenceAlignment = alignProviderToOfficialTwoSided(provider4pm, broadcastBearing);

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
    two_sided_sequence_alignment: twoSidedSequenceAlignment,
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


function alignProviderToOfficialTwoSided(providerRows, officialRows) {
  const P = providerRows;
  const O = officialRows;
  const n = P.length;
  const m = O.length;
  const NEG = -1e15;
  const GAP_PROVIDER = -0.4;
  const GAP_OFFICIAL = -0.4;

  function officialTitle(o) {
    return o?.broadcasts?.[0]?.subheadline || "";
  }

  function matchMeta(p, o) {
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

  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const prev = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) dp[i][j] = NEG;
  dp[0][0] = 0;

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const cur = dp[i][j];
      if (cur <= NEG / 2) continue;

      if (i < n) {
        const v = cur + GAP_PROVIDER;
        if (v > dp[i + 1][j]) {
          dp[i + 1][j] = v;
          prev[i + 1][j] = 1; // provider-only / stale title
        }
      }

      if (j < m) {
        const v = cur + GAP_OFFICIAL;
        if (v > dp[i][j + 1]) {
          dp[i][j + 1] = v;
          prev[i][j + 1] = 2; // official-only / not represented
        }
      }

      if (i < n && j < m) {
        const mm = matchMeta(P[i], O[j]);
        const v = cur + mm.score;
        if (v > dp[i + 1][j + 1]) {
          dp[i + 1][j + 1] = v;
          prev[i + 1][j + 1] = 3;
        }
      }
    }
  }

  let i = n;
  let j = m;
  const mapping = [];
  const providerOnly = [];
  const officialOnly = [];

  while (i > 0 || j > 0) {
    const p = prev[i][j];

    if (p === 3) {
      const pr = P[i - 1];
      const or = O[j - 1];
      const mm = matchMeta(pr, or);
      mapping.push({
        provider_nfhs_number: pr.provider_nfhs_number,
        stream_id: pr.stream_id,
        provider_title: pr.title,
        provider_sport: mm.provider_sport,
        official_index: j - 1,
        event_key: or.event_key,
        official_sport: or.sport,
        official_subheadline: officialTitle(or),
        text_score: Number(mm.text.toFixed(4)),
        sport_match: mm.sport_match,
        alignment_score: Number(mm.score.toFixed(4))
      });
      i--; j--;
    } else if (p === 1) {
      const pr = P[i - 1];
      providerOnly.push({
        provider_nfhs_number: pr.provider_nfhs_number,
        stream_id: pr.stream_id,
        provider_title: pr.title,
        provider_sport: providerSportFromTitle(pr.title)
      });
      i--;
    } else if (p === 2) {
      const or = O[j - 1];
      officialOnly.push({
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
      if (i > 0) i--;
      else if (j > 0) j--;
    }
  }

  mapping.reverse();
  providerOnly.reverse();
  officialOnly.reverse();

  const anchors = mapping.filter(x => x.text_score >= 0.96 && x.sport_match !== false);
  const deterministic = new Map();

  for (const a of anchors) {
    deterministic.set(a.provider_nfhs_number, {
      provider_nfhs_number: a.provider_nfhs_number,
      official_index: a.official_index,
      event_key: a.event_key,
      method: "exact_anchor"
    });
  }

  let exactAnchorGapPairs = 0;
  let anchorGapPairs = 0;

  for (let k = 1; k < anchors.length; k++) {
    const a = anchors[k - 1];
    const b = anchors[k];
    const providerGap = b.provider_nfhs_number - a.provider_nfhs_number;
    const officialGap = b.official_index - a.official_index;
    anchorGapPairs++;

    if (providerGap === officialGap) {
      exactAnchorGapPairs++;
      for (let step = 0; step <= providerGap; step++) {
        const providerNumber = a.provider_nfhs_number + step;
        const officialIndex = a.official_index + step;
        const or = O[officialIndex];
        if (!or) continue;
        deterministic.set(providerNumber, {
          provider_nfhs_number: providerNumber,
          official_index: officialIndex,
          event_key: or.event_key,
          method: step === 0 || step === providerGap ? "exact_anchor" : "anchor_interpolation"
        });
      }
    }
  }

  const deterministicRows = [...deterministic.values()].sort(
    (a, b) => a.provider_nfhs_number - b.provider_nfhs_number
  );

  return {
    final_alignment_score: Number(dp[n][m].toFixed(4)),
    provider_count: n,
    official_count: m,
    matched_count: mapping.length,
    provider_only_count: providerOnly.length,
    official_only_count: officialOnly.length,
    exact_anchor_count: anchors.length,
    anchor_gap_pairs: anchorGapPairs,
    exact_anchor_gap_pairs: exactAnchorGapPairs,
    percent_anchor_gaps_exact: anchorGapPairs
      ? Number((exactAnchorGapPairs / anchorGapPairs * 100).toFixed(2))
      : null,
    deterministic_provider_slots: deterministicRows.length,
    deterministic_provider_coverage_percent: n
      ? Number((deterministicRows.length / n * 100).toFixed(2))
      : null,
    mapping,
    provider_only_rows: providerOnly,
    official_only_rows: officialOnly,
    deterministic_mapping: deterministicRows
  };
}


async function resolveProviderOnlyTitles(providerOnlyRows, officialOnlyRows) {
  const officialOnlySet = new Set((officialOnlyRows || []).map(x => x.event_key).filter(Boolean));
  const results = [];

  for (const row of providerOnlyRows || []) {
    const core = providerCore(row.provider_title || "");
    const searchTerms = buildSearchTerms(core);
    const candidateMap = new Map();
    const attempts = [];

    for (const term of searchTerms) {
      try {
        const search = await fetchJson(
          `${SEARCH_BASE}/v3/search/events?search_term=${encodeURIComponent(term)}&size=${SEARCH_SIZE}`,
          30000
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

        attempts.push({
          term,
          ok: true,
          item_count: Array.isArray(search?.items) ? search.items.length : 0
        });
      } catch (err) {
        attempts.push({
          term,
          ok: false,
          error: String(err?.message || err).slice(0, 200)
        });
      }
    }

    const candidates = [...candidateMap.values()];
    let best = null;

    for (const cand of candidates) {
      const texts = [
        cand.broadcast_subheadline,
        cand.event_title,
        [cand.publisher_name, cand.event_title].filter(Boolean).join(" ")
      ].filter(Boolean);

      const textScore = Math.max(0, ...texts.map(t => similarity(core, t)));
      const providerSport = providerSportFromTitle(row.provider_title || "");
      const sportMatch = sportEqual(providerSport, cand.sport);
      const officialStart = cand.broadcast_start || cand.event_start || null;
      const providerStart = parseProviderStart(row.provider_title || "")?.toISO() || null;
      const diff = safeTimeDiffMinutes(providerStart, officialStart);

      let score = textScore * 10;
      if (sportMatch === true) score += 3;
      else if (sportMatch === false) score -= 4;
      if (textScore >= 0.96) score += 4;
      if (diff !== null && diff <= 5) score += 1;

      const item = {
        ...cand,
        text_score: Number(textScore.toFixed(4)),
        provider_sport: providerSport,
        sport_match: sportMatch,
        provider_start: providerStart,
        official_start: officialStart,
        minutes_apart: diff === null ? null : Number(diff.toFixed(2)),
        score: Number(score.toFixed(4))
      };

      if (!best || item.score > best.score) best = item;
    }

    const strong =
      Boolean(best) &&
      best.text_score >= 0.90 &&
      best.sport_match !== false;

    results.push({
      provider_nfhs_number: row.provider_nfhs_number,
      stream_id: row.stream_id,
      provider_title: row.provider_title,
      search_terms: searchTerms,
      search_attempts: attempts,
      strong_resolution: strong,
      best_match: best ? {
        event_key: best.event_key,
        sport: best.sport,
        broadcast_start: best.broadcast_start,
        event_start: best.event_start,
        official_start: best.official_start,
        provider_start: best.provider_start,
        minutes_apart: best.minutes_apart,
        publisher_slug: best.publisher_slug,
        association: best.association,
        broadcast_subheadline: best.broadcast_subheadline,
        text_score: best.text_score,
        sport_match: best.sport_match,
        was_in_four_pm_official_only_set: officialOnlySet.has(best.event_key)
      } : null
    });
  }

  const strong = results.filter(x => x.strong_resolution && x.best_match);
  const crossTime = strong.filter(x =>
    x.best_match.minutes_apart !== null && x.best_match.minutes_apart > 5
  );
  const rescuedOfficialOnly = strong.filter(x =>
    x.best_match.was_in_four_pm_official_only_set
  );

  return {
    provider_only_rows_tested: results.length,
    strongly_resolved: strong.length,
    unresolved: results.length - strong.length,
    strongly_resolved_to_different_official_time: crossTime.length,
    strongly_resolved_to_four_pm_official_only_event: rescuedOfficialOnly.length,
    different_time_rows: crossTime,
    rescued_four_pm_rows: rescuedOfficialOnly,
    rows: results
  };
}


async function probeBrantleyClinchSequence() {
  const terms = ["Clinch County Brantley County", "Brantley County"];
  const candidateMap = new Map();

  for (const term of terms) {
    try {
      const search = await fetchJson(
        `${SEARCH_BASE}/v3/search/events?search_term=${encodeURIComponent(term)}&size=100`,
        30000
      );

      for (const item of flattenSearchItems(search?.items || [])) {
        const key = [
          item.event_key || "",
          item.broadcast_key || "",
          item.broadcast_start || item.event_start || ""
        ].join("|");
        candidateMap.set(key, item);
      }
    } catch {}
  }

  const sameDay = [...candidateMap.values()]
    .filter(x => {
      const start = x.broadcast_start || x.event_start || "";
      const text = cleanSpace(x.broadcast_subheadline || "");
      return start.startsWith("2026-09-29") &&
        /brantley county/i.test(text) &&
        String(x.sport || "").toLowerCase() === "volleyball";
    })
    .sort((a, b) => String(a.broadcast_start || a.event_start || "").localeCompare(
      String(b.broadcast_start || b.event_start || "")
    ));

  const enriched = [];
  for (const row of sameDay) {
    const unity = await enrichUnity(row);

    enriched.push({
      event_key: row.event_key,
      official_start: row.broadcast_start || row.event_start || null,
      subheadline: row.broadcast_subheadline || null,
      association: row.association || null,
      publisher_slug: row.publisher_slug || null,
      safe_identity: unity && !unity.error ? {
        publisher_key_hash: sha20(unity.publisher_key),
        pixellot_event_id_hash: sha20(unity.pixellot_event_id),
        pixellot_id_hash: sha20(unity.pixellot_id),
        pixellot_key_hash: sha20(unity.pixellot_key),
        producer_key_hash: sha20(unity.producer_key),
        ingest_point_fingerprint: unity.ingest_point_fingerprint || null
      } : null,
      unity_error: unity?.error || null
    });
  }

  const comparisons = [];

  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const a = enriched[i];
      const b = enriched[j];
      const A = a.safe_identity || {};
      const B = b.safe_identity || {};

      comparisons.push({
        event_a: a.event_key,
        event_b: b.event_key,
        start_a: a.official_start,
        start_b: b.official_start,
        same_publisher: Boolean(A.publisher_key_hash && A.publisher_key_hash === B.publisher_key_hash),
        same_pixellot_unit: Boolean(A.pixellot_id_hash && A.pixellot_id_hash === B.pixellot_id_hash),
        same_pixellot_key: Boolean(A.pixellot_key_hash && A.pixellot_key_hash === B.pixellot_key_hash),
        same_producer: Boolean(A.producer_key_hash && A.producer_key_hash === B.producer_key_hash),
        same_ingest_fingerprint: Boolean(
          A.ingest_point_fingerprint &&
          A.ingest_point_fingerprint === B.ingest_point_fingerprint
        )
      });
    }
  }

  return {
    search_terms: terms,
    same_day_brantley_volleyball_events_found: enriched.length,
    events: enriched,
    pairwise_identity_comparisons: comparisons
  };
}

function summarizeSameDayProviderOnlyResolution(providerOnlyResolution) {
  const rows = providerOnlyResolution?.rows || [];
  const sameDay = rows
    .filter(x => {
      const b = x.best_match;
      return x.strong_resolution &&
        b?.official_start &&
        b.official_start.startsWith("2026-09-29");
    })
    .map(x => ({
      provider_nfhs_number: x.provider_nfhs_number,
      provider_title: x.provider_title,
      event_key: x.best_match.event_key,
      official_start: x.best_match.official_start,
      minutes_apart: x.best_match.minutes_apart,
      sport: x.best_match.sport,
      association: x.best_match.association,
      subheadline: x.best_match.broadcast_subheadline
    }));

  return {
    strong_same_day_resolutions: sameDay.length,
    rows: sameDay
  };
}


function collectSafeIdentifierFingerprints(value, path = "$", out = [], depth = 0) {
  if (depth > 8 || out.length > 500) return out;
  if (!value || typeof value !== "object") return out;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectSafeIdentifierFingerprints(value[i], `${path}[${i}]`, out, depth + 1);
    }
    return out;
  }

  for (const [k, v] of Object.entries(value)) {
    const p = `${path}.${k}`;

    if (
      v !== null &&
      ["string", "number", "boolean"].includes(typeof v) &&
      /(id|key|source|stream|ingest|producer|publisher|pixellot|venue|device|camera|unit|channel)/i.test(k)
    ) {
      const raw = String(v);
      if (raw) {
        out.push({
          path: p,
          value_hash: sha20(raw),
          value_type: typeof v
        });
      }
    }

    if (v && typeof v === "object") {
      collectSafeIdentifierFingerprints(v, p, out, depth + 1);
    }
  }

  return out;
}

async function probeBrantleySourceLineage() {
  const eventIds = ["gamb8ad8195a3", "gamc34e8e3bfe"];
  const events = [];

  for (const eventId of eventIds) {
    try {
      const data = await fetchJson(
        `${UNITY_BASE}/v2/game_or_event/${encodeURIComponent(eventId)}`,
        30000
      );

      const pubs = Array.isArray(data?.publishers) ? data.publishers : [];
      const pairs = pubs.flatMap(pub =>
        (Array.isArray(pub?.broadcasts) ? pub.broadcasts : []).map(b => ({ pub, b }))
      );
      const pair = pairs[0] || null;
      const pub = pair?.pub || pubs[0] || null;
      const b = pair?.b || null;

      let broadcastDetail = null;
      let broadcastDetailError = null;

      if (b?.key) {
        try {
          broadcastDetail = await fetchJson(
            `${UNITY_BASE}/v2/broadcasts/${encodeURIComponent(b.key)}`,
            30000
          );
        } catch (err) {
          broadcastDetailError = String(err?.message || err).slice(0, 300);
        }
      }

      let publisherPixellot = null;
      let publisherPixellotError = null;
      const publisherKey = pub?.key || pub?.publisher_key || null;

      if (publisherKey) {
        try {
          publisherPixellot = await fetchJson(
            `${UNITY_BASE}/v2/pixellots/publisher/${encodeURIComponent(publisherKey)}`,
            30000
          );
        } catch (err) {
          publisherPixellotError = String(err?.message || err).slice(0, 300);
        }
      }

      const detailFingerprints = collectSafeIdentifierFingerprints(broadcastDetail);
      const publisherPixellotFingerprints = collectSafeIdentifierFingerprints(publisherPixellot);

      events.push({
        event_key: eventId,
        local_start_time: data?.local_start_time || null,
        publisher_key_hash: sha20(publisherKey),
        producer_key_hash: sha20(b?.producer_key),
        ingest_point_hash: sha20(b?.ingest_point),
        broadcast_key_hash: sha20(b?.key),
        broadcast_detail_ok: Boolean(broadcastDetail),
        broadcast_detail_error: broadcastDetailError,
        broadcast_detail_identifier_fingerprints: detailFingerprints,
        publisher_pixellot_ok: Boolean(publisherPixellot),
        publisher_pixellot_error: publisherPixellotError,
        publisher_pixellot_top_level_type: Array.isArray(publisherPixellot)
          ? "array"
          : (publisherPixellot === null ? null : typeof publisherPixellot),
        publisher_pixellot_top_level_length: Array.isArray(publisherPixellot)
          ? publisherPixellot.length
          : null,
        publisher_pixellot_identifier_fingerprints: publisherPixellotFingerprints
      });
    } catch (err) {
      events.push({
        event_key: eventId,
        error: String(err?.message || err).slice(0, 400)
      });
    }
  }

  const comparison = { common_equal_identifier_paths: [], common_different_identifier_paths: [] };

  if (events.length === 2 && !events[0].error && !events[1].error) {
    const A = new Map(
      (events[0].broadcast_detail_identifier_fingerprints || []).map(x => [x.path, x.value_hash])
    );
    const B = new Map(
      (events[1].broadcast_detail_identifier_fingerprints || []).map(x => [x.path, x.value_hash])
    );

    for (const [path, ah] of A) {
      if (!B.has(path)) continue;
      const bh = B.get(path);
      if (ah === bh) comparison.common_equal_identifier_paths.push(path);
      else comparison.common_different_identifier_paths.push(path);
    }

    const PA = new Set(
      (events[0].publisher_pixellot_identifier_fingerprints || []).map(x => `${x.path}|${x.value_hash}`)
    );
    const PB = new Set(
      (events[1].publisher_pixellot_identifier_fingerprints || []).map(x => `${x.path}|${x.value_hash}`)
    );

    comparison.publisher_pixellot_fingerprint_sets_equal =
      PA.size === PB.size && [...PA].every(x => PB.has(x));

    comparison.same_publisher = Boolean(
      events[0].publisher_key_hash &&
      events[0].publisher_key_hash === events[1].publisher_key_hash
    );
    comparison.same_producer = Boolean(
      events[0].producer_key_hash &&
      events[0].producer_key_hash === events[1].producer_key_hash
    );
    comparison.same_ingest = Boolean(
      events[0].ingest_point_hash &&
      events[0].ingest_point_hash === events[1].ingest_point_hash
    );
    comparison.broadcast_keys_different = Boolean(
      events[0].broadcast_key_hash &&
      events[1].broadcast_key_hash &&
      events[0].broadcast_key_hash !== events[1].broadcast_key_hash
    );
  }

  return {
    purpose:
      "Compare the two Sep 29 Clinch County vs Brantley County broadcasts at the source-lineage level without saving raw identifiers or playback URLs.",
    events,
    comparison
  };
}


function safeUrlStructure(raw) {
  if (raw === null || raw === undefined) return null;
  const strings = [];

  function collect(v, depth = 0) {
    if (depth > 5 || strings.length > 50) return;
    if (typeof v === "string") {
      strings.push(v);
      return;
    }
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) collect(x, depth + 1);
      return;
    }
    for (const x of Object.values(v)) collect(x, depth + 1);
  }

  collect(raw);

  const urlLike = strings.find(s => /^https?:\/\//i.test(s)) || null;
  if (!urlLike) {
    return {
      response_hash: sha20(JSON.stringify(raw)),
      url_found: false
    };
  }

  try {
    const u = new URL(urlLike);
    return {
      response_hash: sha20(JSON.stringify(raw)),
      url_found: true,
      url_hash: sha20(urlLike),
      protocol: u.protocol,
      hostname_hash: sha20(u.hostname),
      port: u.port || null,
      pathname_hash: sha20(u.pathname),
      path_segment_hashes: u.pathname.split("/").filter(Boolean).map(sha20),
      query_keys: [...u.searchParams.keys()].sort()
    };
  } catch {
    return {
      response_hash: sha20(JSON.stringify(raw)),
      url_found: false
    };
  }
}

async function fetchMaybeJson(url, timeoutMs = 30000) {
  const text = await fetchText(url, timeoutMs);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function probeClinchBroadcastRouting() {
  const eventIds = ["gamb8ad8195a3", "gamc34e8e3bfe"];
  const rows = [];

  for (const eventId of eventIds) {
    try {
      const event = await fetchJson(
        `${UNITY_BASE}/v2/game_or_event/${encodeURIComponent(eventId)}`,
        30000
      );

      const pubs = Array.isArray(event?.publishers) ? event.publishers : [];
      const pairs = pubs.flatMap(pub =>
        (Array.isArray(pub?.broadcasts) ? pub.broadcasts : []).map(b => ({ pub, b }))
      );
      const pair = pairs[0] || null;
      const b = pair?.b || null;

      if (!b?.key) {
        rows.push({ event_key: eventId, error: "No broadcast key found." });
        continue;
      }

      let preset = null;
      let presetError = null;
      try {
        preset = await fetchMaybeJson(
          `${UNITY_BASE}/v2/pixellots/presets/${encodeURIComponent(b.key)}`,
          30000
        );
      } catch (err) {
        presetError = String(err?.message || err).slice(0, 300);
      }

      let apiUrl = null;
      let apiUrlError = null;
      try {
        apiUrl = await fetchMaybeJson(
          `${UNITY_BASE}/v2/broadcasts/${encodeURIComponent(b.key)}/broadcast_api_url`,
          30000
        );
      } catch (err) {
        apiUrlError = String(err?.message || err).slice(0, 300);
      }

      rows.push({
        event_key: eventId,
        local_start_time: event?.local_start_time || null,
        preset_ok: preset !== null,
        preset_error: presetError,
        preset_response_type: Array.isArray(preset) ? "array" : typeof preset,
        preset_identifier_fingerprints: collectSafeIdentifierFingerprints(preset),
        preset_response_hash: preset === null ? null : sha20(JSON.stringify(preset)),
        broadcast_api_url_ok: apiUrl !== null,
        broadcast_api_url_error: apiUrlError,
        broadcast_api_url_structure: safeUrlStructure(apiUrl)
      });
    } catch (err) {
      rows.push({
        event_key: eventId,
        error: String(err?.message || err).slice(0, 400)
      });
    }
  }

  const comparison = {};

  if (rows.length === 2 && !rows[0].error && !rows[1].error) {
    const presetA = new Map(
      (rows[0].preset_identifier_fingerprints || []).map(x => [x.path, x.value_hash])
    );
    const presetB = new Map(
      (rows[1].preset_identifier_fingerprints || []).map(x => [x.path, x.value_hash])
    );

    const equalPresetPaths = [];
    const differentPresetPaths = [];

    for (const [path, ah] of presetA) {
      if (!presetB.has(path)) continue;
      const bh = presetB.get(path);
      if (ah === bh) equalPresetPaths.push(path);
      else differentPresetPaths.push(path);
    }

    comparison.preset_response_hash_equal = Boolean(
      rows[0].preset_response_hash &&
      rows[0].preset_response_hash === rows[1].preset_response_hash
    );
    comparison.preset_equal_identifier_paths = equalPresetPaths;
    comparison.preset_different_identifier_paths = differentPresetPaths;

    const ua = rows[0].broadcast_api_url_structure || {};
    const ub = rows[1].broadcast_api_url_structure || {};

    comparison.broadcast_api_url = {
      both_available: Boolean(rows[0].broadcast_api_url_ok && rows[1].broadcast_api_url_ok),
      same_full_url_hash: Boolean(ua.url_hash && ua.url_hash === ub.url_hash),
      same_hostname_hash: Boolean(ua.hostname_hash && ua.hostname_hash === ub.hostname_hash),
      same_pathname_hash: Boolean(ua.pathname_hash && ua.pathname_hash === ub.pathname_hash),
      same_path_segment_count: Array.isArray(ua.path_segment_hashes) &&
        Array.isArray(ub.path_segment_hashes) &&
        ua.path_segment_hashes.length === ub.path_segment_hashes.length,
      equal_path_segment_positions: Array.isArray(ua.path_segment_hashes) &&
        Array.isArray(ub.path_segment_hashes)
          ? ua.path_segment_hashes
              .map((h, i) => h === ub.path_segment_hashes[i] ? i : null)
              .filter(i => i !== null)
          : [],
      query_keys_equal: Array.isArray(ua.query_keys) &&
        Array.isArray(ub.query_keys) &&
        JSON.stringify(ua.query_keys) === JSON.stringify(ub.query_keys)
    };
  }

  return {
    purpose:
      "Compare event-specific Pixellot presets and broadcast API routing for the two Sep 29 Clinch County vs Brantley County broadcasts. Raw URLs, keys, and identifiers are not written.",
    rows,
    comparison
  };
}


function safeUrlStructureDeep(raw) {
  if (raw === null || raw === undefined) return null;
  const strings = [];

  function collect(v, depth = 0) {
    if (depth > 5 || strings.length > 100) return;
    if (typeof v === "string") {
      strings.push(v);
      return;
    }
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) collect(x, depth + 1);
      return;
    }
    for (const x of Object.values(v)) collect(x, depth + 1);
  }

  collect(raw);
  const urlLike = strings.find(s => /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) || null;

  if (!urlLike) {
    return {
      response_hash: sha20(JSON.stringify(raw)),
      url_found: false
    };
  }

  try {
    const u = new URL(urlLike);
    return {
      response_hash: sha20(JSON.stringify(raw)),
      url_found: true,
      url_hash: sha20(urlLike),
      protocol: u.protocol,
      hostname_hash: sha20(u.hostname),
      port: u.port || null,
      pathname_hash: sha20(u.pathname),
      path_segment_hashes: u.pathname.split("/").filter(Boolean).map(sha20),
      query_keys: [...u.searchParams.keys()].sort(),
      query_value_hashes: [...u.searchParams.entries()]
        .map(([key, value]) => ({ key, value_hash: sha20(value) }))
        .sort((a, b) => a.key.localeCompare(b.key) || a.value_hash.localeCompare(b.value_hash))
    };
  } catch {
    return {
      response_hash: sha20(JSON.stringify(raw)),
      url_found: false
    };
  }
}

function compareSafeUrlStructures(providerStruct, officialStruct) {
  const p = providerStruct || {};
  const o = officialStruct || {};
  const pSeg = Array.isArray(p.path_segment_hashes) ? p.path_segment_hashes : [];
  const oSeg = Array.isArray(o.path_segment_hashes) ? o.path_segment_hashes : [];
  const oSet = new Set(oSeg);
  const sharedSegments = pSeg.filter(x => oSet.has(x));

  const pQ = new Set(
    (Array.isArray(p.query_value_hashes) ? p.query_value_hashes : [])
      .map(x => `${x.key}|${x.value_hash}`)
  );
  const oQ = new Set(
    (Array.isArray(o.query_value_hashes) ? o.query_value_hashes : [])
      .map(x => `${x.key}|${x.value_hash}`)
  );
  const sharedQueryValues = [...pQ].filter(x => oQ.has(x));

  return {
    both_urls_found: Boolean(p.url_found && o.url_found),
    same_protocol: Boolean(p.protocol && p.protocol === o.protocol),
    same_hostname_hash: Boolean(p.hostname_hash && p.hostname_hash === o.hostname_hash),
    same_pathname_hash: Boolean(p.pathname_hash && p.pathname_hash === o.pathname_hash),
    same_path_segment_count: pSeg.length > 0 && pSeg.length === oSeg.length,
    shared_path_segment_count: sharedSegments.length,
    shared_path_segment_hashes: sharedSegments,
    same_first_path_segment: Boolean(pSeg[0] && pSeg[0] === oSeg[0]),
    same_last_path_segment: Boolean(
      pSeg.length &&
      oSeg.length &&
      pSeg[pSeg.length - 1] === oSeg[oSeg.length - 1]
    ),
    shared_query_value_count: sharedQueryValues.length,
    shared_query_value_hashes: sharedQueryValues
  };
}

async function resolveProviderRedirectStructure(streamId) {
  const base = cleanSpace(process.env.XTREAM_BASE_URL || "").replace(/\/+$/, "");
  const username = process.env.XTREAM_USERNAME || "";
  const password = process.env.XTREAM_PASSWORD || "";

  if (!base || !username || !password) {
    return { ok: false, error: "Missing provider credentials." };
  }

  const target =
    `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.ts`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);

  try {
    const r = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 Georgia-NFHS-Deep-Link-Diagnostic/15.0" }
    });

    const location = r.headers.get("location");

    try {
      if (r.body) await r.body.cancel();
    } catch {}

    let absoluteLocation = location;
    if (location && !/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) {
      try {
        absoluteLocation = new URL(location, base).toString();
      } catch {}
    }

    return {
      ok: true,
      status: r.status,
      redirected: Boolean(location),
      redirect_structure: location ? safeUrlStructureDeep(absoluteLocation) : null,
      content_type: r.headers.get("content-type") || null
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err).slice(0, 300)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveOfficialEventRouting(eventId) {
  try {
    const event = await fetchJson(
      `${UNITY_BASE}/v2/game_or_event/${encodeURIComponent(eventId)}`,
      30000
    );

    const pubs = Array.isArray(event?.publishers) ? event.publishers : [];
    const pairs = pubs.flatMap(pub =>
      (Array.isArray(pub?.broadcasts) ? pub.broadcasts : []).map(b => ({ pub, b }))
    );
    const pair = pairs[0] || null;
    const b = pair?.b || null;

    if (!b?.key) {
      return { event_key: eventId, ok: false, error: "No broadcast key." };
    }

    let playback = null;
    let playbackError = null;
    try {
      playback = await fetchMaybeJson(
        `${UNITY_BASE}/v2/broadcasts/${encodeURIComponent(b.key)}/url`,
        30000
      );
    } catch (err) {
      playbackError = String(err?.message || err).slice(0, 300);
    }

    let apiRoute = null;
    let apiRouteError = null;
    try {
      apiRoute = await fetchMaybeJson(
        `${UNITY_BASE}/v2/broadcasts/${encodeURIComponent(b.key)}/broadcast_api_url`,
        30000
      );
    } catch (err) {
      apiRouteError = String(err?.message || err).slice(0, 300);
    }

    return {
      event_key: eventId,
      ok: true,
      local_start_time: event?.local_start_time || null,
      publisher_key_hash: sha20(pair?.pub?.key || pair?.pub?.publisher_key),
      producer_key_hash: sha20(b?.producer_key),
      broadcast_key_hash: sha20(b?.key),
      ingest_structure: safeUrlStructureDeep(b?.ingest_point),
      playback_ok: playback !== null,
      playback_error: playbackError,
      playback_structure: safeUrlStructureDeep(playback),
      broadcast_api_url_ok: apiRoute !== null,
      broadcast_api_url_error: apiRouteError,
      broadcast_api_url_structure: safeUrlStructureDeep(apiRoute)
    };
  } catch (err) {
    return {
      event_key: eventId,
      ok: false,
      error: String(err?.message || err).slice(0, 400)
    };
  }
}

async function probeOfficialPlaybackVsProviderRelay(providerStreams) {
  const controls = [
    {
      provider_nfhs_number: 3552,
      candidates: [
        { label: "stale_title_event", event_key: "gamb8ebe375ea" },
        { label: "clinch_4pm", event_key: "gamb8ad8195a3" },
        { label: "clinch_5pm", event_key: "gamc34e8e3bfe" }
      ]
    },
    {
      provider_nfhs_number: 3572,
      candidates: [
        { label: "camden_savannah_5pm", event_key: "gam3a5725b205" }
      ]
    },
    {
      provider_nfhs_number: 3536,
      candidates: [
        { label: "grove_carmel_650pm", event_key: "gam3ba7a342c5" }
      ]
    }
  ];

  const rows = [];

  for (const control of controls) {
    const provider = providerStreams.find(
      x => x.provider_nfhs_number === control.provider_nfhs_number
    );

    if (!provider) {
      rows.push({
        provider_nfhs_number: control.provider_nfhs_number,
        error: "Provider slot not found."
      });
      continue;
    }

    const providerRelay = await resolveProviderRedirectStructure(provider.stream_id);
    const candidates = [];

    for (const candidate of control.candidates) {
      const official = await resolveOfficialEventRouting(candidate.event_key);

      candidates.push({
        label: candidate.label,
        event_key: candidate.event_key,
        official,
        comparisons: official?.ok && providerRelay?.ok ? {
          provider_vs_playback: compareSafeUrlStructures(
            providerRelay.redirect_structure,
            official.playback_structure
          ),
          provider_vs_broadcast_api_url: compareSafeUrlStructures(
            providerRelay.redirect_structure,
            official.broadcast_api_url_structure
          ),
          provider_vs_ingest: compareSafeUrlStructures(
            providerRelay.redirect_structure,
            official.ingest_structure
          )
        } : null
      });
    }

    rows.push({
      provider_nfhs_number: control.provider_nfhs_number,
      stream_id: provider.stream_id,
      provider_title: provider.title,
      provider_relay: providerRelay,
      candidates
    });
  }

  return {
    purpose:
      "Resolve official NFHS playback/API routing for known controls and compare only hashed URL structure against the provider relay redirect. Raw provider credentials and raw NFHS/provider URLs are never written.",
    provider_connections_are_sequential: true,
    rows
  };
}


async function fetchExactOfficialBlock(targetIso, maxPages = 12) {
  const targetMillis = DateTime.fromISO(targetIso, { setZone: true }).toMillis();
  let cursor = encodeSearchCursor(targetIso, "");
  const official = [];
  let pages = 0;
  let stoppedBecause = null;

  while (cursor && pages < maxPages) {
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

      official.push({
        event_key: event?.key || null,
        start_time: event?.start_time || null,
        sport: event?.sport || null,
        publishers: Array.isArray(event?.publishers)
          ? event.publishers.map(pub => ({
              slug: pub?.slug || null,
              association: pub?.state_association_acronym || null,
              broadcasts: (Array.isArray(pub?.broadcasts) ? pub.broadcasts : [])
                .filter(b => {
                  const bdt = DateTime.fromISO(b?.start_time || event?.start_time || "", { setZone: true });
                  return bdt.isValid && bdt.toMillis() === targetMillis;
                })
                .map(b => ({
                  key_hash: sha20(b?.key),
                  subheadline: b?.subheadline || null,
                  status: b?.status || null
                }))
            }))
          : []
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
  official.forEach((x, i) => { x.feed_index = i; });

  return { targetIso, pages, stoppedBecause, official };
}

async function probeFivePmSlotReuse() {
  const block = await fetchExactOfficialBlock("2026-09-29T21:00:00.000Z");

  const targets = [
    {
      label: "clinch_brantley_5pm",
      event_key: "gamc34e8e3bfe",
      observed_provider_slot: 3552
    },
    {
      label: "camden_savannah_5pm",
      event_key: "gam3a5725b205",
      observed_provider_slot: 3572
    }
  ];

  const rows = targets.map(t => {
    const event = block.official.find(x => x.event_key === t.event_key) || null;
    const idx = event?.feed_index ?? null;
    const impliedBase = idx === null ? null : t.observed_provider_slot - idx;

    return {
      ...t,
      found_in_exact_5pm_block: Boolean(event),
      official_feed_index: idx,
      implied_provider_base: impliedBase,
      projected_slot_using_4pm_base_3406: idx === null ? null : 3406 + idx,
      projection_error_vs_observed: idx === null ? null : (3406 + idx) - t.observed_provider_slot,
      official_event: event ? {
        event_key: event.event_key,
        sport: event.sport,
        publisher_slugs: event.publishers.map(p => p.slug).filter(Boolean),
        associations: [...new Set(event.publishers.map(p => p.association).filter(Boolean))],
        subheadlines: event.publishers.flatMap(p => p.broadcasts.map(b => b.subheadline)).filter(Boolean)
      } : null
    };
  });

  const impliedBases = rows
    .map(x => x.implied_provider_base)
    .filter(x => Number.isFinite(x));

  return {
    purpose:
      "Test whether the provider reuses the 4 PM slot base for the 5 PM NFHS event block by comparing exact official 5 PM feed indices to observed provider slots.",
    exact_5pm_event_count: block.official.length,
    pages_fetched: block.pages,
    stopped_because: block.stoppedBecause,
    four_pm_reference_base: 3406,
    target_rows: rows,
    implied_bases_equal: impliedBases.length >= 2 && impliedBases.every(x => x === impliedBases[0]),
    implied_base_values: impliedBases
  };
}


async function fetchOfficialDayEvents(dateIso = "2026-09-29") {
  const start = DateTime.fromISO(dateIso, { zone: EASTERN }).startOf("day").toUTC();
  const end = start.plus({ days: 1 });
  let cursor = encodeSearchCursor(end.toISO(), "");
  const rows = [];
  const seen = new Set();
  let pages = 0;
  let stoppedBecause = null;

  while (cursor && pages < 30) {
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

    let sawBeforeDay = false;

    for (const event of items) {
      const edt = DateTime.fromISO(event?.start_time || "", { setZone: true });
      if (!edt.isValid) continue;
      const utc = edt.toUTC();

      if (utc < start) {
        sawBeforeDay = true;
        continue;
      }
      if (utc >= end) continue;

      const pubs = Array.isArray(event?.publishers) ? event.publishers : [];
      for (const pub of pubs) {
        const broadcasts = Array.isArray(pub?.broadcasts) ? pub.broadcasts : [];

        if (!broadcasts.length) {
          const key = [event?.key || "", pub?.slug || "", event?.start_time || ""].join("|");
          if (!seen.has(key)) {
            seen.add(key);
            rows.push({
              event_key: event?.key || null,
              event_title: event?.title || null,
              sport: event?.sport || null,
              official_start: event?.start_time || null,
              broadcast_subheadline: null,
              publisher_slug: pub?.slug || null,
              association: pub?.state_association_acronym || null
            });
          }
          continue;
        }

        for (const b of broadcasts) {
          const bdt = DateTime.fromISO(b?.start_time || event?.start_time || "", { setZone: true });
          if (!bdt.isValid) continue;
          const butc = bdt.toUTC();
          if (butc < start || butc >= end) continue;

          const key = [event?.key || "", b?.key || "", b?.start_time || event?.start_time || ""].join("|");
          if (seen.has(key)) continue;
          seen.add(key);

          rows.push({
            event_key: event?.key || null,
            event_title: event?.title || null,
            sport: event?.sport || null,
            official_start: b?.start_time || event?.start_time || null,
            broadcast_subheadline: b?.subheadline || null,
            publisher_slug: pub?.slug || null,
            association: pub?.state_association_acronym || null,
            broadcast_key_hash: sha20(b?.key)
          });
        }
      }
    }

    if (sawBeforeDay) {
      stoppedBecause = "passed_start_of_day";
      break;
    }

    cursor = data?.cursor || null;
    if (!cursor) {
      stoppedBecause = "no_cursor";
      break;
    }
  }

  rows.sort((a, b) =>
    String(a.official_start || "").localeCompare(String(b.official_start || "")) ||
    String(a.event_key || "").localeCompare(String(b.event_key || ""))
  );

  return {
    date: dateIso,
    pages_fetched: pages,
    stopped_because: stoppedBecause,
    row_count: rows.length,
    rows
  };
}

function scoreProviderAgainstDayEvent(providerRow, cand) {
  const core = providerCore(providerRow.provider_title || "");
  const providerSport = providerSportFromTitle(providerRow.provider_title || "");

  const textOptions = [
    cand.broadcast_subheadline,
    cand.event_title,
    [cand.publisher_slug, cand.broadcast_subheadline].filter(Boolean).join(" ")
  ].filter(Boolean);

  const textScore = Math.max(0, ...textOptions.map(t => similarity(core, t)));
  const sportMatch = sportEqual(providerSport, cand.sport);

  let score = textScore * 10;
  if (sportMatch === true) score += 3;
  else if (sportMatch === false) score -= 5;
  if (textScore >= 0.96) score += 4;
  else if (textScore >= 0.90) score += 2;

  return {
    ...cand,
    text_score: Number(textScore.toFixed(4)),
    provider_sport: providerSport,
    sport_match: sportMatch,
    score: Number(score.toFixed(4))
  };
}

async function probeSameDayProviderOnlyMatches(providerOnlyRows) {
  const day = await fetchOfficialDayEvents("2026-09-29");
  const results = [];

  for (const p of providerOnlyRows || []) {
    const scored = day.rows
      .map(c => scoreProviderAgainstDayEvent(p, c))
      .sort((a, b) =>
        b.score - a.score ||
        String(a.official_start || "").localeCompare(String(b.official_start || ""))
      );

    const best = scored[0] || null;
    const second = scored[1] || null;
    const strong = Boolean(best) &&
      best.text_score >= 0.90 &&
      best.sport_match !== false;

    const ambiguous = Boolean(
      strong &&
      second &&
      second.text_score >= 0.90 &&
      second.sport_match !== false &&
      Math.abs(best.score - second.score) < 0.001 &&
      second.event_key !== best.event_key
    );

    results.push({
      provider_nfhs_number: p.provider_nfhs_number,
      stream_id: p.stream_id,
      provider_title: p.provider_title,
      strong_same_day_match: strong && !ambiguous,
      ambiguous_same_day_match: ambiguous,
      best_match: best ? {
        event_key: best.event_key,
        official_start: best.official_start,
        sport: best.sport,
        subheadline: best.broadcast_subheadline,
        publisher_slug: best.publisher_slug,
        association: best.association,
        text_score: best.text_score,
        sport_match: best.sport_match
      } : null,
      second_match: second ? {
        event_key: second.event_key,
        official_start: second.official_start,
        sport: second.sport,
        subheadline: second.broadcast_subheadline,
        publisher_slug: second.publisher_slug,
        association: second.association,
        text_score: second.text_score,
        sport_match: second.sport_match
      } : null
    });
  }

  const strongRows = results.filter(x => x.strong_same_day_match && x.best_match);
  const timeHistogram = {};

  for (const row of strongRows) {
    const dt = DateTime.fromISO(row.best_match.official_start || "", { setZone: true }).setZone(EASTERN);
    const label = dt.isValid ? dt.toFormat("HH:mm") : "unknown";
    timeHistogram[label] = (timeHistogram[label] || 0) + 1;
  }

  return {
    purpose:
      "Match the provider-only/stale 4 PM titles against the complete Sep 29 NFHS event day, avoiding false matches to other dates.",
    day_rows_loaded: day.row_count,
    day_pages_fetched: day.pages_fetched,
    day_stop_reason: day.stopped_because,
    provider_only_rows_tested: results.length,
    strong_unambiguous_same_day_matches: strongRows.length,
    ambiguous_same_day_matches: results.filter(x => x.ambiguous_same_day_match).length,
    unresolved_same_day: results.filter(x => !x.strong_same_day_match && !x.ambiguous_same_day_match).length,
    official_time_histogram_eastern: timeHistogram,
    rows: results
  };
}


function strictMatchupKey(text = "") {
  const cleaned = cleanSpace(
    String(text)
      .replace(/^NFHS\s+Network\s+\d+\s*:\s*/i, "")
      .replace(/\s+@\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*ET\s*$/i, "")
      .replace(/\b(?:Junior Varsity|Varsity|Freshman|Middle School|JV|MS)\b/gi, " ")
      .replace(/\b(?:Girls|Boys|Coed)\b/gi, " ")
      .replace(/\b(?:Flag Football|Football|Volleyball|Basketball|Baseball|Softball|Soccer|Wrestling|Lacrosse|Field Hockey|Ice Hockey|Hockey|Tennis|Swimming|Track(?: and Field)?|Cross Country|Golf|Badminton|Cheerleading|Assembly|Sports Show|News)\b/gi, " ")
      .replace(/\bHigh School\b/gi, " ")
      .replace(/\bMiddle School\b/gi, " ")
      .replace(/\bSchool\b/gi, " ")
      .replace(/\s+/g, " ")
  );

  const sides = cleaned
    .split(/\s+vs\.?\s+|\s+versus\s+/i)
    .map(normalize)
    .filter(Boolean);

  if (sides.length >= 2) {
    return sides.slice(0, 2).sort().join(" || ");
  }

  return normalize(cleaned);
}

async function probeAllFourPmTitlesAgainstFullDay(providerStreams) {
  const day = await fetchOfficialDayEvents("2026-09-29");
  const targetMillis = DateTime.fromISO("2026-09-29T20:00:00.000Z", { setZone: true }).toMillis();

  const provider4pm = providerStreams
    .filter(x => {
      const dt = DateTime.fromISO(x.provider_start || "", { setZone: true });
      return dt.isValid && dt.toUTC().toMillis() === targetMillis;
    })
    .sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number);

  const officialIndex = new Map();

  for (const row of day.rows) {
    const sportKey = normalize(row.sport || "");
    const titleCandidates = [row.broadcast_subheadline, row.event_title].filter(Boolean);

    for (const title of titleCandidates) {
      const matchupKey = strictMatchupKey(title);
      if (!matchupKey) continue;
      const key = `${sportKey}::${matchupKey}`;
      if (!officialIndex.has(key)) officialIndex.set(key, []);
      officialIndex.get(key).push(row);
    }
  }

  const rows = provider4pm.map(p => {
    const providerSport = providerSportFromTitle(p.title || "");
    const matchupKey = strictMatchupKey(p.title || "");
    const key = `${normalize(providerSport || "")}::${matchupKey}`;
    const candidates = [...new Map(
      (officialIndex.get(key) || []).map(x => [
        [x.event_key, x.official_start, x.publisher_slug].join("|"),
        x
      ])
    ).values()];

    const unique = candidates.length === 1;
    const candidate = unique ? candidates[0] : null;

    return {
      provider_nfhs_number: p.provider_nfhs_number,
      stream_id: p.stream_id,
      provider_title: p.title,
      provider_sport: providerSport,
      strict_matchup_key_hash: sha20(matchupKey),
      unique_strict_same_day_match: unique,
      candidate_count: candidates.length,
      official_match: candidate ? {
        event_key: candidate.event_key,
        official_start: candidate.official_start,
        sport: candidate.sport,
        subheadline: candidate.broadcast_subheadline,
        publisher_slug: candidate.publisher_slug,
        association: candidate.association
      } : null,
      ambiguous_candidates: unique ? [] : candidates.slice(0, 8).map(x => ({
        event_key: x.event_key,
        official_start: x.official_start,
        sport: x.sport,
        subheadline: x.broadcast_subheadline,
        publisher_slug: x.publisher_slug,
        association: x.association
      }))
    };
  });

  const matched = rows.filter(x => x.unique_strict_same_day_match && x.official_match);
  const actualTimeHistogram = {};
  const afterFour = [];
  const georgia = [];

  for (const row of matched) {
    const dt = DateTime.fromISO(row.official_match.official_start || "", { setZone: true }).setZone(EASTERN);
    const timeLabel = dt.isValid ? dt.toFormat("HH:mm") : "unknown";
    actualTimeHistogram[timeLabel] = (actualTimeHistogram[timeLabel] || 0) + 1;

    if (dt.isValid && dt.toUTC().toMillis() > targetMillis) {
      afterFour.push({
        provider_nfhs_number: row.provider_nfhs_number,
        event_key: row.official_match.event_key,
        actual_start_eastern: dt.toISO(),
        association: row.official_match.association,
        publisher_slug: row.official_match.publisher_slug,
        subheadline: row.official_match.subheadline,
        sport: row.official_match.sport
      });
    }

    if (
      row.official_match.association === "GHSA" ||
      /-ga(?:$|-)/i.test(row.official_match.publisher_slug || "")
    ) {
      georgia.push({
        provider_nfhs_number: row.provider_nfhs_number,
        event_key: row.official_match.event_key,
        actual_start_eastern: dt.isValid ? dt.toISO() : row.official_match.official_start,
        association: row.official_match.association,
        publisher_slug: row.official_match.publisher_slug,
        subheadline: row.official_match.subheadline,
        sport: row.official_match.sport
      });
    }
  }

  afterFour.sort((a, b) =>
    String(a.actual_start_eastern).localeCompare(String(b.actual_start_eastern)) ||
    a.provider_nfhs_number - b.provider_nfhs_number
  );

  georgia.sort((a, b) =>
    String(a.actual_start_eastern).localeCompare(String(b.actual_start_eastern)) ||
    a.provider_nfhs_number - b.provider_nfhs_number
  );

  return {
    purpose:
      "Strictly match every provider title stamped 4:00 PM against the complete Sep 29 NFHS day using normalized matchup plus sport, ignoring the provider's displayed time.",
    provider_4pm_title_count: provider4pm.length,
    official_day_rows_loaded: day.row_count,
    unique_strict_same_day_matches: matched.length,
    ambiguous_or_unmatched: rows.length - matched.length,
    unique_matches_actually_after_4pm: afterFour.length,
    actual_time_histogram_eastern: actualTimeHistogram,
    georgia_unique_matches: georgia.length,
    georgia_rows: georgia,
    after_4pm_rows: afterFour,
    rows
  };
}


function isGeorgiaOfficialRow(row) {
  const assoc = String(row?.association || "").toUpperCase();
  const slug = String(row?.publisher_slug || "").toLowerCase();
  return ["GHSA", "GIAA", "GAPPS"].includes(assoc) || /-ga(?:$|-)/i.test(slug);
}

function safeSourceSignature(unity) {
  if (!unity || unity.error) return null;
  const parts = [
    sha20(unity.publisher_key),
    sha20(unity.producer_key),
    unity.ingest_point_fingerprint || null
  ];
  if (!parts.some(Boolean)) return null;
  return parts.map(x => x || "-").join("|");
}

async function probeGeorgiaSourceLaneMappings(providerStreams) {
  const day = await fetchOfficialDayEvents("2026-09-29");
  const strictIndex = new Map();

  for (const row of day.rows) {
    const sportKey = normalize(row.sport || "");
    const titleCandidates = [row.broadcast_subheadline, row.event_title].filter(Boolean);

    for (const title of titleCandidates) {
      const matchupKey = strictMatchupKey(title);
      if (!matchupKey) continue;
      const key = `${sportKey}::${matchupKey}`;
      if (!strictIndex.has(key)) strictIndex.set(key, []);
      strictIndex.get(key).push(row);
    }
  }

  const direct = [];

  for (const p of providerStreams) {
    const providerSport = providerSportFromTitle(p.title || "");
    if (!providerSport) continue;
    const matchupKey = strictMatchupKey(p.title || "");
    if (!matchupKey) continue;

    const key = `${normalize(providerSport)}::${matchupKey}`;
    const candidates = [...new Map(
      (strictIndex.get(key) || []).map(x => [
        [x.event_key, x.official_start, x.publisher_slug].join("|"),
        x
      ])
    ).values()];

    if (candidates.length !== 1) continue;
    const hit = candidates[0];
    if (!isGeorgiaOfficialRow(hit)) continue;

    direct.push({
      provider_nfhs_number: p.provider_nfhs_number,
      stream_id: p.stream_id,
      provider_title: p.title,
      event_key: hit.event_key,
      official_start: hit.official_start,
      sport: hit.sport,
      subheadline: hit.broadcast_subheadline,
      publisher_slug: hit.publisher_slug,
      association: hit.association
    });
  }

  const gaRowsRaw = day.rows.filter(isGeorgiaOfficialRow);
  const gaMap = new Map();

  for (const row of gaRowsRaw) {
    const key = [row.event_key, row.official_start, row.publisher_slug, row.broadcast_subheadline].join("|");
    if (!gaMap.has(key)) gaMap.set(key, row);
  }
  const gaRows = [...gaMap.values()];

  const eventIds = [...new Set([
    ...gaRows.map(x => x.event_key),
    ...direct.map(x => x.event_key)
  ].filter(Boolean))];

  const unityByEvent = new Map();
  for (const eventId of eventIds) {
    unityByEvent.set(eventId, await enrichUnity({ event_key: eventId }));
  }

  const directWithSource = direct.map(x => {
    const unity = unityByEvent.get(x.event_key);
    return {
      ...x,
      source_signature_hash: sha20(safeSourceSignature(unity)),
      source: unity && !unity.error ? {
        publisher_key_hash: sha20(unity.publisher_key),
        producer_key_hash: sha20(unity.producer_key),
        ingest_point_fingerprint: unity.ingest_point_fingerprint || null
      } : null
    };
  });

  const slotsBySource = new Map();
  for (const row of directWithSource) {
    if (!row.source_signature_hash) continue;
    if (!slotsBySource.has(row.source_signature_hash)) slotsBySource.set(row.source_signature_hash, new Set());
    slotsBySource.get(row.source_signature_hash).add(row.provider_nfhs_number);
  }

  const gaEvents = gaRows.map(row => {
    const unity = unityByEvent.get(row.event_key);
    const sigHash = sha20(safeSourceSignature(unity));
    const candidateSlots = sigHash && slotsBySource.has(sigHash)
      ? [...slotsBySource.get(sigHash)].sort((a, b) => a - b)
      : [];

    const dt = DateTime.fromISO(row.official_start || "", { setZone: true }).setZone(EASTERN);

    return {
      event_key: row.event_key,
      official_start_eastern: dt.isValid ? dt.toISO() : row.official_start,
      sport: row.sport,
      subheadline: row.broadcast_subheadline,
      publisher_slug: row.publisher_slug,
      association: row.association,
      source_signature_hash: sigHash,
      source: unity && !unity.error ? {
        publisher_key_hash: sha20(unity.publisher_key),
        producer_key_hash: sha20(unity.producer_key),
        ingest_point_fingerprint: unity.ingest_point_fingerprint || null
      } : null,
      direct_provider_slots: directWithSource
        .filter(x => x.event_key === row.event_key)
        .map(x => x.provider_nfhs_number)
        .sort((a, b) => a - b),
      same_source_candidate_slots: candidateSlots
    };
  });

  const afterFourMillis = DateTime.fromISO("2026-09-29T20:00:00.000Z", { setZone: true }).toMillis();
  const afterFour = gaEvents.filter(x => {
    const dt = DateTime.fromISO(x.official_start_eastern || "", { setZone: true });
    return dt.isValid && dt.toUTC().toMillis() > afterFourMillis;
  });

  const afterFourWithLane = afterFour.filter(x => x.same_source_candidate_slots.length === 1);
  const afterFourDirect = afterFour.filter(x => x.direct_provider_slots.length > 0);

  const brantleyTextHits = providerStreams
    .filter(x => /\b(?:brantley county|clinch county)\b/i.test(x.title || ""))
    .map(x => ({
      provider_nfhs_number: x.provider_nfhs_number,
      stream_id: x.stream_id,
      provider_title: x.title
    }));

  const brantleyEvents = gaEvents.filter(x =>
    /brantley-county-high-school/i.test(x.publisher_slug || "") ||
    /\b(?:brantley county|clinch county)\b/i.test(x.subheadline || "")
  );

  return {
    purpose:
      "Build Georgia event-to-provider source-lane hypotheses by finding exact same-day Georgia title matches anywhere in the provider's 5,000 NFHS streams, enriching official events through Unity, and propagating only identical hashed publisher+producer+ingest signatures. Same-source slots are hypotheses until independently validated.",
    provider_streams_scanned: providerStreams.length,
    official_day_rows_loaded: day.row_count,
    georgia_official_rows: gaEvents.length,
    direct_unique_georgia_provider_matches: directWithSource.length,
    unique_source_signatures_with_direct_provider_anchor: slotsBySource.size,
    georgia_after_4pm_events: afterFour.length,
    georgia_after_4pm_direct_matches: afterFourDirect.length,
    georgia_after_4pm_with_single_same_source_candidate_slot: afterFourWithLane.length,
    brantley_or_clinch_provider_title_hits: brantleyTextHits,
    brantley_clinch_official_events: brantleyEvents,
    direct_matches: directWithSource,
    after_4pm_single_lane_candidates: afterFourWithLane,
    georgia_events: gaEvents
  };
}


async function probeWoodlawnRandallstownSequence() {
  const terms = ["Randallstown Woodlawn", "Woodlawn High School", "Randallstown High School"];
  const candidateMap = new Map();

  for (const term of terms) {
    try {
      const search = await fetchJson(
        `${SEARCH_BASE}/v3/search/events?search_term=${encodeURIComponent(term)}&size=100`,
        30000
      );
      for (const item of flattenSearchItems(search?.items || [])) {
        const start = item.broadcast_start || item.event_start || "";
        if (!String(start).startsWith("2026-09-29")) continue;

        const text = [
          item.broadcast_subheadline,
          item.event_title,
          item.publisher_name,
          item.publisher_slug
        ].filter(Boolean).join(" ");

        if (!/randallstown|woodlawn/i.test(text)) continue;

        const key = [
          item.event_key || "",
          item.broadcast_key || "",
          start,
          item.publisher_slug || ""
        ].join("|");

        candidateMap.set(key, item);
      }
    } catch {}
  }

  const rows = [...candidateMap.values()]
    .sort((a, b) =>
      String(a.broadcast_start || a.event_start || "").localeCompare(
        String(b.broadcast_start || b.event_start || "")
      )
    );

  const enriched = [];
  for (const row of rows) {
    const unity = await enrichUnity(row);
    enriched.push({
      event_key: row.event_key,
      official_start: row.broadcast_start || row.event_start || null,
      sport: row.sport || null,
      subheadline: row.broadcast_subheadline || null,
      publisher_slug: row.publisher_slug || null,
      association: row.association || null,
      source_signature_hash: sha20(safeSourceSignature(unity)),
      source: unity && !unity.error ? {
        publisher_key_hash: sha20(unity.publisher_key),
        producer_key_hash: sha20(unity.producer_key),
        ingest_point_fingerprint: unity.ingest_point_fingerprint || null
      } : null
    });
  }

  const staleBadminton = enriched.find(x => x.event_key === "gamb8ebe375ea") || null;
  const clinch4 = {
    event_key: "gamb8ad8195a3",
    source_signature_hash: "75779017803d94b73a82"
  };
  const clinch5 = {
    event_key: "gamc34e8e3bfe",
    source_signature_hash: "75779017803d94b73a82"
  };

  const sameSourceAsBadminton = staleBadminton
    ? enriched.filter(x =>
        x.event_key !== staleBadminton.event_key &&
        x.source_signature_hash &&
        x.source_signature_hash === staleBadminton.source_signature_hash
      )
    : [];

  const volleyballRows = enriched.filter(x =>
    String(x.sport || "").toLowerCase() === "volleyball"
  );

  const laterVolleyballRows = volleyballRows.filter(x => {
    const dt = DateTime.fromISO(x.official_start || "", { setZone: true }).setZone(EASTERN);
    return dt.isValid && dt.hour >= 16;
  });

  return {
    purpose:
      "Check whether provider slot 3552's stale Randallstown/Woodlawn badminton title could have stayed on a Woodlawn/Randallstown source that later carried girls volleyball, instead of carrying Clinch/Brantley. This is a targeted falsification test.",
    search_terms: terms,
    matching_sep29_events: enriched.length,
    stale_badminton_event: staleBadminton,
    same_source_as_stale_badminton: sameSourceAsBadminton,
    sep29_volleyball_events: volleyballRows,
    sep29_later_volleyball_events: laterVolleyballRows,
    stale_badminton_source_matches_clinch_4pm:
      Boolean(staleBadminton?.source_signature_hash) &&
      staleBadminton.source_signature_hash === clinch4.source_signature_hash,
    stale_badminton_source_matches_clinch_5pm:
      Boolean(staleBadminton?.source_signature_hash) &&
      staleBadminton.source_signature_hash === clinch5.source_signature_hash,
    rows: enriched
  };
}


async function probeGlobalDayOrdering(providerStreams) {
  const day = await fetchOfficialDayEvents("2026-09-29");

  // One canonical row per official event/start. Prefer a row with a broadcast subheadline.
  const canonical = new Map();
  for (const row of day.rows) {
    const k = [row.event_key || "", row.official_start || ""].join("|");
    const existing = canonical.get(k);
    if (!existing || (!existing.broadcast_subheadline && row.broadcast_subheadline)) {
      canonical.set(k, row);
    }
  }

  const official = [...canonical.values()].sort((a, b) =>
    String(a.official_start || "").localeCompare(String(b.official_start || "")) ||
    String(a.event_key || "").localeCompare(String(b.event_key || ""))
  );
  official.forEach((x, i) => { x.global_day_rank = i; });

  const strictIndex = new Map();
  for (const row of official) {
    const sportKey = normalize(row.sport || "");
    for (const title of [row.broadcast_subheadline, row.event_title].filter(Boolean)) {
      const matchupKey = strictMatchupKey(title);
      if (!matchupKey) continue;
      const key = `${sportKey}::${matchupKey}`;
      if (!strictIndex.has(key)) strictIndex.set(key, []);
      strictIndex.get(key).push(row);
    }
  }

  const direct = [];
  for (const p of providerStreams) {
    const sport = providerSportFromTitle(p.title || "");
    if (!sport) continue;
    const matchupKey = strictMatchupKey(p.title || "");
    if (!matchupKey) continue;

    const key = `${normalize(sport)}::${matchupKey}`;
    const candidates = [...new Map(
      (strictIndex.get(key) || []).map(x => [
        [x.event_key, x.official_start].join("|"),
        x
      ])
    ).values()];

    if (candidates.length !== 1) continue;
    const hit = candidates[0];

    direct.push({
      provider_nfhs_number: p.provider_nfhs_number,
      stream_id: p.stream_id,
      provider_title: p.title,
      event_key: hit.event_key,
      official_start: hit.official_start,
      global_day_rank: hit.global_day_rank,
      sport: hit.sport,
      subheadline: hit.broadcast_subheadline,
      publisher_slug: hit.publisher_slug,
      association: hit.association
    });
  }

  // Deduplicate anchors by official event, preferring the lowest provider number when duplicates exist.
  const eventAnchor = new Map();
  for (const row of direct) {
    const cur = eventAnchor.get(row.event_key);
    if (!cur || row.provider_nfhs_number < cur.provider_nfhs_number) {
      eventAnchor.set(row.event_key, row);
    }
  }
  const anchors = [...eventAnchor.values()].sort((a, b) => a.global_day_rank - b.global_day_rank);

  let monotonicPairs = 0;
  let pairCount = 0;
  for (let i = 1; i < anchors.length; i++) {
    pairCount++;
    if (anchors[i].provider_nfhs_number > anchors[i - 1].provider_nfhs_number) monotonicPairs++;
  }

  const targets = [
    { label: "clinch_brantley_4pm", event_key: "gamb8ad8195a3" },
    { label: "clinch_brantley_5pm", event_key: "gamc34e8e3bfe" }
  ];

  const targetResults = targets.map(t => {
    const event = official.find(x => x.event_key === t.event_key) || null;
    if (!event) return { ...t, found: false };

    const before = [...anchors]
      .filter(x => x.global_day_rank < event.global_day_rank)
      .sort((a, b) => b.global_day_rank - a.global_day_rank)[0] || null;

    const after = [...anchors]
      .filter(x => x.global_day_rank > event.global_day_rank)
      .sort((a, b) => a.global_day_rank - b.global_day_rank)[0] || null;

    let interpolation = null;
    if (before && after) {
      const providerGap = after.provider_nfhs_number - before.provider_nfhs_number;
      const rankGap = after.global_day_rank - before.global_day_rank;
      const targetDelta = event.global_day_rank - before.global_day_rank;
      const exactLinearGap = providerGap === rankGap;

      interpolation = {
        before_anchor: {
          provider_nfhs_number: before.provider_nfhs_number,
          event_key: before.event_key,
          official_start: before.official_start,
          global_day_rank: before.global_day_rank
        },
        after_anchor: {
          provider_nfhs_number: after.provider_nfhs_number,
          event_key: after.event_key,
          official_start: after.official_start,
          global_day_rank: after.global_day_rank
        },
        provider_gap: providerGap,
        official_rank_gap: rankGap,
        exact_linear_gap: exactLinearGap,
        predicted_provider_slot_if_linear:
          exactLinearGap ? before.provider_nfhs_number + targetDelta : null
      };
    }

    return {
      ...t,
      found: true,
      official_start: event.official_start,
      global_day_rank: event.global_day_rank,
      interpolation
    };
  });

  // Also inspect only anchors in a narrow time window around each target.
  const targetWindows = targetResults.map(t => {
    if (!t.found) return { label: t.label, anchors: [] };
    const target = DateTime.fromISO(t.official_start || "", { setZone: true }).toUTC();
    const rows = anchors.filter(a => {
      const dt = DateTime.fromISO(a.official_start || "", { setZone: true }).toUTC();
      return dt.isValid && Math.abs(dt.diff(target, "minutes").minutes) <= 20;
    });
    return {
      label: t.label,
      target_start: t.official_start,
      anchors: rows.slice(0, 80)
    };
  });

  return {
    purpose:
      "Strictly match all 5,000 provider titles to unique Sep 29 NFHS events, compare provider numbering to the full official day order, and bracket the two Clinch/Brantley events with independent exact-title anchors.",
    official_unique_events: official.length,
    provider_streams_scanned: providerStreams.length,
    direct_unique_strict_matches: direct.length,
    unique_official_event_anchors: anchors.length,
    adjacent_anchor_pairs: pairCount,
    adjacent_anchor_provider_number_increases: monotonicPairs,
    adjacent_anchor_monotonic_percent:
      pairCount ? Number((monotonicPairs / pairCount * 100).toFixed(2)) : null,
    target_results: targetResults,
    target_time_windows: targetWindows
  };
}


function maybeDecodeProviderText(value) {
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  if (!s) return null;

  // Xtream providers often base64-encode EPG title/description.
  if (/^[A-Za-z0-9+/=]+$/.test(s) && s.length >= 8 && s.length % 4 === 0) {
    try {
      const decoded = Buffer.from(s, "base64").toString("utf8").trim();
      if (decoded && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded)) {
        return decoded;
      }
    } catch {}
  }

  return s;
}

function compactEpgListings(payload) {
  const list =
    (Array.isArray(payload?.epg_listings) && payload.epg_listings) ||
    (Array.isArray(payload?.epg_data) && payload.epg_data) ||
    (Array.isArray(payload) && payload) ||
    [];

  return list.slice(0, 40).map(x => ({
    id: x?.id ?? null,
    epg_id: x?.epg_id ?? null,
    channel_id: x?.channel_id ?? null,
    title: maybeDecodeProviderText(x?.title),
    description: maybeDecodeProviderText(x?.description),
    start: x?.start ?? null,
    end: x?.end ?? null,
    start_timestamp: x?.start_timestamp ?? null,
    stop_timestamp: x?.stop_timestamp ?? null,
    now_playing: x?.now_playing ?? null,
    has_archive: x?.has_archive ?? null
  }));
}

async function probeProviderEpgMetadata(provider) {
  const controlNumbers = [
    3549, 3550, 3551, 3552, 3553, 3554, 3555, 3556, 3557, 3558,
    3572, 3536, 3523
  ];

  const rows = [];

  for (const n of controlNumbers) {
    const stream = provider.streams.find(x => x.provider_nfhs_number === n);
    if (!stream) {
      rows.push({ provider_nfhs_number: n, error: "Provider slot not found." });
      continue;
    }

    const endpoints = {};
    for (const action of ["get_short_epg", "get_simple_data_table"]) {
      try {
        const url =
          `${provider.base}/player_api.php?${provider.auth}&action=${action}&stream_id=${encodeURIComponent(stream.stream_id)}&limit=40`;
        const data = await fetchJson(url, 30000);

        endpoints[action] = {
          ok: true,
          top_level_keys:
            data && typeof data === "object" && !Array.isArray(data)
              ? Object.keys(data).sort()
              : [],
          listings: compactEpgListings(data)
        };
      } catch (err) {
        endpoints[action] = {
          ok: false,
          error: String(err?.message || err).slice(0, 300)
        };
      }
    }

    rows.push({
      provider_nfhs_number: n,
      stream_id: stream.stream_id,
      provider_title: stream.title,
      provider_metadata: {
        epg_channel_id: stream.epg_channel_id,
        custom_sid: stream.custom_sid,
        tv_archive: stream.tv_archive,
        tv_archive_duration: stream.tv_archive_duration,
        container_extension: stream.container_extension,
        has_direct_source: stream.has_direct_source,
        direct_source_hash: stream.direct_source_hash
      },
      endpoints
    });
  }

  const clinchTerms = /clinch county|brantley county/i;
  const clinchMentions = [];

  for (const row of rows) {
    for (const [action, result] of Object.entries(row.endpoints || {})) {
      for (const listing of result?.listings || []) {
        const text = [listing.title, listing.description].filter(Boolean).join(" ");
        if (clinchTerms.test(text)) {
          clinchMentions.push({
            provider_nfhs_number: row.provider_nfhs_number,
            action,
            ...listing
          });
        }
      }
    }
  }

  return {
    purpose:
      "Inspect Xtream EPG metadata for the Clinch neighborhood and known stale-title controls. This uses only the user's authorized provider metadata APIs and never writes provider credentials or raw source URLs.",
    controls_tested: rows.length,
    clinch_or_brantley_epg_mentions: clinchMentions,
    rows
  };
}


function parseExtinfAttributes(line = "") {
  const attrs = {};
  const re = /([A-Za-z0-9_-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(line))) attrs[m[1]] = m[2];

  const comma = line.indexOf(",");
  const displayName = comma >= 0 ? cleanSpace(line.slice(comma + 1)) : "";

  return { attrs, displayName };
}

function safePlaylistAttrValue(key, value) {
  if (value === null || value === undefined || value === "") return value ?? null;
  const s = String(value);

  if (/url|logo|source|icon/i.test(key) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return {
        is_url: true,
        hostname_hash: sha20(u.hostname),
        pathname_hash: sha20(u.pathname),
        path_segment_hashes: u.pathname.split("/").filter(Boolean).map(sha20),
        query_keys: [...u.searchParams.keys()].sort()
      };
    } catch {
      return { value_hash: sha20(s) };
    }
  }

  return s;
}

async function probeProviderPlaylistMetadata(provider) {
  const url =
    `${provider.base}/get.php?${provider.auth}&type=m3u_plus&output=ts`;

  let text = "";
  try {
    text = await fetchText(url, 60000);
  } catch (err) {
    return {
      purpose:
        "Inspect authorized provider M3U metadata for identifiers not exposed by player_api.php. Raw playlist URLs and credentials are never written.",
      ok: false,
      error: String(err?.message || err).slice(0, 400)
    };
  }

  const lines = text.split(/\r?\n/);
  const rows = [];
  let pending = null;

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      pending = parseExtinfAttributes(line);
      continue;
    }

    if (!pending || !line || line.startsWith("#")) continue;

    const n = providerNumber(pending.displayName || "");
    if (n !== null) {
      const safeAttrs = {};
      for (const [k, v] of Object.entries(pending.attrs || {})) {
        safeAttrs[k] = safePlaylistAttrValue(k, v);
      }

      let streamId = null;
      try {
        const u = new URL(line);
        const segs = u.pathname.split("/").filter(Boolean);
        const last = segs.at(-1) || "";
        const m = last.match(/^(\d+)(?:\.[A-Za-z0-9]+)?$/);
        if (m) streamId = Number(m[1]);
      } catch {}

      rows.push({
        provider_nfhs_number: n,
        stream_id: streamId,
        display_name: pending.displayName,
        attrs: safeAttrs
      });
    }

    pending = null;
  }

  const targetNumbers = new Set([
    3549, 3550, 3551, 3552, 3553, 3554, 3555, 3556, 3557, 3558,
    3572, 3536, 3523
  ]);

  const targetRows = rows.filter(x => targetNumbers.has(x.provider_nfhs_number));

  const attrKeyCounts = {};
  const nonEmptyAttrKeyCounts = {};
  const clinchMentions = [];
  const interestingIdentifierRows = [];

  for (const row of rows) {
    for (const [k, v] of Object.entries(row.attrs || {})) {
      attrKeyCounts[k] = (attrKeyCounts[k] || 0) + 1;
      const nonEmpty =
        v !== null &&
        v !== "" &&
        !(typeof v === "object" && Object.keys(v).length === 0);
      if (nonEmpty) nonEmptyAttrKeyCounts[k] = (nonEmptyAttrKeyCounts[k] || 0) + 1;

      const rawText = typeof v === "string" ? v : "";
      if (/clinch county|brantley county/i.test(rawText)) {
        clinchMentions.push({
          provider_nfhs_number: row.provider_nfhs_number,
          stream_id: row.stream_id,
          attribute: k,
          value: rawText
        });
      }
    }

    const ids = {};
    for (const k of ["tvg-id", "channel-id", "tvg-chno", "tvg-name", "group-title"]) {
      const v = row.attrs?.[k];
      if (v !== undefined && v !== null && v !== "") ids[k] = v;
    }

    if (Object.keys(ids).length) {
      interestingIdentifierRows.push({
        provider_nfhs_number: row.provider_nfhs_number,
        stream_id: row.stream_id,
        identifiers: ids
      });
    }
  }

  const targetComparisons = [];
  for (let i = 1; i < targetRows.length; i++) {
    const a = targetRows[i - 1];
    const b = targetRows[i];
    const keys = [...new Set([
      ...Object.keys(a.attrs || {}),
      ...Object.keys(b.attrs || {})
    ])].sort();

    const same = [];
    const different = [];

    for (const k of keys) {
      const av = JSON.stringify(a.attrs?.[k] ?? null);
      const bv = JSON.stringify(b.attrs?.[k] ?? null);
      if (av === bv) same.push(k);
      else different.push(k);
    }

    targetComparisons.push({
      provider_a: a.provider_nfhs_number,
      provider_b: b.provider_nfhs_number,
      same_attribute_keys: same,
      different_attribute_keys: different
    });
  }

  return {
    purpose:
      "Inspect authorized provider M3U metadata for identifiers not exposed by player_api.php. Raw playlist URLs and credentials are never written.",
    ok: true,
    playlist_line_count: lines.length,
    nfhs_rows_found: rows.length,
    attribute_key_counts: attrKeyCounts,
    nonempty_attribute_key_counts: nonEmptyAttrKeyCounts,
    clinch_or_brantley_attribute_mentions: clinchMentions,
    target_rows: targetRows,
    target_attribute_comparisons: targetComparisons,
    identifier_rows_sample: interestingIdentifierRows.slice(0, 80)
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
  const providerOnlyResolution = await resolveProviderOnlyTitles(
    exactFourPmBlockProbe?.two_sided_sequence_alignment?.provider_only_rows || [],
    exactFourPmBlockProbe?.two_sided_sequence_alignment?.official_only_rows || []
  );
  const sameDayProviderOnlyResolution = summarizeSameDayProviderOnlyResolution(providerOnlyResolution);
  const brantleyClinchSequence = await probeBrantleyClinchSequence();
  const brantleySourceLineage = await probeBrantleySourceLineage();
  const clinchBroadcastRouting = await probeClinchBroadcastRouting();
  const officialPlaybackVsProviderRelay = await probeOfficialPlaybackVsProviderRelay(provider.streams);
  const fivePmSlotReuse = await probeFivePmSlotReuse();
  const sameDayProviderOnlyMatches = await probeSameDayProviderOnlyMatches(
    exactFourPmBlockProbe?.two_sided_sequence_alignment?.provider_only_rows || []
  );
  const allFourPmTitlesVsFullDay = await probeAllFourPmTitlesAgainstFullDay(provider.streams);
  const georgiaSourceLaneMappings = await probeGeorgiaSourceLaneMappings(provider.streams);
  const woodlawnRandallstownSequence = await probeWoodlawnRandallstownSequence();
  const globalDayOrdering = await probeGlobalDayOrdering(provider.streams);
  const providerEpgMetadata = await probeProviderEpgMetadata(provider);
  const providerPlaylistMetadata = await probeProviderPlaylistMetadata(provider);

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
    diagnostic_version: "deep-link-23",
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
    provider_only_resolution_probe: providerOnlyResolution,
    same_day_provider_only_resolution: sameDayProviderOnlyResolution,
    brantley_clinch_sequence_probe: brantleyClinchSequence,
    brantley_source_lineage_probe: brantleySourceLineage,
    clinch_broadcast_routing_probe: clinchBroadcastRouting,
    official_playback_vs_provider_relay_probe: officialPlaybackVsProviderRelay,
    five_pm_slot_reuse_probe: fivePmSlotReuse,
    same_day_provider_only_match_probe: sameDayProviderOnlyMatches,
    all_four_pm_titles_vs_full_day_probe: allFourPmTitlesVsFullDay,
    georgia_source_lane_mapping_probe: georgiaSourceLaneMappings,
    woodlawn_randallstown_sequence_probe: woodlawnRandallstownSequence,
    global_day_ordering_probe: globalDayOrdering,
    provider_epg_metadata_probe: providerEpgMetadata,
    provider_playlist_metadata_probe: providerPlaylistMetadata,
    official_start_groups_to_provider_numbers: byStart,
    rows
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile(
    "public/nfhs-deep-link-diagnostic.json",
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );

  const compactSummary = {
    generated_at: payload.generated_at,
    diagnostic_version: payload.diagnostic_version,
    diagnostic_only: true,
    modifies_epg: false,
    summary: payload.summary,
    all_four_pm_titles_vs_full_day_probe: {
      provider_4pm_title_count: allFourPmTitlesVsFullDay.provider_4pm_title_count,
      unique_strict_same_day_matches: allFourPmTitlesVsFullDay.unique_strict_same_day_matches,
      unique_matches_actually_after_4pm: allFourPmTitlesVsFullDay.unique_matches_actually_after_4pm,
      georgia_unique_matches: allFourPmTitlesVsFullDay.georgia_unique_matches,
      georgia_rows: allFourPmTitlesVsFullDay.georgia_rows,
      after_4pm_rows: allFourPmTitlesVsFullDay.after_4pm_rows
    },
    georgia_source_lane_mapping_probe: {
      provider_streams_scanned: georgiaSourceLaneMappings.provider_streams_scanned,
      georgia_official_rows: georgiaSourceLaneMappings.georgia_official_rows,
      direct_unique_georgia_provider_matches: georgiaSourceLaneMappings.direct_unique_georgia_provider_matches,
      unique_source_signatures_with_direct_provider_anchor:
        georgiaSourceLaneMappings.unique_source_signatures_with_direct_provider_anchor,
      georgia_after_4pm_events: georgiaSourceLaneMappings.georgia_after_4pm_events,
      georgia_after_4pm_direct_matches: georgiaSourceLaneMappings.georgia_after_4pm_direct_matches,
      georgia_after_4pm_with_single_same_source_candidate_slot:
        georgiaSourceLaneMappings.georgia_after_4pm_with_single_same_source_candidate_slot,
      brantley_or_clinch_provider_title_hits:
        georgiaSourceLaneMappings.brantley_or_clinch_provider_title_hits,
      brantley_clinch_official_events:
        georgiaSourceLaneMappings.brantley_clinch_official_events,
      direct_matches: georgiaSourceLaneMappings.direct_matches,
      after_4pm_single_lane_candidates:
        georgiaSourceLaneMappings.after_4pm_single_lane_candidates
    },
    woodlawn_randallstown_sequence_probe: woodlawnRandallstownSequence,
    global_day_ordering_probe: globalDayOrdering,
    provider_epg_metadata_probe: providerEpgMetadata,
    provider_playlist_metadata_probe: providerPlaylistMetadata
  };

  await fs.writeFile(
    "public/nfhs-deep-link-summary.json",
    JSON.stringify(compactSummary, null, 2) + "\n",
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
