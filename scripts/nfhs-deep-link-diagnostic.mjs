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

    let search;
    try {
      search = await fetchJson(
        `${SEARCH_BASE}/v3/search/events?search_term=${encodeURIComponent(p.core.split(/\s+/).slice(0, 4).join(" "))}&size=${SEARCH_SIZE}`
      );
    } catch (err) {
      rows.push({
        provider: p,
        search_ok: false,
        search_error: String(err?.message || err).slice(0, 300)
      });
      continue;
    }

    const candidates = flattenSearchItems(search?.items || []);
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
      search_item_count: Array.isArray(search?.items) ? search.items.length : 0,
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

  const payload = {
    generated_at: new Date().toISOString(),
    diagnostic_only: true,
    modifies_epg: false,
    diagnostic_version: "deep-link-3",
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
