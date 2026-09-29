import fs from "node:fs/promises";
import crypto from "node:crypto";

const DEFAULT_CATEGORY = "USA | NFHS Network";

/*
  These are events where we already know BOTH:
  1. the official NFHS event ID
  2. the provider NFHS channel number

  If there is a hidden source-ID relationship, these controls
  should reveal the same pattern repeatedly.
*/
const CONTROLS = [
  {
    label: "Long County vs St. Vincent's",
    event_id: "gam302604b4e5",
    provider_nfhs_number: 3455
  },
  {
    label: "Cary vs Holly Springs",
    event_id: "gam7a4d71b081",
    provider_nfhs_number: 3514
  },
  {
    label: "Sanderson vs Middle Creek",
    event_id: "gambb59c64f73",
    provider_nfhs_number: 3556
  },
  {
    label: "Camden County vs Savannah Country Day",
    event_id: "gamd493cc6a81",
    provider_nfhs_number: 3572
  },
  {
    label: "Frederica Academy vs Bradwell Institute",
    event_id: "gamee5d943f7a",
    provider_nfhs_number: 3596
  }
];

function cleanSpace(s = "") {
  return String(s)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sha(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 20);
}

function providerNumber(name = "") {
  const m = String(name).match(
    /^NFHS\s+Network\s+(\d+)\s*:/i
  );

  return m ? Number(m[1]) : null;
}

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();

  const timer = setTimeout(
    () => ac.abort(),
    timeoutMs
  );

  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 Georgia-NFHS-Diagnostic/11.0"
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
      cleanSpace(
        c.category_name
      ).toLowerCase() === wanted
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

/*
  Walk only the broadcast/VOD metadata and collect identifier-like
  strings.

  URLs are deliberately ignored. We do NOT need or use NFHS
  playback URLs for this test.
*/
function collectIdentifierStrings(
  value,
  path = "",
  out = []
) {
  if (
    value === null ||
    value === undefined
  ) {
    return out;
  }

  if (typeof value === "string") {
    const s = value.trim();

    if (s.length < 8) {
      return out;
    }

    if (/^https?:\/\//i.test(s)) {
      return out;
    }

    if (
      /^\d{4}-\d{2}-\d{2}T/i.test(s)
    ) {
      return out;
    }

    if (
      /^(scheduled|complete|on_air|live|ready|archived)$/i.test(
        s
      )
    ) {
      return out;
    }

    out.push({
      path,
      raw: s,
      fingerprint: sha(s)
    });

    return out;
  }

  if (
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    const s = String(value);

    if (s.length >= 8) {
      out.push({
        path,
        raw: s,
        fingerprint: sha(s)
      });
    }

    return out;
  }

  if (Array.isArray(value)) {
    value.forEach(
      (item, index) => {
        collectIdentifierStrings(
          item,
          `${path}[${index}]`,
          out
        );
      }
    );

    return out;
  }

  if (typeof value === "object") {
    for (
      const [key, child]
      of Object.entries(value)
    ) {
      collectIdentifierStrings(
        child,
        path
          ? `${path}.${key}`
          : key,
        out
      );
    }
  }

  return out;
}

async function getOfficialFingerprintData(eventId) {
  const data = await fetchJson(
    `https://cfunity.nfhsnetwork.com/v2/game_or_event/${eventId}`
  );

  const publishers =
    Array.isArray(data?.publishers)
      ? data.publishers
      : [];

  const roots = [];

  publishers.forEach(
    (publisher, pIndex) => {
      if (
        Array.isArray(
          publisher?.broadcasts
        )
      ) {
        publisher.broadcasts.forEach(
          (broadcast, bIndex) => {
            roots.push({
              path:
                `publishers[${pIndex}].broadcasts[${bIndex}]`,
              value:
                broadcast
            });
          }
        );
      }

      if (
        Array.isArray(
          publisher?.vods
        )
      ) {
        publisher.vods.forEach(
          (vod, vIndex) => {
            roots.push({
              path:
                `publishers[${pIndex}].vods[${vIndex}]`,
              value:
                vod
            });
          }
        );
      }
    }
  );

  const candidates = [];

  for (const root of roots) {
    collectIdentifierStrings(
      root.value,
      root.path,
      candidates
    );
  }

  /*
    Deduplicate by raw value but output only the fingerprint.
  */
  const unique = [
    ...new Map(
      candidates.map(
        x => [
          x.raw,
          x
        ]
      )
    ).values()
  ];

  return {
    raw_candidates:
      unique,

    public_candidates:
      unique.map(
        x => ({
          field_path:
            x.path,

          fingerprint:
            x.fingerprint
        })
      )
  };
}

