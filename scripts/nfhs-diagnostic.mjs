import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DateTime } from "luxon";

const EASTERN = "America/New_York";
const DEFAULT_CATEGORY = "USA | NFHS Network";

const CONTROL_NUMBERS = [3552, 3572, 3596, 3455, 3556, 3448, 3609];
const MAX_CANDIDATES = 24;
const MAX_SUCCESS_SAMPLES = 4;
const SAMPLE_BYTES = 4 * 1024 * 1024;
const SAMPLE_TIMEOUT_MS = 15000;

function cleanSpace(s = "") {
  return String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function providerNumber(name = "") {
  const m = String(name).match(/^NFHS\s+Network\s+(\d+)\s*:/i);
  return m ? Number(m[1]) : null;
}

function parseProviderStart(name, now = DateTime.now().setZone(EASTERN)) {
  const m = String(name).match(/@\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET\s*$/i);
  if (!m) return null;

  const [, dayS, monthS, hourS, minuteS, ampm] = m;
  const month = DateTime.fromFormat(monthS, "LLL", { zone: EASTERN }).month;
  if (!month) return null;

  let hour = Number(hourS) % 12;
  if (ampm.toUpperCase() === "PM") hour += 12;

  let dt = DateTime.fromObject(
    { year: now.year, month, day: Number(dayS), hour, minute: Number(minuteS), second: 0 },
    { zone: EASTERN }
  );

  if (!dt.isValid) return null;
  if (dt.diff(now, "days").days > 180) dt = dt.minus({ years: 1 });
  if (dt.diff(now, "days").days < -180) dt = dt.plus({ years: 1 });
  return dt;
}

function redactError(value, provider) {
  let s = String(value || "");
  if (provider?.username) s = s.split(provider.username).join("[USERNAME]");
  if (provider?.password) s = s.split(provider.password).join("[PASSWORD]");
  s = s.replace(/https?:\/\/[^\s"'\\]+/gi, "[REDACTED-URL]");
  return s.slice(0, 1000);
}

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 Georgia-NFHS-Diagnostic/14.0" }
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
  const categories = await fetchJson(`${base}/player_api.php?${auth}&action=get_live_categories`);
  if (!Array.isArray(categories)) throw new Error("Xtream live category response was not an array.");

  const wanted = cleanSpace(process.env.NFHS_CATEGORY_NAME || DEFAULT_CATEGORY).toLowerCase();
  let category = categories.find(c => cleanSpace(c.category_name).toLowerCase() === wanted);
  if (!category) category = categories.find(c => /nfhs/i.test(String(c.category_name || "")));
  if (!category) throw new Error("Could not find NFHS category.");

  let streams = await fetchJson(
    `${base}/player_api.php?${auth}&action=get_live_streams&category_id=${encodeURIComponent(category.category_id)}`
  );
  if (!Array.isArray(streams)) throw new Error("Xtream live stream response was not an array.");
  streams = streams.filter(s => String(s.category_id) === String(category.category_id) || !s.category_id);

  return { base, username, password, category, streams };
}

function streamUrl(provider, streamId) {
  return `${provider.base}/live/${encodeURIComponent(provider.username)}/${encodeURIComponent(provider.password)}/${streamId}.ts`;
}

function runProcess(command, args, timeoutMs = 10000) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      resolve(value);
    };

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));

    child.on("error", err => {
      clearTimeout(timer);
      finish({
        ok: false,
        timed_out: timedOut,
        code: null,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        error: String(err?.message || err)
      });
    });

    child.on("close", code => {
      clearTimeout(timer);
      finish({
        ok: code === 0 && !timedOut,
        timed_out: timedOut,
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString()
      });
    });
  });
}

function tsSyncScore(buffer) {
  if (!buffer?.length) return 0;
  const maxStart = Math.min(187, buffer.length - 1);
  let best = 0;

  for (let offset = 0; offset <= maxStart; offset++) {
    let hits = 0;
    let total = 0;
    for (let i = offset; i < buffer.length && total < 40; i += 188) {
      total++;
      if (buffer[i] === 0x47) hits++;
    }
    if (total >= 3) best = Math.max(best, hits / total);
  }

  return Number(best.toFixed(3));
}

