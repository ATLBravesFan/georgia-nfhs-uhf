import fs from "node:fs/promises";
import crypto from "node:crypto";
import * as cheerio from "cheerio";

const DEFAULT_CATEGORY = "USA | NFHS Network";

const NFHS_GHSA_PAGE =
  "https://get.nfhsnetwork.com/associations/ghsa/";

const CONTROL_GAMES = [
  {
    role: "target",
    label: "Clinch County vs. Brantley County",
    search_terms: ["Clinch County", "Brantley"],
    known_event_id: "gamb8ad8195a3",
    known_provider_stream_id: null,
    known_provider_nfhs_number: null
  },
  {
    role: "control",
    label: "North Georgia Tribe vs. Sugar Hill Christian Academy",
    search_terms: ["North GA Tribe", "Sugar Hill"],
    known_event_id: null,
    known_provider_stream_id: 2066864,
    known_provider_nfhs_number: 3448
  },
  {
    role: "control",
    label: "Long County vs. St. Vincent's Academy",
    search_terms: ["Long County", "St. Vincent"],
    known_event_id: null,
    known_provider_stream_id: 2066857,
    known_provider_nfhs_number: 3455
  },
  {
    role: "control",
    label: "Camden County vs. Savannah Country Day",
    search_terms: ["Camden County", "Savannah Country Day"],
    known_event_id: "gamd493cc6a81",
    known_provider_stream_id: 2066737,
    known_provider_nfhs_number: 3572
  },
  {
    role: "control",
    label: "Frederica Academy vs. Bradwell Institute",
    search_terms: ["Frederica", "Bradwell"],
    known_event_id: null,
    known_provider_stream_id: 2066711,
    known_provider_nfhs_number: 3596
  }
];

