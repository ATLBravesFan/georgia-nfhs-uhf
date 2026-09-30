import fs from "node:fs/promises";
import * as cheerio from "cheerio";

const DEFAULT_CATEGORY = "USA | NFHS Network";
const WATCH_URL = "https://get.nfhsnetwork.com/watch-events";

const STOP = new Set([
  "high","school","schools","academy","county","junior","senior","middle","elementary",
  "varsity","freshman","girls","boys","coed","the","and","vs","versus","at",
  "football","volleyball","basketball","softball","baseball","soccer","wrestling",
  "lacrosse","hockey","field","track","cross","country","golf","badminton",
  "cheerleading","assembly","sports","show","news","network"
]);

function cleanSpace(s = "") {
  return String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
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

function normalize(s = "") {
  return cleanSpace(s)
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/\bbp\.?\b/g, "bishop")
    .replace(/\bmount\b/g, "mt")
    .replace(/\bst\.?\b/g, "saint")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s = "") {
  return normalize(s)
    .split(" ")
    .filter(Boolean)
    .filter(w => w.length >= 3)
    .filter(w => !STOP.has(w))
    .filter(w => !/^\d+$/.test(w));
}

function officialCore(text = "") {
  let s = cleanSpace(text);

  // Remove displayed duration that sometimes prefixes on-demand titles.
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");

  // Remove date/time/location tail.
  s = s.replace(
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s*\|.*$/i,
    ""
  );

  // Remove duplicated sport labels that NFHS sometimes concatenates.
  s = s.replace(
    /^(?:(?:Junior Varsity|Varsity|Freshman|Middle School|JV|MS)\s*)?(?:(?:Girls|Boys|Coed)\s*)?(?:Flag Football|Football|Volleyball|Basketball|Baseball|Softball|Soccer|Wrestling|Lacrosse|Field Hockey|Ice Hockey|Hockey|Tennis|Swimming|Track(?: and Field)?|Cross Country|Golf|Badminton|Cheerleading|Assembly|Sports Show|News)\s*/i,
    ""
  );

  s = s.replace(
    /^(?:(?:Junior Varsity|Varsity|Freshman|Middle School|JV|MS)\s*)?(?:(?:Girls|Boys|Coed)\s*)?(?:Flag Football|Football|Volleyball|Basketball|Baseball|Softball|Soccer|Wrestling|Lacrosse|Field Hockey|Ice Hockey|Hockey|Tennis|Swimming|Track(?: and Field)?|Cross Country|Golf|Badminton|Cheerleading|Assembly|Sports Show|News)\s*/i,
    ""
  );

  return cleanSpace(s);
}

function similarity(a, b) {
  const aa = tokens(a);
  const bb = tokens(b);

  if (!aa.length || !bb.length) {
    return { score: 0, overlap: [], a_tokens: aa, b_tokens: bb };
  }

  const A = new Set(aa);
  const B = new Set(bb);
  const overlap = [...A].filter(x => B.has(x));
  const union = new Set([...A, ...B]);

  const coverage = overlap.length / Math.min(A.size, B.size);
  const jaccard = overlap.length / union.size;

  const na = normalize(a);
  const nb = normalize(b);
  const substring = na.length >= 5 && nb.length >= 5 && (na.includes(nb) || nb.includes(na));

  let score = 0.65 * coverage + 0.35 * jaccard;
  if (substring) score = Math.max(score, 0.97);

  // One distinctive exact token can be useful, but cap it below "strong".
  if (overlap.length === 1 && Math.min(A.size, B.size) === 1) {
    score = Math.min(score, 0.68);
  }

  return {
    score: Number(score.toFixed(4)),
    overlap,
    a_tokens: aa,
    b_tokens: bb
  };
}

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 Georgia-NFHS-Sequence-Diagnostic/1.0" }
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

  if (!category) {
    category = categories.find(c => /nfhs/i.test(String(c.category_name || "")));
  }

  if (!category) throw new Error("Could not find NFHS category.");

  let streams = await fetchJson(
    `${base}/player_api.php?${auth}&action=get_live_streams&category_id=${encodeURIComponent(category.category_id)}`
  );

  if (!Array.isArray(streams)) {
    throw new Error("Provider live stream response was not an array.");
  }

  streams = streams
    .filter(s => providerNumber(s.name || "") !== null)
    .map(s => ({
      provider_nfhs_number: providerNumber(s.name || ""),
      stream_id: Number(s.stream_id),
      added: Number(s.added || 0) || null,
      title: cleanSpace(s.name || ""),
      core: providerCore(s.name || "")
    }))
    .sort((a, b) => a.provider_nfhs_number - b.provider_nfhs_number);

  return { category, streams };
}

