import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_CATEGORY = "USA | NFHS Network";
const NFHS_CONTROLS = [3552, 3572, 3596];
const NON_NFHS_CATEGORY_RE = /(usa|us).*(news|sports)|(?:news|sports).*(usa|us)/i;
const NON_NFHS_NAME_RE = /\b(CNN|FOX NEWS|MSNBC|WEATHER CHANNEL|ESPN|CBS SPORTS|NBC NEWS|ABC NEWS|NEWSMAX)\b/i;
const MAX_NON_NFHS = 4;
const CURL_SECONDS = 10;
const MIN_SAMPLE_BYTES = 1880;

function cleanSpace(s = "") {
  return String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function providerNumber(name = "") {
  const m = String(name).match(/^NFHS\s+Network\s+(\d+)\s*:/i);
  return m ? Number(m[1]) : null;
}

function redact(value, provider) {
  let s = String(value || "");
  if (provider?.username) s = s.split(provider.username).join("[USERNAME]");
  if (provider?.password) s = s.split(provider.password).join("[PASSWORD]");
  s = s.replace(/https?:\/\/[^\s"'\\]+/gi, "[REDACTED-URL]");
  return s.slice(0, 1200);
}

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 Georgia-NFHS-Diagnostic/15.0" }
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

function runProcess(command, args, timeoutMs = 15000) {
  return new Promise(resolve => {
    let settled = false;
    const stdout = [];
    const stderr = [];
    let timedOut = false;

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    child.stdout.on("data", b => stdout.push(b));
    child.stderr.on("data", b => stderr.push(b));

    child.on("error", err => {
      clearTimeout(timer);
      finish({
        ok: false,
        code: null,
        timed_out: timedOut,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        error: String(err?.message || err)
      });
    });

    child.on("close", code => {
      clearTimeout(timer);
      finish({
        ok: code === 0 && !timedOut,
        code,
        timed_out: timedOut,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString()
      });
    });
  });
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
  if (!Array.isArray(categories)) throw new Error("Xtream category response was not an array.");

  const wanted = cleanSpace(process.env.NFHS_CATEGORY_NAME || DEFAULT_CATEGORY).toLowerCase();
  let nfhsCategory = categories.find(c => cleanSpace(c.category_name).toLowerCase() === wanted);
  if (!nfhsCategory) nfhsCategory = categories.find(c => /nfhs/i.test(String(c.category_name || "")));
  if (!nfhsCategory) throw new Error("Could not find NFHS category.");

  const nfhsStreams = await fetchJson(
    `${base}/player_api.php?${auth}&action=get_live_streams&category_id=${encodeURIComponent(nfhsCategory.category_id)}`
  );

  return { base, username, password, auth, categories, nfhsCategory, nfhsStreams };
}

function streamUrl(provider, streamId, ext = "ts") {
  return `${provider.base}/live/${encodeURIComponent(provider.username)}/${encodeURIComponent(provider.password)}/${streamId}.${ext || "ts"}`;
}

async function selectNonNfhsControls(provider) {
  const candidateCategories = provider.categories
    .filter(c => String(c.category_id) !== String(provider.nfhsCategory.category_id))
    .filter(c => NON_NFHS_CATEGORY_RE.test(cleanSpace(c.category_name || "")))
    .slice(0, 12);

  const selected = [];

  for (const category of candidateCategories) {
    let streams;
    try {
      streams = await fetchJson(
        `${provider.base}/player_api.php?${provider.auth}&action=get_live_streams&category_id=${encodeURIComponent(category.category_id)}`
      );
    } catch {
      continue;
    }

    if (!Array.isArray(streams)) continue;

    const preferred = streams.filter(s => NON_NFHS_NAME_RE.test(cleanSpace(s.name || "")));
    const pool = preferred.length ? preferred : streams;

    for (const stream of pool) {
      if (selected.length >= MAX_NON_NFHS) return selected;
      if (!stream?.stream_id) continue;
      if (selected.some(x => String(x.stream.stream_id) === String(stream.stream_id))) continue;

      selected.push({
        kind: "non_nfhs_control",
        category_name: cleanSpace(category.category_name || ""),
        stream
      });
    }
  }

  return selected;
}

async function curlIpv4Sample(provider, target, tmpDir) {
  const ext = cleanSpace(target.stream.container_extension || "ts").replace(/^\./, "") || "ts";
  const out = path.join(tmpDir, `sample-${target.stream.stream_id}.${ext}`);
  const url = streamUrl(provider, target.stream.stream_id, ext);

  const started = Date.now();
  const result = await runProcess(
    "curl",
    [
      "-4",
      "-L",
      "--connect-timeout", "5",
      "--max-time", String(CURL_SECONDS),
      "--silent",
      "--show-error",
      "--user-agent", "Mozilla/5.0 Georgia-NFHS-Diagnostic/15.0",
      "--output", out,
      url
    ],
    (CURL_SECONDS + 5) * 1000
  );

  let bytes = 0;
  try {
    const st = await fs.stat(out);
    bytes = st.size;
  } catch {}

  let ffprobe = null;
  if (bytes >= MIN_SAMPLE_BYTES) {
    const probe = await runProcess(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height",
        "-of", "json",
        out
      ],
      10000
    );

    if (probe.ok) {
      try {
        ffprobe = JSON.parse(probe.stdout);
      } catch {
        ffprobe = { parse_error: true, raw: probe.stdout.slice(0, 500) };
      }
    } else {
      ffprobe = {
        error: redact(probe.stderr || probe.error || "ffprobe failed", provider)
      };
    }
  }

  try { await fs.rm(out, { force: true }); } catch {}

  return {
    bytes_saved: bytes,
    usable_bytes: bytes >= MIN_SAMPLE_BYTES,
    elapsed_ms: Date.now() - started,
    curl_exit_code: result.code,
    curl_timed_out: result.timed_out,
    curl_error: bytes >= MIN_SAMPLE_BYTES ? null : redact(result.stderr || result.error || "", provider),
    ffprobe
  };
}

async function main() {
  const provider = await getProvider();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nfhs-v15-"));

  const nfhsTargets = NFHS_CONTROLS
    .map(number => {
      const stream = provider.nfhsStreams.find(s => providerNumber(s.name || "") === number);
      return stream
        ? { kind: "nfhs_control", category_name: provider.nfhsCategory.category_name, stream }
        : null;
    })
    .filter(Boolean);

  const nonNfhsTargets = await selectNonNfhsControls(provider);
  const targets = [...nfhsTargets, ...nonNfhsTargets];

  console.log(`NFHS diagnostic v15: testing ${targets.length} streams sequentially with curl forced to IPv4.`);

  const results = [];

  for (const target of targets) {
    const number = target.kind === "nfhs_control" ? providerNumber(target.stream.name || "") : null;
    console.log(`Testing ${target.kind}: ${number ?? cleanSpace(target.stream.name || "").slice(0, 60)}`);

    const test = await curlIpv4Sample(provider, target, tmpDir);

    results.push({
      kind: target.kind,
      category_name: target.category_name,
      provider_nfhs_number: number,
      stream_id: target.stream.stream_id,
      title: cleanSpace(target.stream.name || ""),
      sample: test
    });
  }

  const nfhs = results.filter(x => x.kind === "nfhs_control");
  const nonNfhs = results.filter(x => x.kind === "non_nfhs_control");
  const nfhsWorking = nfhs.filter(x => x.sample.usable_bytes).length;
  const nonNfhsWorking = nonNfhs.filter(x => x.sample.usable_bytes).length;

  let diagnosis;
  if (nonNfhs.length && nonNfhsWorking === 0) {
    diagnosis = "github_runner_cannot_read_provider_stream_bodies";
  } else if (nonNfhsWorking > 0 && nfhsWorking === 0) {
    diagnosis = "provider_streaming_works_from_github_but_tested_nfhs_slots_are_not_delivering_video";
  } else if (nfhsWorking > 0) {
    diagnosis = "forced_ipv4_can_read_nfhs_stream_bytes_from_github";
  } else {
    diagnosis = "inconclusive_no_non_nfhs_controls_found";
  }

  const payload = {
    generated_at: new Date().toISOString(),
    diagnostic_only: true,
    modifies_epg: false,
    diagnostic_version: 15,
    purpose: "Separate GitHub-runner/provider network blocking from dead NFHS slots by forcing IPv4 with curl and comparing known NFHS slots against ordinary non-NFHS provider channels likely to be continuously live.",
    safety: {
      provider_connections_used_concurrently: 1,
      samples_saved_to_repository: false,
      credentials_written_to_output: false,
      public_events_json_modified: false
    },
    summary: {
      nfhs_controls_tested: nfhs.length,
      nfhs_controls_with_stream_bytes: nfhsWorking,
      non_nfhs_controls_tested: nonNfhs.length,
      non_nfhs_controls_with_stream_bytes: nonNfhsWorking,
      diagnosis
    },
    results
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile("public/nfhs-diagnostic.json", JSON.stringify(payload, null, 2) + "\n", "utf8");
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}

  console.log("Diagnostic v15 complete.");
  console.log(JSON.stringify(payload.summary, null, 2));
  console.log("public/events.json was NOT modified.");
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