function cleanSpace(s = "") {
  return String(s)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(s = "") {
  return cleanSpace(s)
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashValue(v) {
  if (!v) return null;

  return crypto
    .createHash("sha256")
    .update(String(v))
    .digest("hex")
    .slice(0, 20);
}

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 Georgia-NFHS-Diagnostic/3.0"
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
  return JSON.parse(await fetchText(url, timeoutMs));
}

async function getProvider() {
  const base = cleanSpace(
    process.env.XTREAM_BASE_URL || ""
  ).replace(/\/+$/, "");

  const username = process.env.XTREAM_USERNAME || "";
  const password = process.env.XTREAM_PASSWORD || "";

  if (!base || !username || !password) {
    throw new Error(
      "Missing XTREAM_BASE_URL, XTREAM_USERNAME, or XTREAM_PASSWORD."
    );
  }

  const auth =
    `username=${encodeURIComponent(username)}` +
    `&password=${encodeURIComponent(password)}`;

  const categories = await fetchJson(
    `${base}/player_api.php?${auth}&action=get_live_categories`
  );

  const wanted = cleanSpace(
    process.env.NFHS_CATEGORY_NAME || DEFAULT_CATEGORY
  ).toLowerCase();

  let category = categories.find(
    c =>
      cleanSpace(c.category_name).toLowerCase() === wanted
  );

  if (!category) {
    category = categories.find(
      c => /nfhs/i.test(String(c.category_name || ""))
    );
  }

  if (!category) {
    throw new Error("Could not find NFHS category.");
  }

  let streams = await fetchJson(
    `${base}/player_api.php?${auth}` +
    `&action=get_live_streams` +
    `&category_id=${encodeURIComponent(category.category_id)}`
  );

  streams = streams.filter(
    s =>
      String(s.category_id) ===
        String(category.category_id) ||
      !s.category_id
  );

  return {
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

async function findEventIdsFromGhsaPage() {
  const html = await fetchText(NFHS_GHSA_PAGE);
  const $ = cheerio.load(html);

  const discoveredLinks = [];

  $("a").each((_, el) => {
    const text = cleanSpace($(el).text());
    let href = cleanSpace($(el).attr("href") || "");

    if (!href) return;

    if (href.startsWith("/")) {
      href = `https://www.nfhsnetwork.com${href}`;
    }

    if (!/nfhsnetwork\.com\/events\//i.test(href)) return;

    const m = href.match(
      /\/events\/[^/]+\/([a-z0-9]+)(?:[/?#]|$)/i
    );

    if (!m) return;

    discoveredLinks.push({
      text,
      href,
      event_id: m[1]
    });
  });

  const results = [];

  for (const game of CONTROL_GAMES) {
    if (game.known_event_id) {
      results.push({
        ...game,
        event_id: game.known_event_id,
        event_id_source: "known"
      });

      continue;
    }

    const terms = game.search_terms.map(normalize);

    const matches = discoveredLinks.filter(link => {
      const combined = normalize(
        `${link.text} ${link.href}`
      );

      return terms.every(term => {
        const importantWords = term
          .split(" ")
          .filter(x => x.length >= 4);

        return importantWords.some(
          word => combined.includes(word)
        );
      });
    });

    const unique = [
      ...new Map(
        matches.map(x => [x.event_id, x])
      ).values()
    ];

    results.push({
      ...game,
      event_id:
        unique.length === 1
          ? unique[0].event_id
          : null,
      event_id_source:
        unique.length === 1
          ? "GHSA page"
          : "not uniquely found",
      event_link_matches: unique
    });
  }

  return {
    discovered_link_count: discoveredLinks.length,
    games: results
  };
}

async function getNfhsMetadata(game) {
  if (!game.event_id) {
    return {
      ok: false,
      role: game.role,
      label: game.label,
      event_id: null,
      error: "No NFHS event ID was discovered."
    };
  }

  const url =
    `https://cfunity.nfhsnetwork.com/v2/game_or_event/` +
    `${game.event_id}`;

  try {
    const data = await fetchJson(url);

    const publishers = Array.isArray(data?.publishers)
      ? data.publishers
      : [];

    const publisher = publishers[0] || null;

    const broadcasts =
      publisher &&
      Array.isArray(publisher.broadcasts)
        ? publisher.broadcasts
        : [];

    const vods =
      publisher &&
      Array.isArray(publisher.vods)
        ? publisher.vods
        : [];

    const broadcast = broadcasts[0] || null;
    const vod = vods[0] || null;

    return {
      ok: true,

      role: game.role,
      label: game.label,

      event_id: game.event_id,
      event_id_source: game.event_id_source,

      known_provider_stream_id:
        game.known_provider_stream_id,

      known_provider_nfhs_number:
        game.known_provider_nfhs_number,

      local_start_time:
        data?.local_start_time ?? null,

      city:
        data?.city ?? null,

      state_name:
        data?.state_name ?? null,

      publisher: publisher
        ? {
            name:
              publisher.formatted_name ??
              publisher.name ??
              null,

            publisher_key:
              publisher.publisher_key ?? null,

            slug:
              publisher.slug ?? null,

            type:
              publisher.type ?? null,

            broadcast_count:
              broadcasts.length,

            vod_count:
              vods.length
          }
        : null,

      broadcast: broadcast
        ? {
            status:
              broadcast.status ?? null,

            key_fingerprint:
              hashValue(broadcast.key),

            key_length:
              broadcast.key
                ? String(broadcast.key).length
                : 0,

            created_at:
              broadcast.created_at ?? null,

            updated_at:
              broadcast.updated_at ?? null
          }
        : null,

      vod: vod
        ? {
            status:
              vod.status ?? null,

            key_fingerprint:
              hashValue(vod.key),

            key_length:
              vod.key
                ? String(vod.key).length
                : 0
          }
        : null

    };

  } catch (err) {
    return {
      ok: false,
      role: game.role,
      label: game.label,
      event_id: game.event_id,
      error: String(err?.message || err)
    };
  }
}

function findProviderStream(provider, game) {
  if (!game.known_provider_stream_id) {
    return null;
  }

  const stream = provider.streams.find(
    s =>
      Number(s.stream_id) ===
      Number(game.known_provider_stream_id)
  );

  if (!stream) {
    return {
      stream_id:
        game.known_provider_stream_id,

      provider_nfhs_number:
        game.known_provider_nfhs_number,

      found:
        false
    };
  }

  return {
    found: true,

    stream_id:
      stream.stream_id,

    provider_nfhs_number:
      providerNumber(stream.name || ""),

    original_name:
      cleanSpace(stream.name || ""),

    added:
      stream.added ?? null,

    category_id:
      stream.category_id ?? null
  };
}

function buildComparison(metadata, provider, games) {
  return metadata.map(meta => {
    const game = games.find(
      g => g.label === meta.label
    );

    const providerStream =
      game
        ? findProviderStream(provider, game)
        : null;

    return {
      role:
        meta.role,

      game:
        meta.label,

      nfhs_event_id:
        meta.event_id,

      nfhs_start:
        meta.local_start_time ?? null,

      publisher_name:
        meta.publisher?.name ?? null,

      publisher_key:
        meta.publisher?.publisher_key ?? null,

      broadcast_fingerprint:
        meta.broadcast?.key_fingerprint ?? null,

      broadcast_status:
        meta.broadcast?.status ?? null,

      broadcast_created_at:
        meta.broadcast?.created_at ?? null,

      broadcast_updated_at:
        meta.broadcast?.updated_at ?? null,

      vod_fingerprint:
        meta.vod?.key_fingerprint ?? null,

      provider_nfhs_number:
        providerStream?.provider_nfhs_number ??
        game?.known_provider_nfhs_number ??
        null,

      provider_stream_id:
        providerStream?.stream_id ??
        game?.known_provider_stream_id ??
        null,

      provider_name:
        providerStream?.original_name ?? null,

      provider_added:
        providerStream?.added ?? null
    };
  });
}

async function main() {
  const provider = await getProvider();

  const discovery =
    await findEventIdsFromGhsaPage();

  const metadata = [];

  for (const game of discovery.games) {
    metadata.push(
      await getNfhsMetadata(game)
    );
  }

  const comparison =
    buildComparison(
      metadata,
      provider,
      discovery.games
    );

  const providerControls =
    comparison
      .filter(x => x.role === "control")
      .sort(
        (a, b) =>
          Number(a.provider_nfhs_number || 0) -
          Number(b.provider_nfhs_number || 0)
      );

  const target =
    comparison.find(
      x => x.role === "target"
    ) || null;

  const payload = {
    generated_at:
      new Date().toISOString(),

    diagnostic_only:
      true,

    modifies_epg:
      false,

    diagnostic_version:
      3,

    purpose:
      "Compare NFHS event metadata and creation/order fields against known provider NFHS channel assignments.",

    source:
      NFHS_GHSA_PAGE,

    provider: {
      category:
        provider.category?.category_name ||
        DEFAULT_CATEGORY,

      source_stream_count:
        provider.streams.length
    },

    discovery: {
      discovered_event_link_count:
        discovery.discovered_link_count,

      games:
        discovery.games
    },

    comparison,

    provider_controls_sorted:
      providerControls,

    target
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
    `NFHS diagnostic v3 complete. ` +
    `Compared ${comparison.length} Georgia events.`
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