async function downloadSample(provider, streamId, outputFile) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SAMPLE_TIMEOUT_MS);
  const started = Date.now();
  let response = null;
  let reader = null;

  try {
    response = await fetch(streamUrl(provider, streamId), {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 Georgia-NFHS-Diagnostic/14.0",
        "Accept": "*/*",
        "Cache-Control": "no-cache"
      }
    });

    let finalHost = null;
    try { finalHost = new URL(response.url).hostname; } catch {}

    const contentType = response.headers.get("content-type") || null;
    if (!response.ok || !response.body) {
      return {
        ok: false,
        status: response.status,
        final_host: finalHost,
        content_type: contentType,
        bytes_saved: 0,
        elapsed_ms: Date.now() - started,
        error: `HTTP ${response.status} ${response.statusText}`
      };
    }

    reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    while (total < SAMPLE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;

      const remaining = SAMPLE_BYTES - total;
      const part = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(Buffer.from(part));
      total += part.length;

      if (total >= SAMPLE_BYTES) break;
    }

    try { await reader.cancel(); } catch {}

    const buffer = Buffer.concat(chunks, total);
    if (buffer.length > 0) await fs.writeFile(outputFile, buffer);

    return {
      ok: buffer.length >= 188 * 10,
      status: response.status,
      final_host: finalHost,
      content_type: contentType,
      bytes_saved: buffer.length,
      elapsed_ms: Date.now() - started,
      ts_sync_score: tsSyncScore(buffer),
      error: buffer.length >= 188 * 10 ? null : "Response opened but did not deliver enough stream bytes."
    };
  } catch (err) {
    return {
      ok: false,
      status: response?.status ?? null,
      final_host: (() => { try { return response?.url ? new URL(response.url).hostname : null; } catch { return null; } })(),
      content_type: response?.headers?.get?.("content-type") || null,
      bytes_saved: 0,
      elapsed_ms: Date.now() - started,
      error: redactError(err?.message || err, provider)
    };
  } finally {
    clearTimeout(timer);
    try { await reader?.cancel(); } catch {}
    try { ac.abort(); } catch {}
  }
}

async function extractFrames(sampleFile, outputPattern) {
  const result = await runProcess(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel", "error",
      "-fflags", "+discardcorrupt",
      "-analyzeduration", "5000000",
      "-probesize", "5000000",
      "-i", sampleFile,
      "-vf", "fps=1/2,scale=1280:-2",
      "-frames:v", "2",
      "-q:v", "3",
      "-y", outputPattern
    ],
    12000
  );

  const files = [];
  for (let i = 1; i <= 2; i++) {
    const file = outputPattern.replace("%02d", String(i).padStart(2, "0"));
    try {
      const stat = await fs.stat(file);
      if (stat.size >= 5000) files.push(file);
    } catch {}
  }

  return {
    ok: files.length > 0,
    files,
    code: result.code,
    timed_out: result.timed_out,
    error: files.length > 0 ? null : (result.stderr || result.error || "Local FFmpeg produced no frame.").slice(0, 1000)
  };
}

async function runOcr(file) {
  const result = await runProcess("tesseract", [file, "stdout", "--psm", "11"], 10000);
  return result.ok ? cleanSpace(result.stdout) : "";
}

function buildCandidates(provider, now) {
  const byNumber = new Map();
  for (const s of provider.streams) {
    const n = providerNumber(s.name || "");
    if (n !== null) byNumber.set(n, s);
  }

  const chosen = [];
  const seen = new Set();

  for (const n of CONTROL_NUMBERS) {
    const stream = byNumber.get(n);
    if (!stream) continue;
    chosen.push({ stream, start: parseProviderStart(stream.name || "", now), reason: "control" });
    seen.add(String(stream.stream_id));
  }

  const recentToday = provider.streams
    .map(stream => ({ stream, start: parseProviderStart(stream.name || "", now) }))
    .filter(x => x.start && x.start.hasSame(now, "day"))
    .sort((a, b) => b.start.toMillis() - a.start.toMillis());

  for (const item of recentToday) {
    if (chosen.length >= MAX_CANDIDATES) break;
    const key = String(item.stream.stream_id);
    if (seen.has(key)) continue;
    chosen.push({ ...item, reason: "recent_today_title" });
    seen.add(key);
  }

  return chosen;
}