async function getOfficialWatchOrder() {
  const html = await fetchText(WATCH_URL);
  const $ = cheerio.load(html);

  const rows = [];
  const seen = new Set();
  let section = "unknown";

  $("body *").each((_, el) => {
    const tag = String(el.tagName || el.name || "").toLowerCase();
    const text = cleanSpace($(el).text());

    if (tag === "h2") {
      if (/upcoming games/i.test(text)) section = "upcoming";
      else if (/on demand games/i.test(text)) section = "on_demand";
      return;
    }

    if (tag !== "a") return;

    const href = cleanSpace($(el).attr("href") || "");
    const m = href.match(/\/events\/[^/]+\/((?:gam|evt)[a-z0-9]+)(?:[/?#]|$)/i);
    if (!m) return;

    const eventId = m[1];
    if (seen.has(eventId)) return;
    seen.add(eventId);

    rows.push({
      page_index: rows.length,
      section,
      event_id: eventId,
      text,
      core: officialCore(text)
    });
  });

  return rows;
}

function topMatchesForOfficial(official, providerStreams, topN = 5) {
  const matches = providerStreams
    .map(p => {
      const sim = similarity(official.core, p.core);
      return {
        provider_nfhs_number: p.provider_nfhs_number,
        stream_id: p.stream_id,
        provider_title: p.title,
        provider_core: p.core,
        score: sim.score,
        overlap: sim.overlap
      };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.provider_nfhs_number - b.provider_nfhs_number)
    .slice(0, topN);

  return matches;
}

function classifyAnchor(best) {
  if (!best) return false;
  if (best.score >= 0.82 && best.overlap.length >= 2) return true;
  if (best.score >= 0.96) return true;
  return false;
}

function longestIncreasingChain(anchors) {
  if (!anchors.length) return [];

  const n = anchors.length;
  const dp = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (
        anchors[j].official_index < anchors[i].official_index &&
        anchors[j].provider_nfhs_number < anchors[i].provider_nfhs_number &&
        dp[j] + 1 > dp[i]
      ) {
        dp[i] = dp[j] + 1;
        prev[i] = j;
      }
    }
  }

  let end = 0;
  for (let i = 1; i < n; i++) {
    if (dp[i] > dp[end]) end = i;
  }

  const chain = [];
  for (let i = end; i >= 0; i = prev[i]) {
    chain.push(anchors[i]);
    if (prev[i] === -1) break;
  }

  return chain.reverse();
}

function mode(values) {
  const counts = new Map();

  for (const v of values) {
    counts.set(v, (counts.get(v) || 0) + 1);
  }

  let best = null;
  let count = 0;

  for (const [value, c] of counts) {
    if (c > count) {
      best = value;
      count = c;
    }
  }

  return { value: best, count };
}

function providerInternalPattern(streams) {
  const sums = streams
    .filter(x => Number.isFinite(x.stream_id) && Number.isFinite(x.provider_nfhs_number))
    .map(x => x.stream_id + x.provider_nfhs_number);

  const common = mode(sums);
  const exactPct = sums.length ? common.count / sums.length : 0;

  let monotonicPairs = 0;
  let adjacentPairs = 0;
  let exactMinusOneSteps = 0;

  for (let i = 1; i < streams.length; i++) {
    const a = streams[i - 1];
    const b = streams[i];

    if (b.provider_nfhs_number === a.provider_nfhs_number + 1) {
      adjacentPairs++;
      if (b.stream_id < a.stream_id) monotonicPairs++;
      if (b.stream_id === a.stream_id - 1) exactMinusOneSteps++;
    }
  }

  return {
    most_common_stream_id_plus_nfhs_number: common.value,
    count_with_most_common_sum: common.count,
    total_streams_checked: sums.length,
    percent_with_most_common_sum: Number((exactPct * 100).toFixed(2)),
    adjacent_number_pairs: adjacentPairs,
    adjacent_pairs_stream_id_decreases: monotonicPairs,
    adjacent_pairs_exact_stream_id_minus_one: exactMinusOneSteps,
    percent_adjacent_exact_minus_one: adjacentPairs
      ? Number((exactMinusOneSteps / adjacentPairs * 100).toFixed(2))
      : 0
  };
}

function analyzeSection(sectionRows, providerStreams) {
  const rows = sectionRows.map((official, idx) => {
    const top = topMatchesForOfficial(official, providerStreams);
    const best = top[0] || null;

    return {
      official_index: idx,
      page_index: official.page_index,
      event_id: official.event_id,
      official_text: official.text,
      official_core: official.core,
      best_provider_match: best,
      strong_anchor: classifyAnchor(best),
      top_provider_matches: top
    };
  });

  const anchors = rows
    .filter(x => x.strong_anchor)
    .map(x => ({
      official_index: x.official_index,
      event_id: x.event_id,
      official_text: x.official_text,
      provider_nfhs_number: x.best_provider_match.provider_nfhs_number,
      stream_id: x.best_provider_match.stream_id,
      provider_title: x.best_provider_match.provider_title,
      score: x.best_provider_match.score,
      overlap: x.best_provider_match.overlap,
      offset: x.best_provider_match.provider_nfhs_number - x.official_index
    }))
    .sort((a, b) => a.official_index - b.official_index);

  const chain = longestIncreasingChain(anchors);
  const offsetMode = mode(chain.map(x => x.offset));

  const transitions = [];

  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1];
    const cur = chain[i];

    transitions.push({
      from_event_id: prev.event_id,
      to_event_id: cur.event_id,
      official_index_gap: cur.official_index - prev.official_index,
      provider_number_gap: cur.provider_nfhs_number - prev.provider_nfhs_number,
      gap_difference:
        (cur.provider_nfhs_number - prev.provider_nfhs_number) -
        (cur.official_index - prev.official_index)
    });
  }

  const predicted = rows.map(row => {
    if (offsetMode.value === null) return { ...row, predicted_provider_number: null };

    const predictedNumber = row.official_index + offsetMode.value;
    const actual = providerStreams.find(x => x.provider_nfhs_number === predictedNumber) || null;

    return {
      ...row,
      predicted_provider_number: predictedNumber,
      provider_title_at_predicted_number: actual?.title || null,
      provider_stream_id_at_predicted_number: actual?.stream_id || null
    };
  });

  return {
    official_event_count: rows.length,
    strong_anchor_count: anchors.length,
    monotonic_anchor_chain_count: chain.length,
    dominant_offset: offsetMode.value,
    dominant_offset_support: offsetMode.count,
    anchors,
    monotonic_anchor_chain: chain,
    transitions,
    rows: predicted
  };
}

