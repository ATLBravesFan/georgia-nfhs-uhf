import fs from "node:fs/promises";

const DEFAULT_CATEGORY = "USA | NFHS Network";
const TARGET_EVENT_ID = "gamb8ad8195a3";
const TARGET = {
  away: "Clinch County",
  home: "Brantley County",
  sport: "Volleyball",
  level: "Freshman",
  gender: "Girls",
  date: "29 Sep",
  time: "04:00 PM",
};

function cleanSpace(s = "") {
  return String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 Georgia-NFHS-Diagnostic/1.0" },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${text.slice(0, 200)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 20000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

async function getProviderStreams() {
  const base = cleanSpace(process.env.XTREAM_BASE_URL || "").replace(/\/+$/, "");
  const username = process.env.XTREAM_USERNAME || "";
  const password = process.env.XTREAM_PASSWORD || "";
  if (!base || !username || !password) {
    throw new Error("Missing XTREAM_BASE_URL, XTREAM_USERNAME, or XTREAM_PASSWORD.");
  }

  const auth = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const categories = await fetchJson(`${base}/player_api.php?${auth}&action=get_live_categories`);
  const wanted = cleanSpace(process.env.NFHS_CATEGORY_NAME || DEFAULT_CATEGORY).toLowerCase();

  let category = categories.find(c => cleanSpace(c.category_name).toLowerCase() === wanted);
  if (!category) category = categories.find(c => /nfhs/i.test(String(c.category_name || "")));
  if (!category) throw new Error("Could not find the NFHS category.");

  let streams = await fetchJson(
    `${base}/player_api.php?${auth}&action=get_live_streams&category_id=${encodeURIComponent(category.category_id)}`
  );

  streams = streams.filter(
    s => String(s.category_id) === String(category.category_id) || !s.category_id
  );

  return { category, streams };
}

function providerNumber(name = "") {
  const m = String(name).match(/^NFHS\s+Network\s+(\d+)\s*:/i);
  return m ? Number(m[1]) : null;
}

function scoreCandidate(name = "") {
  const n = String(name).toLowerCase();
  let score = 0;
  const reasons = [];

  if (n.includes("29 sep")) { score += 4; reasons.push("same date"); }
  if (n.includes("04:00 pm et")) { score += 8; reasons.push("same 4:00 PM start"); }
  if (n.includes("volleyball")) { score += 5; reasons.push("same sport"); }
  if (n.includes("freshman")) { score += 5; reasons.push("same level"); }
  if (n.includes("girls")) { score += 2; reasons.push("same gender"); }

  if (n.includes("clinch county")) { score += 50; reasons.push("Clinch County named"); }
  if (n.includes("brantley county")) { score += 50; reasons.push("Brantley County named"); }

  return { score, reasons };
}

function summarizeNfhs(data) {
  const publisher = Array.isArray(data?.publishers) ? data.publishers[0] : null;
  const broadcast = publisher && Array.isArray(publisher.broadcasts) ? publisher.broadcasts[0] : null;
  const vod = publisher && Array.isArray(publisher.vods) ? publisher.vods[0] : null;

  return {
    request_ok: true,
    event_id: TARGET_EVENT_ID,
    local_start_time: data?.local_start_time ?? null,
    city: data?.city ?? null,
    state_name: data?.state_name ?? null,
    event_type: data?.event_type ?? data?.type ?? null,
    publisher: publisher ? {
      name: publisher.formatted_name ?? publisher.name ?? null,
      publisher_key: publisher.publisher_key ?? null,
      type: publisher.type ?? null,
      slug: publisher.slug ?? null,
      broadcast_count: Array.isArray(publisher.broadcasts) ? publisher.broadcasts.length : 0,
      vod_count: Array.isArray(publisher.vods) ? publisher.vods.length : 0,
    } : null,
    broadcast: broadcast ? {
      status: broadcast.status ?? null,
      on_air: broadcast.on_air ?? null,
      description: broadcast.description ?? null,
      key_present: Boolean(broadcast.key),
    } : null,
    vod: vod ? {
      status: vod.status ?? null,
      key_present: Boolean(vod.key),
    } : null,
  };
}

async function getNfhsMetadata() {
  const url = `https://cfunity.nfhsnetwork.com/v2/game_or_event/${TARGET_EVENT_ID}`;
  try {
    const data = await fetchJson(url);
    return summarizeNfhs(data);
  } catch (err) {
    return {
      request_ok: false,
      event_id: TARGET_EVENT_ID,
      error: String(err?.message || err),
    };
  }
}

async function main() {
  const provider = await getProviderStreams();
  const nfhs = await getNfhsMetadata();

  const candidates = provider.streams
    .map(s => {
      const name = cleanSpace(s.name || "");
      const scored = scoreCandidate(name);
      return {
        stream_id: s.stream_id,
        provider_nfhs_number: providerNumber(name),
        original_name: name,
        score: scored.score,
        reasons: scored.reasons,
      };
    })
    .filter(x => x.score >= 12)
    .sort((a, b) => b.score - a.score || Number(b.stream_id) - Number(a.stream_id));

  const exactFourPmFreshmanGirlsVolleyball = candidates.filter(x => {
    const n = x.original_name.toLowerCase();
    return n.includes("29 sep") &&
      n.includes("04:00 pm et") &&
      n.includes("volleyball") &&
      n.includes("freshman") &&
      n.includes("girls");
  });

  const exactFourPmAllSports = provider.streams
    .map(s => ({
      stream_id: s.stream_id,
      provider_nfhs_number: providerNumber(s.name || ""),
      original_name: cleanSpace(s.name || ""),
    }))
    .filter(x => /@\s*29\s+Sep\s+04:00\s+PM\s+ET\s*$/i.test(x.original_name));

  const payload = {
    generated_at: new Date().toISOString(),
    diagnostic_only: true,
    modifies_epg: false,
    target: {
      ...TARGET,
      nfhs_event_id: TARGET_EVENT_ID,
    },
    nfhs_metadata: nfhs,
    provider: {
      category: provider.category?.category_name || DEFAULT_CATEGORY,
      source_stream_count: provider.streams.length,
      four_pm_stream_count: exactFourPmAllSports.length,
      matching_freshman_girls_volleyball_candidates: exactFourPmFreshmanGirlsVolleyball.length,
    },
    strongest_candidates: candidates.slice(0, 50),
    four_pm_freshman_girls_volleyball: exactFourPmFreshmanGirlsVolleyball,
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile(
    "public/nfhs-diagnostic.json",
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );

  console.log(
    `Diagnostic complete. Found ${exactFourPmFreshmanGirlsVolleyball.length} 4:00 PM Freshman Girls Volleyball candidate(s).`
  );
  console.log("This script did NOT modify public/events.json.");
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