function urlPieces(rawUrl) {
  const pieces = [];

  try {
    const u =
      new URL(rawUrl);

    for (
      const part
      of u.pathname.split("/")
    ) {
      let decoded = "";

      try {
        decoded =
          decodeURIComponent(part);
      } catch {
        decoded = part;
      }

      decoded =
        decoded.trim();

      if (
        decoded.length >= 8
      ) {
        pieces.push({
          location:
            "path_segment",

          raw:
            decoded,

          fingerprint:
            sha(decoded)
        });
      }
    }

    for (
      const [key, value]
      of u.searchParams.entries()
    ) {
      const decoded =
        String(value).trim();

      if (
        decoded.length >= 8
      ) {
        pieces.push({
          location:
            `query:${key}`,

          raw:
            decoded,

          fingerprint:
            sha(decoded)
        });
      }
    }

    const pathname =
      u.pathname.trim();

    if (
      pathname.length >= 8
    ) {
      pieces.push({
        location:
          "pathname",

        raw:
          pathname,

        fingerprint:
          sha(pathname)
      });
    }

  } catch {}

  return pieces;
}

async function requestOneHop(
  url,
  timeoutMs = 8000
) {
  const ac =
    new AbortController();

  const timer =
    setTimeout(
      () => ac.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(url, {
        signal:
          ac.signal,

        redirect:
          "manual",

        headers: {
          "User-Agent":
            "Mozilla/5.0 Georgia-NFHS-Diagnostic/11.0"
        }
      });

    const status =
      response.status;

    const location =
      response.headers.get(
        "location"
      );

    const headers =
      Object.fromEntries(
        response.headers.entries()
      );

    try {
      await response.body?.cancel();
    } catch {}

    return {
      status,
      location,
      headers
    };

  } finally {
    clearTimeout(timer);
  }
}

async function inspectRedirectChain(
  provider,
  streamId
) {
  let current =
    `${provider.base}/live/` +
    `${encodeURIComponent(
      provider.username
    )}/` +
    `${encodeURIComponent(
      provider.password
    )}/` +
    `${streamId}.ts`;

  const rawUrls = [];
  const rawPieces = [];
  const publicChain = [];

  for (
    let hop = 0;
    hop < 6;
    hop++
  ) {
    rawUrls.push(current);

    rawPieces.push(
      ...urlPieces(current)
    );

    let parsedCurrent = null;

    try {
      parsedCurrent =
        new URL(current);
    } catch {}

    let result;

    try {
      result =
        await requestOneHop(
          current
        );

    } catch (err) {
      publicChain.push({
        hop,
        host:
          parsedCurrent?.hostname ||
          null,

        error:
          String(
            err?.message ||
            err
          )
      });

      break;
    }

    /*
      Header VALUES are used internally for comparison but are never
      printed raw.
    */
    for (
      const [key, value]
      of Object.entries(
        result.headers || {}
      )
    ) {
      const text =
        String(value || "");

      if (
        text.length >= 8
      ) {
        rawPieces.push({
          location:
            `header:${key}`,

          raw:
            text,

          fingerprint:
            sha(text)
        });

        /*
          Also pull URL pieces from any header value that happens
          to contain a URL.
        */
        if (
          /^https?:\/\//i.test(text)
        ) {
          rawPieces.push(
            ...urlPieces(text)
          );
        }
      }
    }

    let nextUrl = null;
    let nextHost = null;

    if (
      result.location
    ) {
      try {
        nextUrl =
          new URL(
            result.location,
            current
          ).toString();

        nextHost =
          new URL(
            nextUrl
          ).hostname;

        rawUrls.push(nextUrl);

        rawPieces.push(
          ...urlPieces(nextUrl)
        );

      } catch {}
    }

    publicChain.push({
      hop,

      status:
        result.status,

      host:
        parsedCurrent?.hostname ||
        null,

      next_host:
        nextHost,

      header_names:
        Object.keys(
          result.headers || {}
        ).sort()
    });

    if (
      !nextUrl ||
      ![301, 302, 303, 307, 308]
        .includes(
          result.status
        )
    ) {
      break;
    }

    current =
      nextUrl;
  }

  const uniquePieces = [
    ...new Map(
      rawPieces.map(
        x => [
          `${x.location}|${x.raw}`,
          x
        ]
      )
    ).values()
  ];

  return {
    raw_urls:
      rawUrls,

    raw_pieces:
      uniquePieces,

    public_chain:
      publicChain,

    public_piece_fingerprints:
      uniquePieces.map(
        x => ({
          location:
            x.location,

          fingerprint:
            x.fingerprint
        })
      )
  };
}

