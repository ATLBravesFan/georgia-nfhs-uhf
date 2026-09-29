import fs from "node:fs/promises";
import crypto from "node:crypto";

const DEFAULT_CATEGORY = "USA | NFHS Network";

const EVENTS = [
  {
    role: "target",
    event_id: "gamb8ad8195a3",
    name: "Clinch County vs. Brantley County Freshman Girls Volleyball",
    known_provider_stream_id: null,
    known_provider_nfhs_number: null
  },
  {
    role: "control",
    event_id: "gamd493cc6a81",
    name: "Camden County vs. Savannah Country Day Junior Varsity Girls Volleyball",
    known_provider_stream_id: 2066737,
    known_provider_nfhs_number: 3572
  }
];

function cleanSpace(s = "") {
  return String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function hashValue(v) {
  if (!v) return null;
  return crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 20);
}

function maybeDecodeBase64(v) {
  if (!v || typeof v !== "string") return v;
  try {
    const s = Buffer.from(v, "base64").toString("utf8");
    if (!s || /[\u0000-\u0008\u000E-\u001F]/.test(s)) return v;
    return s;
  } catch {
    return v;
  }
}

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 Georgia-NFHS-Diagnostic/2.0" },
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

async function getProvider() {
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
  if (!category) throw new Error("Could not find NFHS category.");

  let streams = await fetchJson(
    `${base}/player_api.php?${auth}&action=get_live_streams&category_id=${encodeURIComponent(category.category_id)}`
  );
  streams = streams.filter(
    s => String(s.category_id) === String(category.category_id) || !s.category_id
  );

  return { base, username, password, auth, category, streams };
}

function providerNumber(name = "") {
  const m = String(name).match(/^NFHS\s+Network\s+(\d+)\s*:/i);
  return m ? Number(m[1]) : null;
}

function isTargetCandidate(name = "") {
  const n = String(name).toLowerCase();
  return n.includes("29 sep") &&
    n.includes("04:00 pm et") &&
    n.includes("volleyball") &&
    n.includes("freshman") &&
    n.includes("girls");
}

function sanitizeEpg(epg) {
  const listings = Array.isArray(epg?.epg_listings) ? epg.epg_listings : [];
  return {
    listing_count: listings.length,
    listings: listings.slice(0, 5).map(x => ({
      id: x.id ?? null,
      epg_id: x.epg_id ?? null,
      title: maybeDecodeBase64(x.title ?? null),
      description: maybeDecodeBase64(x.description ?? null),
      start: x.start ?? null,
      end: x.end ?? null,
      start_timestamp: x.start_timestamp ?? null,
      stop_timestamp: x.stop_timestamp ?? null,
      now_playing: x.now_playing ?? null,
      has_archive: x.has_archive ?? null
    }))
  };
}

async function getShortEpg(provider, streamId) {
  const url = `${provider.base}/player_api.php?${provider.auth}&action=get_short_epg&stream_id=${encodeURIComponent(streamId)}&limit=5`;
  try {
    return { ok: true, ...sanitizeEpg(await fetchJson(url)) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), listing_count: 0, listings: [] };
  }
}

async function getSimpleData(provider, streamId) {
  const url = `${provider.base}/player_api.php?${provider.auth}&action=get_simple_data_table&stream_id=${encodeURIComponent(streamId)}`;
  try {
    const data = await fetchJson(url);
    return {
      ok: true,
      epg_listings: sanitizeEpg(data),
      raw_keys: data && typeof data === "object" ? Object.keys(data).sort() : []
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function getNfhsMetadata(event) {
  const url = `https://cfunity.nfhsnetwork.com/v2/game_or_event/${event.event_id}`;
  try {
    const data = await fetchJson(url);
    const publisher = Array.isArray(data?.publishers) ? data.publishers[0] : null;
    const broadcast = publisher && Array.isArray(publisher.broadcasts) ? publisher.broadcasts[0] : null;
    const vod = publisher && Array.isArray(publisher.vods) ? publisher.vods[0] : null;

    return {
      ok: true,
      role: event.role,
      event_id: event.event_id,
      name: event.name,
      known_provider_stream_id: event.known_provider_stream_id,
      known_provider_nfhs_number: event.known_provider_nfhs_number,
      local_start_time: data?.local_start_time ?? null,
      city: data?.city ?? null,
      state_name: data?.state_name ?? null,
      publisher: publisher ? {
        name: publisher.formatted_name ?? publisher.name ?? null,
        publisher_key: publisher.publisher_key ?? null,
        slug: publisher.slug ?? null,
        type: publisher.type ?? null,
        broadcast_count: Array.isArray(publisher.broadcasts) ? publisher.broadcasts.length : 0,
        vod_count: Array.isArray(publisher.vods) ? publisher.vods.length : 0
      } : null,
      broadcast: broadcast ? {
        status: broadcast.status ?? null,
        key_fingerprint: hashValue(broadcast.key),
        key_length: broadcast.key ? String(broadcast.key).length : 0,
        safe_keys_present: Object.keys(broadcast).filter(k =>
          /^(id|status|on_air|description|created_at|updated_at|start|stop|type)$/i.test(k)
        )
      } : null,
      vod: vod ? {
        status: vod.status ?? null,
        key_fingerprint: hashValue(vod.key),
        key_length: vod.key ? String(vod.key).length : 0
      } : null
    };
  } catch (err) {
    return {
      ok: false,
      role: event.role,
      event_id: event.event_id,
      name: event.name,
      error: String(err?.message || err)
    };
  }
}

async function main() {
  const provider = await getProvider();

  const targetCandidates = provider.streams
    .filter(s => isTargetCandidate(s.name || ""))
    .map(s => ({
      stream_id: s.stream_id,
      provider_nfhs_number: providerNumber(s.name || ""),
      original_name: cleanSpace(s.name || "")
    }));

  const nfhsMetadata = [];
  for (const event of EVENTS) {
    nfhsMetadata.push(await getNfhsMetadata(event));
  }

  const controlStream = provider.streams.find(s => Number(s.stream_id) === 2066737);
  const controlProvider = controlStream ? {
    stream_id: controlStream.stream_id,
    provider_nfhs_number: providerNumber(controlStream.name || ""),
    original_name: cleanSpace(controlStream.name || ""),
    short_epg: await getShortEpg(provider, controlStream.stream_id),
    simple_data: await getSimpleData(provider, controlStream.stream_id)
  } : {
    stream_id: 2066737,
    error: "Known Camden control stream was not present in the current provider dump."
  };

  const candidateDetails = [];
  for (const c of targetCandidates) {
    candidateDetails.push({
      ...c,
      short_epg: await getShortEpg(provider, c.stream_id),
      simple_data: await getSimpleData(provider, c.stream_id)
    });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    diagnostic_only: true,
    modifies_epg: false,
    purpose: "Compare NFHS event metadata plus provider-side EPG/details for the Clinch-Brantley target against a known Camden control.",
    nfhs_events: nfhsMetadata,
    provider: {
      category: provider.category?.category_name || DEFAULT_CATEGORY,
      source_stream_count: provider.streams.length,
      target_candidate_count: targetCandidates.length
    },
    known_control_provider_stream: controlProvider,
    target_candidates: candidateDetails
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile(
    "public/nfhs-diagnostic.json",
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );

  console.log(`Wrote diagnostic with ${targetCandidates.length} target candidate(s).`);
  console.log("public/events.json was NOT modified.");
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