async function main() {
  const [provider, official] = await Promise.all([
    getProvider(),
    getOfficialWatchOrder()
  ]);

  const upcoming = official.filter(x => x.section === "upcoming");
  const onDemand = official.filter(x => x.section === "on_demand");

  const upcomingAnalysis = analyzeSection(upcoming, provider.streams);
  const onDemandAnalysis = analyzeSection(onDemand, provider.streams);

  const payload = {
    generated_at: new Date().toISOString(),
    diagnostic_only: true,
    modifies_epg: false,
    diagnostic_version: "sequence-1",
    purpose:
      "Test whether provider NFHS channel numbers preserve the ordered NFHS Watch Events feed, quantify provider stream-number sequencing, identify skipped official events, and predict provider slots from a dominant ordinal offset. This reads metadata only and does not access protected NFHS video.",
    safety: {
      public_events_json_modified: false,
      provider_video_accessed: false,
      credentials_written_to_output: false
    },
    provider: {
      category: provider.category?.category_name || DEFAULT_CATEGORY,
      provider_nfhs_stream_count: provider.streams.length,
      internal_numbering_pattern: providerInternalPattern(provider.streams)
    },
    official_watch_page: {
      url: WATCH_URL,
      total_event_links_found: official.length,
      upcoming_count: upcoming.length,
      on_demand_count: onDemand.length
    },
    upcoming_sequence_analysis: upcomingAnalysis,
    on_demand_sequence_analysis: onDemandAnalysis
  };

  await fs.mkdir("public", { recursive: true });

  await fs.writeFile(
    "public/nfhs-sequence-diagnostic.json",
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );

  console.log("NFHS/provider sequence diagnostic complete.");
  console.log(JSON.stringify({
    provider_stream_count: provider.streams.length,
    internal_pattern: payload.provider.internal_numbering_pattern,
    watch_upcoming: upcoming.length,
    upcoming_strong_anchors: upcomingAnalysis.strong_anchor_count,
    upcoming_chain: upcomingAnalysis.monotonic_anchor_chain_count,
    upcoming_dominant_offset: upcomingAnalysis.dominant_offset,
    upcoming_offset_support: upcomingAnalysis.dominant_offset_support,
    watch_on_demand: onDemand.length,
    on_demand_strong_anchors: onDemandAnalysis.strong_anchor_count,
    on_demand_chain: onDemandAnalysis.monotonic_anchor_chain_count,
    on_demand_dominant_offset: onDemandAnalysis.dominant_offset,
    on_demand_offset_support: onDemandAnalysis.dominant_offset_support
  }, null, 2));
  console.log("public/events.json was NOT modified.");
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
