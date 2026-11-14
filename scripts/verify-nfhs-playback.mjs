import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { decorateChannel, PLAYBACK_STATE_PATH } from "./playback-status.mjs";

// Probe only authorized Xtream streams already published in our Georgia event data.
// Never write or log Xtream URLs, credentials, video bytes, or ffprobe stderr.
const EVENTS_PATH = "public/events.json";
const MAX_CHECKS = Math.min(24, Math.max(1, Number(process.env.NFHS_MAX_CHECKS || 16)));
const CONCURRENCY = 2;
const REQUEST_TIMEOUT_MS = 8000;
const VIDEO_SAMPLE_BYTES = 650000;
const MIN_RECHECK_MS = 12 * 60 * 1000;
const RETENTION_MS = 30 * 60 * 60 * 1000;

async function readJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); }
  catch (err) {
    if (err?.code === "ENOENT") return fallback;
    throw err;
  }
}

function isEligible(e, now) {
  const start = Date.parse(e.start || ""), stop = Date.parse(e.stop || "");
  return e.stream_id && Number.isFinite(start) && Number.isFinite(stop) &&
    start <= now + 8 * 60_000 && stop > now;
}

function isPriority(e) {
  const title = String(e.original_name || e.name || "");
  const local = /\\b(Lowndes|Valdosta|Pierce County|Ware County|Brooks County|Cook High|Tift County|Coffee High|Colquitt County|Camden County|Clinch County|Bacon County|Valwood)\\b/i;
  return /\\bFootball\\b/i.test(title) || local.test(title);
}

function sortOldestFirst(a, b, state) {
  const time = (e) => {
    const r = state.streams?.[String(e.stream_id)];
    if (!r || r.original_name !== e.original_name) return 0;
    return Date.parse(r.last_checked_at || "") || 0;
  };
  return time(a) - time(b) || Date.parse(a.start || "") - Date.parse(b.start || "");
}

function selectCandidates(channels, state, now) {
  const eligible = channels.filter(e => isEligible(e, now)).filter(e => {
    const r = state.streams?.[String(e.stream_id)];
    if (!r || r.original_name !== e.original_name) return true;
    return now - (Date.parse(r.last_checked_at || "") || 0) >= MIN_RECHECK_MS;
  });
  const priority = eligible.filter(isPriority).sort((a, b) => sortOldestFirst(a, b, state));
  const other = eligible.filter(e => !isPriority(e)).sort((a, b) => sortOldestFirst(a, b, state));
  const primaryCount = Math.min(priority.length, Math.ceil(MAX_CHECKS * 0.75));
  const selected = priority.slice(0, primaryCount);
  const rest = other.slice(0, MAX_CHECKS - selected.length);
  selected.push(...rest);
  if (selected.length < MAX_CHECKS) selected.push(...priority.slice(primaryCount, primaryCount + MAX_CHECKS - selected.length));
  return { selected, eligibleCount: eligible.length };
}

async function obtainSample(url) {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: "follow", headers: {
      "User-Agent": "Georgia-NFHS-UHF-Playback-Verification/1.0",
      "Range": "bytes=0-" + (VIDEO_SAMPLE_BYTES - 1)
    } });
    if (!r.ok || !r.body) return { result: "http_error", http_status: r.status };
    const chunks = [];
    let length = 0;
    const reader = r.body.getReader();
    try {
      while (length < VIDEO_SAMPLE_BYTES) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        const needed = Math.min(value.length, VIDEO_SAMPLE_BYTES - length);
        chunks.push(Buffer.from(value.subarray(0, needed)));
        length += needed;
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return { result: length ? "bytes_received" : "no_bytes", bytes: Buffer.concat(chunks, length), length };
  } catch {
    return { result: "network_error" };
  } finally {
    clearTimeout(timeout);
  }
}

function hasTsSync(bytes) {
  if (!bytes || bytes.length < 188 * 12) return false;
  for (let offset = 0; offset < 188; offset++) {
    let count = 0;
    for (let j = 0; j < 12; j++) {
      if (bytes[offset + j * 188] === 0x47) count++;
      else break;
    }
    if (count >= 12) return true;
  }
  return false;
}

