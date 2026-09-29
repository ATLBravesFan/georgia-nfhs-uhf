import fs from "node:fs/promises";

const DEFAULT_CATEGORY = "USA | NFHS Network";

const TEST_CHANNELS = [
  3551,
  3552,
  3553,
  3572
];

function cleanSpace(s = "") {
  return String(s)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function providerNumber(name = "") {
  const m = String(name).match(
    /^NFHS\s+Network\s+(\d+)\s*:/i
  );

  return m ? Number(m[1]) : null;
}

function redact(value, username, password) {
  if (value === null || value === undefined) {
    return value;
  }

  let s =
    typeof value === "string"
      ? value
      : JSON.stringify(value);

  if (username) {
    s = s.split(username).join("[USERNAME]");
  }

  if (password) {
    s = s.split(password).join("[PASSWORD]");
  }

  s = s.replace(
    /https?:\/\/[^\s"'\\]+/gi,
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

async function fetchText(
  url,
  options = {},
  timeoutMs = 20000
) {
  const ac = new AbortController();
  const timer =
    setTimeout(
      () => ac.abort(),
      timeoutMs
    );

  try {
    const r =
      await fetch(url, {
        ...options,
        signal: ac.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 Georgia-NFHS-Diagnostic/9.0",
          ...(options.headers || {})
        }
      });

    const text =
      await r.text();

    return {
      ok: r.ok,
      status: r.status,
      statusText:
        r.statusText,
      url:
        r.url,
      headers:
        Object.fromEntries(
          r.headers.entries()
        ),
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const r =
    await fetchText(url);

  if (!r.ok) {
    throw new Error(
      `${r.status} ${r.statusText}: ` +
      r.text.slice(0, 200)
    );
  }

  return JSON.parse(r.text);
}

async function getProvider() {
  const base =
    cleanSpace(
      process.env.XTREAM_BASE_URL || ""
    ).replace(/\/+$/, "");

  const username =
    process.env.XTREAM_USERNAME || "";

  const password =
    process.env.XTREAM_PASSWORD || "";

  if (!base || !username || !password) {
    throw new Error(
      "Missing XTREAM credentials."
    );
  }

  const auth =
    `username=${encodeURIComponent(username)}` +
    `&password=${encodeURIComponent(password)}`;

  const categories =
    await fetchJson(
      `${base}/player_api.php?${auth}` +
      `&action=get_live_categories`
    );

  const wanted =
    cleanSpace(
      process.env.NFHS_CATEGORY_NAME ||
      DEFAULT_CATEGORY
    ).toLowerCase();

  let category =
    categories.find(
      c =>
        cleanSpace(
          c.category_name
        ).toLowerCase() === wanted
    );

  if (!category) {
    category =
      categories.find(
        c =>
          /nfhs/i.test(
            String(
              c.category_name || ""
            )
          )
      );
  }

  if (!category) {
    throw new Error(
      "Could not find NFHS category."
    );
  }

  let streams =
    await fetchJson(
      `${base}/player_api.php?${auth}` +
      `&action=get_live_streams` +
      `&category_id=${encodeURIComponent(
        category.category_id
      )}`
    );

  streams =
    streams.filter(
      s =>
        String(s.category_id) ===
          String(category.category_id) ||
        !s.category_id
    );

  return {
    base,
    username,
    password,
    auth,
    category,
    streams
  };
}

async function safeApiProbe(
  provider,
  action,
  streamId
) {
  const url =
    `${provider.base}/player_api.php?` +
    `${provider.auth}` +
    `&action=${encodeURIComponent(action)}` +
    `&stream_id=${encodeURIComponent(
      streamId
    )}`;

  try {
    const r =
      await fetchText(url);

    let parsed = null;

    try {
      parsed =
        JSON.parse(r.text);
    } catch {
      parsed =
        r.text.slice(0, 4000);
    }

    return {
      ok: r.ok,
      status: r.status,
      response:
        redact(
          parsed,
          provider.username,
          provider.password
        )
    };
  } catch (err) {
    return {
      ok: false,
      error:
        redact(
          String(
            err?.message || err
          ),
          provider.username,
          provider.password
        )
    };
  }
}

async function inspectStreamHeaders(
  provider,
  streamId
) {
  const url =
    `${provider.base}/live/` +
    `${encodeURIComponent(
      provider.username
    )}/` +
    `${encodeURIComponent(
      provider.password
    )}/` +
    `${streamId}.ts`;

  const ac =
    new AbortController();

  const timer =
    setTimeout(
      () => ac.abort(),
      10000
    );

  try {
    const r =
      await fetch(url, {
        signal:
          ac.signal,

        redirect:
          "follow",

        headers: {
          "User-Agent":
            "Mozilla/5.0 Georgia-NFHS-Diagnostic/9.0"
        }
      });

    const headers =
      Object.fromEntries(
        r.headers.entries()
      );

    try {
      await r.body?.cancel();
    } catch {}

    return {
      ok: r.ok,
      status:
        r.status,

      final_url:
        redact(
          r.url,
          provider.username,
          provider.password
        ),

      headers:
        Object.fromEntries(
          Object.entries(headers)
            .map(
              ([k, v]) => [
                k,
                redact(
                  v,
                  provider.username,
                  provider.password
                )
              ]
            )
        )
    };
  } catch (err) {
    return {
      ok: false,
      error:
        redact(
          String(
            err?.message || err
          ),
          provider.username,
          provider.password
        )
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getM3u(provider) {
  const url =
    `${provider.base}/get.php?` +
    `username=${encodeURIComponent(
      provider.username
    )}` +
    `&password=${encodeURIComponent(
      provider.password
    )}` +
    `&type=m3u_plus&output=ts`;

  try {
    const r =
      await fetchText(
        url,
        {},
        30000
      );

    return {
      ok: r.ok,
      text: r.text
    };
  } catch (err) {
    return {
      ok: false,
      error:
        String(
          err?.message || err
        ),
      text: ""
    };
  }
}

function findM3uEntry(
  m3uText,
  streamId,
  provider
) {
  if (!m3uText) {
    return null;
  }

  const lines =
    m3uText
      .split(/\r?\n/);

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {
    const line =
      lines[i];

    if (
      !line.includes(
        String(streamId)
      )
    ) {
      continue;
    }

    const prior =
      i > 0
        ? lines[i - 1]
        : "";

    return {
      extinf:
        redact(
          prior,
          provider.username,
          provider.password
        ),

      stream_line:
        redact(
          line,
          provider.username,
          provider.password
        )
    };
  }

  return null;
}

async function main() {
  const provider =
    await getProvider();

  console.log(
    "Downloading provider M3U for diagnostic..."
  );

  const m3u =
    await getM3u(
      provider
    );

  const channels = [];

  for (
    const number
    of TEST_CHANNELS
  ) {
    const stream =
      provider.streams.find(
        s =>
          providerNumber(
            s.name || ""
          ) === number
      );

    if (!stream) {
      channels.push({
        provider_nfhs_number:
          number,
        found: false
      });

      continue;
    }

    console.log(
      `Inspecting NFHS ${number} / ${stream.stream_id}`
    );

    const [
      liveInfo,
      shortEpg,
      dataTable,
      headers
    ] =
      await Promise.all([
        safeApiProbe(
          provider,
          "get_live_info",
          stream.stream_id
        ),

        safeApiProbe(
          provider,
          "get_short_epg",
          stream.stream_id
        ),

        safeApiProbe(
          provider,
          "get_simple_data_table",
          stream.stream_id
        ),

        inspectStreamHeaders(
          provider,
          stream.stream_id
        )
      ]);

    channels.push({
      provider_nfhs_number:
        number,

      found:
        true,

      stream_id:
        stream.stream_id,

      provider_title:
        cleanSpace(
          stream.name || ""
        ),

      epg_channel_id:
        stream.epg_channel_id ??
        null,

      direct_source_present:
        Boolean(
          cleanSpace(
            stream.direct_source ||
            ""
          )
        ),

      stream_icon:
        redact(
          stream.stream_icon ??
          null,
          provider.username,
          provider.password
        ),

      m3u_entry:
        findM3uEntry(
          m3u.text,
          stream.stream_id,
          provider
        ),

      get_live_info:
        liveInfo,

      get_short_epg:
        shortEpg,

      get_simple_data_table:
        dataTable,

      http_stream_response:
        headers
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
      9,

    purpose:
      "Inspect provider-side metadata, M3U attributes, Xtream responses, and HTTP stream headers for mislabeled NFHS streams.",

    provider: {
      category:
        provider.category
          ?.category_name ||
        DEFAULT_CATEGORY,

      source_stream_count:
        provider.streams.length,

      m3u_download_ok:
        m3u.ok
    },

    channels
  };

  await fs.mkdir(
    "public",
    {
      recursive: true
    }
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
    "Diagnostic v9 complete."
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
