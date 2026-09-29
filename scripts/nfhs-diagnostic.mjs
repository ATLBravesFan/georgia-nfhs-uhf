import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const DEFAULT_CATEGORY = "USA | NFHS Network";

const PROBE_CHANNELS = [
  {
    provider_nfhs_number: 3551,
    note: "Known neighboring control"
  },
  {
    provider_nfhs_number: 3552,
    note: "Suspicious slot currently showing volleyball"
  },
  {
    provider_nfhs_number: 3553,
    note: "Known neighboring control"
  },
  {
    provider_nfhs_number: 3572,
    note: "Known Camden Georgia control"
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
        "User-Agent":
          "Mozilla/5.0 Georgia-NFHS-Diagnostic/8.0"
      }
    });

    const text = await r.text();

    if (!r.ok) {
      throw new Error(
        `${r.status} ${r.statusText}: ${text.slice(0, 200)}`
      );
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 20000) {
  return JSON.parse(
    await fetchText(url, timeoutMs)
  );
}

async function getProvider() {
  const base = cleanSpace(
    process.env.XTREAM_BASE_URL || ""
  ).replace(/\/+$/, "");

  const username =
    process.env.XTREAM_USERNAME || "";

  const password =
    process.env.XTREAM_PASSWORD || "";

  if (!base || !username || !password) {
    throw new Error(
      "Missing XTREAM_BASE_URL, XTREAM_USERNAME, or XTREAM_PASSWORD."
    );
  }

  const auth =
    `username=${encodeURIComponent(username)}` +
    `&password=${encodeURIComponent(password)}`;

  const categories = await fetchJson(
    `${base}/player_api.php?${auth}` +
    `&action=get_live_categories`
  );

  const wanted = cleanSpace(
    process.env.NFHS_CATEGORY_NAME ||
    DEFAULT_CATEGORY
  ).toLowerCase();

  let category = categories.find(
    c =>
      cleanSpace(c.category_name)
        .toLowerCase() === wanted
  );

  if (!category) {
    category = categories.find(
      c =>
        /nfhs/i.test(
          String(c.category_name || "")
        )
    );
  }

  if (!category) {
    throw new Error(
      "Could not find NFHS category."
    );
  }

  let streams = await fetchJson(
    `${base}/player_api.php?${auth}` +
    `&action=get_live_streams` +
    `&category_id=${encodeURIComponent(
      category.category_id
    )}`
  );

  streams = streams.filter(
    s =>
      String(s.category_id) ===
        String(category.category_id) ||
      !s.category_id
  );

  return {
    base,
    username,
    password,
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

function sanitizeString(
  value,
  username,
  password
) {
  if (value === null || value === undefined) {
    return value;
  }

  let s = String(value);

  if (username) {
    s = s.split(username).join("[USERNAME]");
  }

  if (password) {
    s = s.split(password).join("[PASSWORD]");
  }

  s = s.replace(
    /https?:\/\/[^\s"']+/gi,
    raw => {
      try {
        const u = new URL(raw);

        return (
          `${u.protocol}//${u.hostname}` +
          (u.port ? `:${u.port}` : "") +
          "/[REDACTED]"
        );
      } catch {
        return "[REDACTED-URL]";
      }
    }
  );

  return s;
}

function sanitizeTags(
  tags,
  username,
  password
) {
  if (!tags || typeof tags !== "object") {
    return {};
  }

  const out = {};

  for (const [key, value] of Object.entries(tags)) {
    out[key] = sanitizeString(
      value,
      username,
      password
    );
  }

  return out;
}

function runFfprobe(url, timeoutMs = 12000) {
  return new Promise(resolve => {
    const args = [
      "-hide_banner",
      "-v",
      "error",

      "-analyzeduration",
      "5000000",

      "-probesize",
      "5000000",

      "-show_format",
      "-show_streams",
      "-show_programs",

      "-of",
      "json",

      url
    ];

    const child = spawn(
      "ffprobe",
      args,
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      }
    );

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on(
      "data",
      chunk => {
        stdout += chunk.toString();
      }
    );

    child.stderr.on(
      "data",
      chunk => {
        stderr += chunk.toString();
      }
    );

    child.on("close", code => {
      clearTimeout(timer);

      if (code !== 0) {
        resolve({
          ok: false,
          code,
          error:
            stderr.slice(0, 1000)
        });

        return;
      }

      try {
        resolve({
          ok: true,
          data: JSON.parse(stdout)
        });
      } catch (err) {
        resolve({
          ok: false,
          code,
          error:
            `Could not parse ffprobe JSON: ${err.message}`
        });
      }
    });

    child.on("error", err => {
      clearTimeout(timer);

      resolve({
        ok: false,
        error: String(
          err?.message || err
        )
      });
    });
  });
}

function buildProbeUrls(provider, streamId) {
  const user =
    encodeURIComponent(
      provider.username
    );

  const pass =
    encodeURIComponent(
      provider.password
    );

  return [
    {
      type: "live-ts",
      url:
        `${provider.base}/live/` +
        `${user}/${pass}/` +
        `${streamId}.ts`
    },
    {
      type: "live-m3u8",
      url:
        `${provider.base}/live/` +
        `${user}/${pass}/` +
        `${streamId}.m3u8`
    },
    {
      type: "direct-path",
      url:
        `${provider.base}/` +
        `${user}/${pass}/` +
        `${streamId}`
    }
  ];
}

async function probeStream(
  provider,
  stream
) {
  const candidates =
    buildProbeUrls(
      provider,
      stream.stream_id
    );

  const attempts = [];

  for (const candidate of candidates) {
    const result =
      await runFfprobe(
        candidate.url
      );

    attempts.push({
      type:
        candidate.type,

      ok:
        result.ok,

      error:
        result.ok
          ? null
          : sanitizeString(
              result.error,
              provider.username,
              provider.password
            )
    });

    if (!result.ok) {
      continue;
    }

    const data =
      result.data || {};

    const format =
      data.format || {};

    const streams =
      Array.isArray(data.streams)
        ? data.streams
        : [];

    const programs =
      Array.isArray(data.programs)
        ? data.programs
        : [];

    return {
      probe_ok: true,

      successful_endpoint_type:
        candidate.type,

      format: {
        format_name:
          format.format_name ?? null,

        format_long_name:
          format.format_long_name ?? null,

        duration:
          format.duration ?? null,

        bit_rate:
          format.bit_rate ?? null,

        tags:
          sanitizeTags(
            format.tags,
            provider.username,
            provider.password
          )
      },

      programs:
        programs.map(p => ({
          program_id:
            p.program_id ?? null,

          program_num:
            p.program_num ?? null,

          tags:
            sanitizeTags(
              p.tags,
              provider.username,
              provider.password
            ),

          stream_indexes:
            Array.isArray(p.streams)
              ? p.streams.map(
                  s => s.index
                )
              : []
        })),

      streams:
        streams.map(s => ({
          index:
            s.index ?? null,

          codec_type:
            s.codec_type ?? null,

          codec_name:
            s.codec_name ?? null,

          codec_long_name:
            s.codec_long_name ?? null,

          width:
            s.width ?? null,

          height:
            s.height ?? null,

          sample_rate:
            s.sample_rate ?? null,

          channels:
            s.channels ?? null,

          bit_rate:
            s.bit_rate ?? null,

          tags:
            sanitizeTags(
              s.tags,
              provider.username,
              provider.password
            )
        })),

      attempts
    };
  }

  return {
    probe_ok: false,
    attempts
  };
}

function collectInterestingTags(probe) {
  if (!probe?.probe_ok) {
    return [];
  }

  const values = [];

  function add(section, tags) {
    if (!tags) return;

    for (
      const [key, value]
      of Object.entries(tags)
    ) {
      if (
        value !== null &&
        value !== undefined &&
        String(value).trim()
      ) {
        values.push({
          section,
          key,
          value
        });
      }
    }
  }

  add(
    "format",
    probe.format?.tags
  );

  for (
    const program
    of probe.programs || []
  ) {
    add(
      `program:${program.program_id}`,
      program.tags
    );
  }

  for (
    const stream
    of probe.streams || []
  ) {
    add(
      `stream:${stream.index}`,
      stream.tags
    );
  }

  return values;
}

async function main() {
  const provider =
    await getProvider();

  const results = [];

  for (
    const wanted
    of PROBE_CHANNELS
  ) {
    const stream =
      provider.streams.find(
        s =>
          providerNumber(
            s.name || ""
          ) ===
          wanted.provider_nfhs_number
      );

    if (!stream) {
      results.push({
        provider_nfhs_number:
          wanted.provider_nfhs_number,

        note:
          wanted.note,

        found:
          false
      });

      continue;
    }

    console.log(
      `Probing NFHS ${wanted.provider_nfhs_number} / stream ${stream.stream_id}`
    );

    const probe =
      await probeStream(
        provider,
        stream
      );

    results.push({
      provider_nfhs_number:
        wanted.provider_nfhs_number,

      note:
        wanted.note,

      found:
        true,

      stream_id:
        stream.stream_id,

      provider_title:
        cleanSpace(
          stream.name || ""
        ),

      provider_added:
        stream.added ?? null,

      epg_channel_id:
        stream.epg_channel_id ?? null,

      probe,

      interesting_tags:
        collectInterestingTags(
          probe
        )
    });
  }

  const payload = {
    generated_at:
      new Date().toISOString(),

    diagnostic_only:
      true,

    modifies_epg:
      false,

    diagnostic_version:
      8,

    purpose:
      "Inspect safe technical metadata from suspicious and known-good NFHS provider streams without changing the live EPG.",

    provider: {
      category:
        provider.category
          ?.category_name ||
        DEFAULT_CATEGORY,

      source_stream_count:
        provider.streams.length
    },

    channels:
      results
  };

  await fs.mkdir(
    "public",
    { recursive: true }
  );

  await fs.writeFile(
    "public/nfhs-diagnostic.json",
    JSON.stringify(
      payload,
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(
    "Diagnostic v8 complete."
  );

  console.log(
    "public/events.json was NOT modified."
  );
}

main().catch(err => {
  console.error(
    err?.stack ||
    err?.message ||
    String(err)
  );

  process.exit(1);
});
