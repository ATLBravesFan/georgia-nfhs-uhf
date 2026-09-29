import fs from "node:fs/promises";
import * as cheerio from "cheerio";

const DEFAULT_CATEGORY = "USA | NFHS Network";

const PROVIDER_SLOT = {
  nfhs_number: 3552,
  stream_id: 2066758
};

const LOWER_ANCHOR = {
  provider_nfhs_number: 3551,
  event_id: "gamb69ef5c0a2",
  label: "Windham vs. Biddeford JV Girls Field Hockey"
};

const UPPER_ANCHOR = {
  provider_nfhs_number: 3553,
  event_id: "gamb8ee19f85e",
  label: "Away vs. Saint Stephen's Middle School Girls Volleyball"
};

const SOURCE_PAGES = [
  "https://www.nfhsnetwork.com/schools/wicomico-high-school-salisbury-md",
  "https://www.nfhsnetwork.com/schools/wicomico-high-school-salisbury-md/volleyball",
  "https://www.nfhsnetwork.com/schools/north-caroline-high-school-ridgely-md",
  "https://www.nfhsnetwork.com/schools/north-caroline-high-school-ridgely-md/volleyball",
  "https://www.nfhsnetwork.com/watch-events?activity=Volleyball&gender=girls"
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

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 Georgia-NFHS-Diagnostic/7.0"
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

async function scrapePage(url) {
  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    const events = [];
    const seen = new Set();

    $("a").each((_, el) => {
      let href =
        cleanSpace(
          $(el).attr("href") || ""
        );

      const text =
        cleanSpace(
          $(el).text()
        );

      if (!href) return;

      if (href.startsWith("/")) {
        href =
          `https://www.nfhsnetwork.com${href}`;
      }

      const m = href.match(
        /\/events\/[^/]+\/((?:gam|evt)[a-z0-9]+)(?:[/?#]|$)/i
      );

      if (!m) return;

      const eventId = m[1];

      if (seen.has(eventId)) return;

      seen.add(eventId);

      events.push({
        event_id: eventId,
        link_text: text,
        href,
        source_page: url
      });
    });

    return {
      ok: true,
      url,
      event_count: events.length,
      events
    };

  } catch (err) {
    return {
      ok: false,
      url,
      event_count: 0,
      events: [],
      error:
        String(
          err?.message || err
        )
    };
  }
}

async function getMetadata(event) {
  try {
    const data =
      await fetchJson(
        `https://cfunity.nfhsnetwork.com/v2/game_or_event/${event.event_id}`
      );

    const publishers =
      Array.isArray(data?.publishers)
        ? data.publishers
        : [];

    const publisher =
      publishers[0] || null;

    const broadcasts =
      publisher &&
      Array.isArray(
        publisher.broadcasts
      )
        ? publisher.broadcasts
        : [];

    const vods =
      publisher &&
      Array.isArray(
        publisher.vods
      )
        ? publisher.vods
        : [];

    const broadcast =
      broadcasts[0] || null;

    const vod =
      vods[0] || null;

    return {
      ...event,

      metadata_ok: true,

      local_start_time:
        data?.local_start_time ??
        null,

      city:
        data?.city ??
        null,

      state_name:
        data?.state_name ??
        null,

      event_type:
        data?.event_type ??
        null,

      title:
        data?.title ??
        data?.name ??
        null,

      publisher_name:
        publisher?.formatted_name ??
        publisher?.name ??
        null,

      publisher_slug:
        publisher?.slug ??
        null,

      broadcast_status:
        broadcast?.status ??
        null,

      vod_status:
        vod?.status ??
        null
    };

  } catch (err) {
    return {
      ...event,

      metadata_ok: false,

      metadata_error:
        String(
          err?.message || err
        )
    };
  }
}

function looksLikeWicomicoCandidate(x) {
  const combined =
    normalize(
      [
        x.link_text,
        x.href,
        x.title,
        x.publisher_name,
        x.publisher_slug,
        x.city,
        x.state_name
      ]
        .filter(Boolean)
        .join(" ")
    );

  const hasWicomico =
    combined.includes("wicomico");

  const hasNorthCaroline =
    combined.includes(
      "north caroline"
    );

  const hasSalisburyMaryland =
    combined.includes("salisbury") &&
    (
      combined.includes(" maryland") ||
      combined.includes(" md")
    );

  return (
    hasWicomico ||
    hasNorthCaroline ||
    hasSalisburyMaryland
  );
}

function betweenAnchors(eventId) {
  if (!eventId) return false;

  return (
    eventId.localeCompare(
      LOWER_ANCHOR.event_id,
      "en"
    ) > 0 &&
    eventId.localeCompare(
      UPPER_ANCHOR.event_id,
      "en"
    ) < 0
  );
}

async function main() {
  const provider =
    await getProvider();

  const providerSlot =
    provider.streams.find(
      s =>
        Number(
          providerNumber(
            s.name || ""
          )
        ) ===
        PROVIDER_SLOT.nfhs_number
    ) ||
    provider.streams.find(
      s =>
        Number(s.stream_id) ===
        PROVIDER_SLOT.stream_id
    );

  const scrapedPages = [];

  for (const url of SOURCE_PAGES) {
    scrapedPages.push(
      await scrapePage(url)
    );
  }

  const uniqueEvents =
    [
      ...new Map(
        scrapedPages
          .flatMap(
            p => p.events
          )
          .map(
            e => [
              e.event_id,
              e
            ]
          )
      ).values()
    ];

  const metadata = [];

  for (const event of uniqueEvents) {
    metadata.push(
      await getMetadata(event)
    );
  }

  const wicomicoCandidates =
    metadata
      .filter(
        looksLikeWicomicoCandidate
      )
      .map(x => ({
        ...x,

        sorts_between_3551_and_3553:
          betweenAnchors(
            x.event_id
          )
      }));

  const exactOrderingCandidates =
    wicomicoCandidates.filter(
      x =>
        x.sorts_between_3551_and_3553
    );

  const payload = {
    generated_at:
      new Date().toISOString(),

    diagnostic_only:
      true,

    modifies_epg:
      false,

    diagnostic_version:
      7,

    purpose:
      "Determine whether provider NFHS slot 3552 was dynamically reassigned to a Wicomico volleyball event and test that event against immediate NFHS event-ID anchors.",

    provider: {
      category:
        provider.category
          ?.category_name ||
        DEFAULT_CATEGORY,

      source_stream_count:
        provider.streams.length
    },

    provider_slot_3552:
      providerSlot
        ? {
            stream_id:
              providerSlot.stream_id,

            provider_nfhs_number:
              providerNumber(
                providerSlot.name || ""
              ),

            provider_title:
              cleanSpace(
                providerSlot.name || ""
              ),

            added:
              providerSlot.added ??
              null
          }
        : null,

    anchors: {
      lower:
        LOWER_ANCHOR,

      upper:
        UPPER_ANCHOR
    },

    source_pages:
      scrapedPages.map(
        p => ({
          url:
            p.url,

          ok:
            p.ok,

          event_count:
            p.event_count,

          error:
            p.error ?? null
        })
      ),

    unique_scraped_event_count:
      uniqueEvents.length,

    wicomico_candidates:
      wicomicoCandidates,

    exact_ordering_candidates:
      exactOrderingCandidates,

    conclusion: {
      one_exact_candidate:
        exactOrderingCandidates.length === 1,

      predicted_current_event_id_for_3552:
        exactOrderingCandidates.length === 1
          ? exactOrderingCandidates[0]
              .event_id
          : null,

      dynamic_slot_reuse_supported:
        exactOrderingCandidates.length === 1
    }
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
    "Diagnostic v7 complete."
  );

  console.log(
    `Wicomico candidates: ${wicomicoCandidates.length}`
  );

  console.log(
    `Exact ordering candidates: ${exactOrderingCandidates.length}`
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
