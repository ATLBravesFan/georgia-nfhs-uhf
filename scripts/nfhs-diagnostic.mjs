import fs from "node:fs/promises";

const DEFAULT_CATEGORY = "USA | NFHS Network";

const TARGET = {
  label: "Clinch County vs. Brantley County",
  event_id: "gamb8ad8195a3"
};

const KNOWN_PAIRS = [
  {
    label: "Long County vs. St. Vincent's",
    event_id: "gam302604b4e5",
    provider_nfhs_number: 3455,
    provider_stream_id: 2066857
  },
  {
    label: "Cary vs. Holly Springs",
    event_id: "gam7a4d71b081",
    provider_nfhs_number: 3514,
    provider_stream_id: 2066798
  },
  {
    label: "Big Rapids vs. Chippewa Hills",
    event_id: "gam959038070d",
    provider_nfhs_number: 3529,
    provider_stream_id: 2066783
  },
  {
    label: "Sanderson vs. Middle Creek",
    event_id: "gambb59c64f73",
    provider_nfhs_number: 3556,
    provider_stream_id: 2066754
  },
  {
    label: "Camden County vs. Savannah Country Day",
    event_id: "gamd493cc6a81",
    provider_nfhs_number: 3572,
    provider_stream_id: 2066737
  },
  {
    label: "Frederica Academy vs. Bradwell Institute",
    event_id: "gamee5d943f7a",
    provider_nfhs_number: 3596,
    provider_stream_id: 2066711
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
        "User-Agent": "Mozilla/5.0 Georgia-NFHS-Diagnostic/6.0"
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

function verifyKnownPair(provider, pair) {
  const stream =
    provider.streams.find(
      s =>
        Number(s.stream_id) ===
        Number(pair.provider_stream_id)
    );

  if (!stream) {
    return {
      ...pair,
      provider_stream_found: false
    };
  }

  return {
    ...pair,

    provider_stream_found: true,

    current_provider_nfhs_number:
      providerNumber(stream.name || ""),

    current_provider_name:
      cleanSpace(stream.name || ""),

    provider_added:
      stream.added ?? null
  };
}

function compareEventIds(a, b) {
  return String(a.event_id)
    .localeCompare(
      String(b.event_id),
      "en",
      {
        numeric: false,
        sensitivity: "variant"
      }
    );
}

function isMonotonic(rows) {
  const sorted = [...rows]
    .sort(compareEventIds);

  for (
    let i = 1;
    i < sorted.length;
    i++
  ) {
    if (
      Number(
        sorted[i].provider_nfhs_number
      ) <=
      Number(
        sorted[i - 1].provider_nfhs_number
      )
    ) {
      return false;
    }
  }

  return true;
}

function findTargetBracket(rows) {
  const sorted =
    [...rows].sort(compareEventIds);

  let lower = null;
  let upper = null;

  for (const row of sorted) {
    const comparison =
      String(row.event_id).localeCompare(
        TARGET.event_id,
        "en",
        {
          numeric: false,
          sensitivity: "variant"
        }
      );

    if (comparison < 0) {
      lower = row;
    }

    if (comparison > 0) {
      upper = row;
      break;
    }
  }

  return {
    lower,
    target: TARGET,
    upper
  };
}

async function main() {
  const provider =
    await getProvider();

  const verified =
    KNOWN_PAIRS.map(
      pair =>
        verifyKnownPair(
          provider,
          pair
        )
    );

  const usablePairs =
    verified
      .filter(
        x =>
          x.provider_stream_found
      )
      .map(x => ({
        label:
          x.label,

        event_id:
          x.event_id,

        provider_nfhs_number:
          x.current_provider_nfhs_number,

        provider_stream_id:
          x.provider_stream_id,

        provider_name:
          x.current_provider_name,

        provider_added:
          x.provider_added
      }));

  const orderedPairs =
    [...usablePairs]
      .sort(compareEventIds);

  const monotonic =
    isMonotonic(usablePairs);

  const targetBracket =
    findTargetBracket(
      usablePairs
    );

  const lowerNumber =
    Number(
      targetBracket.lower
        ?.provider_nfhs_number
    );

  const upperNumber =
    Number(
      targetBracket.upper
        ?.provider_nfhs_number
    );

  let bracketStreams = [];

  if (
    Number.isFinite(lowerNumber) &&
    Number.isFinite(upperNumber)
  ) {
    bracketStreams =
      provider.streams
        .map(s => ({
          stream_id:
            s.stream_id,

          provider_nfhs_number:
            providerNumber(
              s.name || ""
            ),

          original_name:
            cleanSpace(
              s.name || ""
            ),

          added:
            s.added ?? null
        }))
        .filter(
          s =>
            Number.isFinite(
              s.provider_nfhs_number
            ) &&
            s.provider_nfhs_number >
              lowerNumber &&
            s.provider_nfhs_number <
              upperNumber
        )
        .sort(
          (a, b) =>
            a.provider_nfhs_number -
            b.provider_nfhs_number
        );
  }

  const freshmanVolleyballCandidates =
    bracketStreams.filter(s => {
      const n =
        s.original_name
          .toLowerCase();

      return (
        n.includes("29 sep") &&
        n.includes("04:00 pm et") &&
        n.includes("freshman") &&
        n.includes("girls") &&
        n.includes("volleyball")
      );
    });

  const payload = {
    generated_at:
      new Date().toISOString(),

    diagnostic_only:
      true,

    modifies_epg:
      false,

    diagnostic_version:
      6,

    purpose:
      "Test whether NFHS event IDs sort monotonically with provider NFHS numbers and bracket the Clinch-Brantley target.",

    provider: {
      category:
        provider.category
          ?.category_name ||
        DEFAULT_CATEGORY,

      source_stream_count:
        provider.streams.length
    },

    target:
      TARGET,

    ordering_test: {
      known_pair_count:
        usablePairs.length,

      event_id_to_provider_number_monotonic:
        monotonic,

      ordered_pairs:
        orderedPairs
    },

    target_bracket:
      targetBracket,

    bracket_range:
      Number.isFinite(lowerNumber) &&
      Number.isFinite(upperNumber)
        ? {
            greater_than:
              lowerNumber,

            less_than:
              upperNumber,

            possible_provider_number_count:
              Math.max(
                upperNumber -
                lowerNumber -
                1,
                0
              )
          }
        : null,

    bracket_streams:
      bracketStreams,

    freshman_girls_volleyball_candidates_inside_bracket:
      freshmanVolleyballCandidates
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
    `Diagnostic v6 complete.`
  );

  console.log(
    `Ordering monotonic: ${monotonic}`
  );

  console.log(
    `Bracket streams: ${bracketStreams.length}`
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