function compareFingerprints(
  official,
  providerRedirect
) {
  const matches = [];

  for (
    const off
    of official.raw_candidates
  ) {
    for (
      const piece
      of providerRedirect.raw_pieces
    ) {
      const a =
        String(off.raw);

      const b =
        String(piece.raw);

      let matchType = null;

      if (a === b) {
        matchType =
          "exact";

      } else if (
        a.length >= 8 &&
        b.includes(a)
      ) {
        matchType =
          "official_identifier_inside_provider_value";

      } else if (
        b.length >= 8 &&
        a.includes(b)
      ) {
        matchType =
          "provider_value_inside_official_identifier";
      }

      if (!matchType) {
        continue;
      }

      matches.push({
        match_type:
          matchType,

        official_field_path:
          off.path,

        official_fingerprint:
          off.fingerprint,

        provider_location:
          piece.location,

        provider_fingerprint:
          piece.fingerprint
      });
    }

    /*
      Also test against complete redirect URLs without ever
      outputting those URLs.
    */
    for (
      const rawUrl
      of providerRedirect.raw_urls
    ) {
      if (
        String(off.raw).length >= 8 &&
        String(rawUrl).includes(
          String(off.raw)
        )
      ) {
        matches.push({
          match_type:
            "official_identifier_inside_redirect_url",

          official_field_path:
            off.path,

          official_fingerprint:
            off.fingerprint,

          provider_location:
            "redirect_url",

          provider_fingerprint:
            sha(rawUrl)
        });
      }
    }
  }

  return [
    ...new Map(
      matches.map(
        x => [
          JSON.stringify(x),
          x
        ]
      )
    ).values()
  ];
}

function findConsistentFields(results) {
  const counts =
    new Map();

  for (
    const result
    of results
  ) {
    const seenInControl =
      new Set();

    for (
      const match
      of result.matches || []
    ) {
      const key =
        `${match.official_field_path}` +
        ` → ${match.provider_location}`;

      seenInControl.add(key);
    }

    for (
      const key
      of seenInControl
    ) {
      counts.set(
        key,
        (
          counts.get(key) ||
          0
        ) + 1
      );
    }
  }

  return [
    ...counts.entries()
  ]
    .map(
      ([relationship, control_count]) => ({
        relationship,
        control_count
      })
    )
    .sort(
      (a, b) =>
        b.control_count -
        a.control_count
    );
}

async function main() {
  const provider =
    await getProvider();

  const results = [];

  for (
    const control
    of CONTROLS
  ) {
    console.log(
      `Testing ${control.label}`
    );

    const stream =
      provider.streams.find(
        s =>
          providerNumber(
            s.name || ""
          ) ===
          control.provider_nfhs_number
      );

    if (!stream) {
      results.push({
        ...control,
        provider_stream_found:
          false
      });

      continue;
    }

    let official;

    try {
      official =
        await getOfficialFingerprintData(
          control.event_id
        );

    } catch (err) {
      results.push({
        ...control,

        provider_stream_found:
          true,

        stream_id:
          stream.stream_id,

        provider_title:
          cleanSpace(
            stream.name || ""
          ),

        official_metadata_error:
          String(
            err?.message ||
            err
          )
      });

      continue;
    }

    const redirects =
      await inspectRedirectChain(
        provider,
        stream.stream_id
      );

    const matches =
      compareFingerprints(
        official,
        redirects
      );

    results.push({
      label:
        control.label,

      event_id:
        control.event_id,

      provider_nfhs_number:
        control.provider_nfhs_number,

      provider_stream_found:
        true,

      stream_id:
        stream.stream_id,

      provider_title:
        cleanSpace(
          stream.name || ""
        ),

      official_identifier_fingerprints:
        official.public_candidates,

      provider_redirect_chain:
        redirects.public_chain,

      provider_source_fingerprints:
        redirects.public_piece_fingerprints,

      matches,

      correlation_found:
        matches.length > 0
    });
  }

  const correlatedControls =
    results.filter(
      x =>
        x.correlation_found
    );

  const consistent =
    findConsistentFields(
      results
    );

  const bestRelationship =
    consistent[0] ||
    null;

  const usableRelationship =
    Boolean(
      bestRelationship &&
      bestRelationship.control_count >= 2
    );

  const payload = {
    generated_at:
      new Date().toISOString(),

    diagnostic_only:
      true,

    modifies_epg:
      false,

    diagnostic_version:
      11,

    purpose:
      "Test whether provider redirect/source identifiers correlate with identifier-like values in official NFHS broadcast metadata using known event-to-provider control pairs. Raw NFHS identifiers, provider source paths, playback URLs, and credentials are never written to this file.",

    provider: {
      category:
        provider.category
          ?.category_name ||
        DEFAULT_CATEGORY,

      source_stream_count:
        provider.streams.length
    },

    summary: {
      controls_tested:
        results.length,

      controls_with_source_correlation:
        correlatedControls.length,

      repeated_relationships:
        consistent,

      usable_repeated_relationship_found:
        usableRelationship,

      next_step:
        usableRelationship
          ? "A repeated source relationship was found. Use it in a follow-up diagnostic to scan later Georgia NFHS events against active provider slots."
          : "No repeated direct source identifier relationship was found across the known controls. Source-fingerprint matching is not a reliable mapping method with this provider."
    },

    controls:
      results
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
    "Diagnostic v11 complete."
  );

  console.log(
    `Controls with correlation: ${correlatedControls.length}/${results.length}`
  );

  console.log(
    `Usable repeated relationship: ${usableRelationship}`
  );

  console.log(
    "Raw NFHS identifiers and provider source URLs were NOT written."
  );

  console.log(
    "public/events.json was NOT modified."
  );
}

main().catch(
  err => {
    console.error(
      err?.stack ||
      err?.message ||
      String(err)
    );

    process.exit(1);
  }
);