function detectVideoCodec(bytes) {
  return new Promise(resolve => {
    let child, ended = false;
    const finish = ok => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // ffprobe is present on standard GitHub Ubuntu runners; missing tool means unverified.
    try {
      child = spawn("ffprobe", [
        "-v", "error", "-analyzeduration", "1000000", "-probesize", "500000",
        "-show_entries", "stream=codec_type,codec_name", "-of", "json", "pipe:0"
      ], { stdio: ["pipe", "pipe", "ignore"] });
    } catch { resolve(false); return; }
    let stdout = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(false);
    }, 4500);
    child.stdout.on("data", b => { if (stdout.length < 100000) stdout += b.toString(); });
    child.stdin.on("error", () => {});
    child.on("error", () => finish(false));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout);
        finish(Array.isArray(parsed.streams) && parsed.streams.some(s => s.codec_type === "video" && s.codec_name));
      } catch { finish(false); }
    });
    try { child.stdin.end(bytes); } catch { finish(false); }
  });
}

async function verifyOne(e, authBase) {
  const ext = /^[a-z0-9]+$/i.test(e.extension || "") ? e.extension : "ts";
  const url = authBase + "/" + encodeURIComponent(e.stream_id) + "." + ext;
  const sample = await obtainSample(url);
  if (!sample.bytes?.length) return { result: sample.result, http_status: sample.http_status || null };
  if (sample.bytes.subarray(0, 8).toString("utf8").includes("#EXTM3U")) {
    return { result: "hls_manifest_only", http_status: null };
  }
  if (!hasTsSync(sample.bytes)) return { result: "non_ts_response", http_status: null };
  const video = await detectVideoCodec(sample.bytes);
  return { result: video ? "video_detected" : "video_not_decodable", http_status: null };
}

async function main() {
  const base = String(process.env.XTREAM_BASE_URL || "").trim().replace(/\\/+$/, "");
  const user = process.env.XTREAM_USERNAME || "";
  const pass = process.env.XTREAM_PASSWORD || "";
  if (!base || !user || !pass || !/^https?:\\/\\//i.test(base)) {
    throw new Error("Authorized Xtream credentials/base URL missing or invalid.");
  }
  const authBase = base + "/live/" + encodeURIComponent(user) + "/" + encodeURIComponent(pass);
  const now = Date.now();
  const events = await readJson(EVENTS_PATH, null);
  if (!events || !Array.isArray(events.channels)) throw new Error("Georgia event data unavailable.");
  const state = await readJson(PLAYBACK_STATE_PATH, { version: 1, streams: {} });
  if (!state.streams || typeof state.streams !== "object") state.streams = {};
  const { selected, eligibleCount } = selectCandidates(events.channels, state, now);
  const outcomes = {};
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, async () => {
    while (next < selected.length) {
      const e = selected[next++];
      const outcome = await verifyOne(e, authBase);
      outcomes[outcome.result] = (outcomes[outcome.result] || 0) + 1;
      const id = String(e.stream_id);
      const previous = state.streams[id]?.original_name === e.original_name ? state.streams[id] : null;
      state.streams[id] = {
        original_name: e.original_name,
        last_checked_at: new Date().toISOString(),
        last_result: outcome.result,
        last_video_at: outcome.result === "video_detected" ? new Date().toISOString() : previous?.last_video_at || null,
        consecutive_failures: outcome.result === "video_detected" ? 0 : (previous?.consecutive_failures || 0) + 1,
        ...(outcome.http_status ? { http_status: outcome.http_status } : {})
      };
    }
  }));
  for (const [id, record] of Object.entries(state.streams)) {
    if (now - (Date.parse(record.last_checked_at || "") || 0) > RETENTION_MS) delete state.streams[id];
  }
  state.version = 1;
  state.last_run_at = new Date().toISOString();
  state.last_run_checks = selected.length;
  state.last_run_outcomes = outcomes;
  events.channels = events.channels.map(e => decorateChannel(e, state, Date.now()));
  events.playback_checked_at = state.last_run_at;
  events.playback_verification_method = "short provider sample with ffprobe; matchup identity not confirmed";
  await fs.writeFile(PLAYBACK_STATE_PATH, JSON.stringify(state, null, 2) + "\\n");
  await fs.writeFile(EVENTS_PATH, JSON.stringify(events, null, 2) + "\\n");
  console.log(JSON.stringify({ eligible_now: eligibleCount, checked: selected.length, outcomes,
    note: "Network-only failure is not evidence that UHF or the underlying game is offline." }));
}
main().catch(err => { console.error(String(err?.message || err)); process.exitCode = 1; });