async function main() {
  const now = DateTime.now().setZone(EASTERN);
  const provider = await getProvider();
  const candidates = buildCandidates(provider, now);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nfhs-v14-"));

  console.log(`NFHS diagnostic v14 started at ${now.toISO()}`);
  console.log(`Testing ${candidates.length} candidate provider slots sequentially.`);
  console.log(`Stopping after ${MAX_SUCCESS_SAMPLES} successful Node stream samples.`);

  const results = [];
  let successes = 0;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const stream = candidate.stream;
    const number = providerNumber(stream.name || "");
    const sampleFile = path.join(tmpDir, `nfhs-${number}-${stream.stream_id}.ts`);
    const framePattern = path.join(tmpDir, `nfhs-${number}-${stream.stream_id}-%02d.jpg`);

    console.log(`Testing ${index + 1}/${candidates.length}: NFHS ${number}`);

    const nodeSample = await downloadSample(provider, stream.stream_id, sampleFile);
    let localFfmpeg = null;
    let ocrText = "";

    if (nodeSample.ok) {
      successes++;
      localFfmpeg = await extractFrames(sampleFile, framePattern);

      if (localFfmpeg.ok) {
        const texts = [];
        for (const frame of localFfmpeg.files) {
          const t = await runOcr(frame);
          if (t) texts.push(t);
        }
        ocrText = cleanSpace(texts.join(" | "));
      }
    }

    results.push({
      provider_nfhs_number: number,
      stream_id: stream.stream_id,
      reason: candidate.reason,
      stale_provider_title: cleanSpace(stream.name || ""),
      stale_provider_start: candidate.start?.toISO() || null,
      node_sample: nodeSample,
      local_ffmpeg: localFfmpeg,
      ocr_text: ocrText || null
    });

    try { await fs.rm(sampleFile, { force: true }); } catch {}
    if (localFfmpeg?.files) {
      for (const frame of localFfmpeg.files) {
        try { await fs.rm(frame, { force: true }); } catch {}
      }
    }

    if (successes >= MAX_SUCCESS_SAMPLES) break;
  }

  const nodeOpened = results.filter(x => x.node_sample?.status === 200).length;
  const nodeBytes = results.filter(x => (x.node_sample?.bytes_saved || 0) > 0).length;
  const nodeUsable = results.filter(x => x.node_sample?.ok).length;
  const localFrames = results.filter(x => x.local_ffmpeg?.ok).length;
  const withOcr = results.filter(x => cleanSpace(x.ocr_text || "")).length;

  const payload = {
    generated_at: now.toISO(),
    diagnostic_only: true,
    modifies_epg: false,
    diagnostic_version: 14,
    purpose: "Test whether Node.js can read actual MPEG-TS bytes from provider NFHS streams and then let FFmpeg process the saved local sample, bypassing FFmpeg's direct TLS/CDN connection failures.",
    safety: {
      provider_connections_used_concurrently: 1,
      raw_stream_samples_saved_to_repository: false,
      frames_saved_to_repository: false,
      credentials_written_to_output: false,
      public_events_json_modified: false
    },
    provider: {
      category: provider.category?.category_name || DEFAULT_CATEGORY,
      source_stream_count: provider.streams.length,
      candidate_limit: MAX_CANDIDATES,
      successful_sample_stop_limit: MAX_SUCCESS_SAMPLES,
      sample_byte_limit: SAMPLE_BYTES
    },
    summary: {
      candidates_attempted: results.length,
      node_http_200: nodeOpened,
      node_received_any_bytes: nodeBytes,
      node_received_usable_ts_sample: nodeUsable,
      local_ffmpeg_frames_created: localFrames,
      samples_with_nonempty_ocr: withOcr,
      node_to_local_ffmpeg_path_works: localFrames > 0
    },
    controls: results.filter(x => CONTROL_NUMBERS.includes(x.provider_nfhs_number)),
    results
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile("public/nfhs-diagnostic.json", JSON.stringify(payload, null, 2) + "\n", "utf8");
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}

  console.log("Diagnostic v14 complete.");
  console.log(`Node HTTP 200: ${nodeOpened}`);
  console.log(`Node samples with bytes: ${nodeBytes}`);
  console.log(`Usable TS samples: ${nodeUsable}`);
  console.log(`Local FFmpeg frames: ${localFrames}`);
  console.log(`OCR samples: ${withOcr}`);
  console.log("public/events.json was NOT modified.");
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
