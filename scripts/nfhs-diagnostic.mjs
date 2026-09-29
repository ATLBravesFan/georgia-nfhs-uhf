import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import { DateTime } from "luxon";

const EASTERN = "America/New_York";

const DEFAULT_CATEGORY =
  "USA | NFHS Network";

const DEFAULT_GHSA_DIRECTORY =
  "https://www.ghsa.net/2026-2027-region-alignments";

const GIAA_DIRECTORY =
  "https://www.giaasports.org/members/";

const GAPPS_DIRECTORY =
  "https://gappsports.com/member-schools";

const OFFICIAL_SCHEDULE_SOURCES = [
  {
    label: "GHSA",
    url:
      "https://get.nfhsnetwork.com/associations/ghsa/"
  },
  {
    label: "GAPPS",
    url:
      "https://get.nfhsnetwork.com/associations/gapps"
  },

  // These are tested opportunistically.
  // If NFHS does not expose either URL,
  // the diagnostic simply records the failure.
  {
    label: "GIAA",
    url:
      "https://get.nfhsnetwork.com/associations/giaa"
  },
  {
    label: "GISA",
    url:
      "https://get.nfhsnetwork.com/associations/gisa"
  }
];

const FALLBACK_GEORGIA_SCHOOLS = [
  "Lowndes",
  "Valdosta",
  "Camden County",
  "Colquitt County",
  "Tift County",
  "Coffee",
  "Ware County",
  "Pierce County",
  "Brooks County",
  "Berrien",
  "Cook",
  "Bacon County",
  "Appling County",
  "Brantley County",
  "Charlton County",
  "Clinch County",
  "Atkinson County",
  "Lanier County",
  "Echols County",
  "Irwin County",
  "Jeff Davis",
  "Thomas County Central",
  "Thomasville",
  "Bainbridge",
  "Cairo",
  "Worth County",
  "Lee County",
  "Houston County",
  "Veterans",
  "Northside, Warner Robins",
  "Warner Robins",
  "Georgia Christian School",
  "Valwood School",
  "Highland Christian Academy",
  "Citizens Christian Academy",
  "Tiftarea Academy",
  "Southwest Georgia Academy",
  "Deerfield-Windsor School",
  "Sherwood Christian Academy",
  "Westwood School",
  "Scintilla Charter Academy",
  "Southwest Georgia STEM",
  "Spring Creek Charter Academy"
];

const AMBIGUOUS_CORES = new Set([
  "alexander",
  "archer",
  "bainbridge",
  "bremen",
  "brunswick",
  "calhoun",
  "campbell",
  "carrollton",
  "commerce",
  "columbus",
  "decatur",
  "discovery",
  "douglas county",
  "dublin",
  "evans",
  "gainesville",
  "greenville",
  "griffin",
  "hampton",
  "harrison",
  "jackson",
  "jefferson",
  "jordan",
  "lambert",
  "manchester",
  "marietta",
  "midtown",
  "model",
  "monroe",
  "newton",
  "newnan",
  "norcross",
  "parkview",
  "perry",
  "rome",
  "salem",
  "savannah",
  "stockbridge",
  "temple",
  "thomasville",
  "trinity christian",
  "walker",
  "walton",
  "washington",
  "wheeler",
  "woodstock",
  "westwood",
  "spring creek",
  "lee county",
  "baker county",
  "houston county",
  "worth county",
  "union county",
  "washington county",
  "jefferson county",
  "jasper county",
  "madison county",
  "franklin county",
  "river ridge",
  "blessed trinity",
  "st mary s",
  "bethlehem christian academy",
  "bethlehem christian"
]);

const LOCAL_PRIORITY = new Set([
  "lowndes",
  "valdosta",
  "camden county",
  "colquitt county",
  "tift county",
  "coffee",
  "ware county",
  "pierce county",
  "brooks county",
  "berrien",
  "cook",
  "bacon county",
  "appling county",
  "brantley county",
  "charlton county",
  "clinch county",
  "atkinson county",
  "lanier county",
  "echols county",
  "irwin county",
  "jeff davis",
  "thomas county central",
  "georgia christian",
  "valwood",
  "highland christian"
]);

const EXPLICIT_TEAM_ALIASES =
  new Map([
    [
      "georgia christian generals",
      "georgia christian"
    ],
    [
      "lowndes vikings",
      "lowndes"
    ],
    [
      "valdosta wildcats",
      "valdosta"
    ],
    [
      "pierce county bears",
      "pierce county"
    ],
    [
      "ware county gators",
      "ware county"
    ],
    [
      "brooks county trojans",
      "brooks county"
    ],
    [
      "colquitt county packers",
      "colquitt county"
    ],
    [
      "tift county blue devils",
      "tift county"
    ],
    [
      "coffee trojans",
      "coffee"
    ]
  ]);

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
    .replace(/&/g, " and ")
    .replace(/\bsaint\b/g, "st")
    .replace(/\bmount\b/g, "mt")
    .replace(/\bhigh school\b/g, " ")
    .replace(/\bmiddle school\b/g, " ")
    .replace(/\belementary school\b/g, " ")
    .replace(/\bschool\b/g, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparable(s = "") {
  return normalize(s)
    .replace(/\bco\b/g, "county")
    .replace(/\baca\b/g, "academy")
    .replace(/\bchr\b/g, "christian")
    .replace(/\binst\b/g, "institute")
    .replace(/\bprep\b/g, "preparatory")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(
  url,
  timeoutMs = 20000
) {
  const ac =
    new AbortController();

  const timer =
    setTimeout(
      () => ac.abort(),
      timeoutMs
    );

  try {
    const r =
      await fetch(url, {
        signal:
          ac.signal,

        headers: {
          "User-Agent":
            "Mozilla/5.0 Georgia-NFHS-Diagnostic/10.0"
        }
      });

    const text =
      await r.text();

    if (!r.ok) {
      throw new Error(
        `${r.status} ${r.statusText}: ` +
        text.slice(0, 200)
      );
    }

    return text;

  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(
  url,
  timeoutMs = 20000
) {
  return JSON.parse(
    await fetchText(
      url,
      timeoutMs
    )
  );
}

/* --------------------------------
   PRODUCTION GEORGIA SCHOOL LOGIC
--------------------------------- */

function looksLikeNoise(line) {
  const s =
    cleanSpace(line);

  if (!s) return true;

  if (/^\|$/.test(s)) {
    return true;
  }

  if (
    /^[A-Z]{1,7}\s*\(\d+\)$/.test(s)
  ) {
    return true;
  }

  if (
    /^\d+-[A-Z]{1,7}\s*\(\d+\)$/.test(s)
  ) {
    return true;
  }

  if (
    /^\d+\s+Schools?$/i.test(s)
  ) {
    return true;
  }

  if (
    /^\*\*/.test(s) ||
    /Schools Not Playing/i.test(s) ||
    /Non-Region/i.test(s)
  ) {
    return true;
  }

  if (
    /^202\d-202\d Region Alignments$/i
      .test(s)
  ) {
    return true;
  }

  return false;
}

function cleanGhsaName(line) {
  return cleanSpace(line)
    .replace(
      /\s+\*\*.*$/,
      ""
    )
    .replace(
      /\s+NR\s*$/,
      ""
    )
    .trim();
}

function extractGhsaSchools(html) {
  const $ =
    cheerio.load(html);

  const out =
    new Set();

  $("td").each((_, el) => {
    const raw =
      $(el).html() || "";

    const txt =
      cheerio.load(
        `<div>${
          raw.replace(
            /<br\s*\/?\s*>/gi,
            "\n"
          )
        }</div>`
      )("div").text();

    for (
      const part
      of txt.split(/\n+/)
    ) {
      const s =
        cleanGhsaName(part);

      if (
        !looksLikeNoise(s) &&
        /[A-Za-z]/.test(s) &&
        s.length <= 80
      ) {
        out.add(s);
      }
    }
  });

  const lines =
    $("body")
      .text()
      .split(/\r?\n/)
      .map(cleanSpace)
      .filter(Boolean);

  let active = false;

  for (const raw of lines) {
    if (
      /202\d-202\d Region Alignments/i
        .test(raw)
    ) {
      active = true;
      continue;
    }

    if (
      active &&
      /^\d+\s+Schools$/i.test(raw)
    ) {
      break;
    }

    if (!active) {
      continue;
    }

    const s =
      cleanGhsaName(raw);

    if (
      !looksLikeNoise(s) &&
      /[A-Za-z]/.test(s) &&
      s.length <= 80
    ) {
      out.add(s);
    }
  }

  for (const x of [...out]) {
    if (
      /^(print|return|footer|schools|sports|activities|inside ghsa|resources)$/i
        .test(x)
    ) {
      out.delete(x);
    }

    if (
      /^(AAAA|AAA|AA|A)+/i.test(x) &&
      /\d/.test(x)
    ) {
      out.delete(x);
    }
  }

  return [...out];
}

function extractGiaaSchools(html) {
  const $ =
    cheerio.load(html);

  const out =
    new Set();

  let active = false;

  $("body *").each((_, el) => {
    const tag =
      String(
        el.tagName ||
        el.name ||
        ""
      ).toLowerCase();

    const text =
      cleanSpace(
        $(el).text()
      );

    if (
      /^h[1-6]$/.test(tag)
    ) {
      if (
        /^GIAA MEMBERS$/i
          .test(text)
      ) {
        active = true;
        return;
      }

      if (
        active &&
        /^GISA MEMBERS$/i
          .test(text)
      ) {
        active = false;
        return false;
      }
    }

    if (
      !active ||
      tag !== "a"
    ) {
      return;
    }

    const name =
      cleanSpace(
        $(el).text()
      );

    if (
      !name ||
      name.length < 3 ||
      name.length > 110
    ) {
      return;
    }

    if (
      /^(email|login|tickets|more|members|about)$/i
        .test(name)
    ) {
      return;
    }

    out.add(name);
  });

  if (!out.size) {
    const body =
      cleanSpace(
        $("body").text()
      );

    const m =
      body.match(
        /GIAA MEMBERS\s+([\s\S]*?)\s+GISA MEMBERS/i
      );

    if (m) {
      for (
        const piece
        of m[1].split(
          /\s{2,}|\n|\r|\t/
        )
      ) {
        const name =
          cleanSpace(piece);

        if (
          name &&
          name.length >= 3 &&
          name.length <= 110
        ) {
          out.add(name);
        }
      }
    }
  }

  return [...out];
}

function extractGappsSchools(html) {
  const $ =
    cheerio.load(html);

  const out =
    new Set();

  $("a").each((_, el) => {
    const text =
      cleanSpace(
        $(el).text()
      );

    const href =
      (
        $(el).attr("href") ||
        ""
      ).toLowerCase();

    if (
      !text ||
      text.length > 110
    ) {
      return;
    }

    if (
      href.includes(
        "gappsports.com"
      ) ||
      href.startsWith("#") ||
      href.startsWith("mailto:")
    ) {
      return;
    }

    if (
      /school|academy|christian|homeschool|preparatory|prep|athletics|college|institute|tribe|force|campus|classical|montessori/i
        .test(text)
    ) {
      out.add(text);
    }
  });

  [
    "Georgia Force",
    "North Georgia Tribe",
    "The Campus",
    "Central Georgia Arts & Athletics"
  ].forEach(
    x => out.add(x)
  );

  return [...out];
}

function buildAliases(names) {
  const aliases =
    new Set();

  for (
    const rawName
    of names
  ) {
    if (!rawName) {
      continue;
    }

    const cleaned =
      cleanSpace(rawName);

    const variants =
      new Set([
        cleaned
      ]);

    if (
      cleaned.includes(",")
    ) {
      const [a, b] =
        cleaned
          .split(",")
          .map(cleanSpace);

      variants.add(
        `${a} ${b}`
      );

      variants.add(
        `${a} - ${b}`
      );

      if (
        normalize(a).length >= 9 &&
        !AMBIGUOUS_CORES.has(
          normalize(a)
        )
      ) {
        variants.add(a);
      }
    }

    variants.add(
      cleaned.replace(
        /\bCatholic High School\b/i,
        "Catholic"
      )
    );

    variants.add(
      cleaned.replace(
        /\bPreparatory School\b/i,
        "Prep"
      )
    );

    variants.add(
      cleaned.replace(
        /\bPreparatory Academy\b/i,
        "Prep Academy"
      )
    );

    variants.add(
      cleaned.replace(
        /\bChristian Academy\b/i,
        "Christian"
      )
    );

    variants.add(
      cleaned.replace(
        /\bCharter Academy\b/i,
        "Charter"
      )
    );

    for (
      const v
      of variants
    ) {
      const n =
        normalize(v);

      if (
        n.length >= 4
      ) {
        aliases.add(n);
      }
    }
  }

  return aliases;
}

async function getGeorgiaSchoolAliases() {
  const ghsaUrl =
    process.env.GHSA_DIRECTORY_URL ||
    DEFAULT_GHSA_DIRECTORY;

  const names =
    new Set(
      FALLBACK_GEORGIA_SCHOOLS
    );

  const sourceStatus = {};

  const requests = [
    [
      "GHSA",
      ghsaUrl,
      extractGhsaSchools
    ],
    [
      "GIAA",
      GIAA_DIRECTORY,
      extractGiaaSchools
    ],
    [
      "GAPPS",
      GAPPS_DIRECTORY,
      extractGappsSchools
    ]
  ];

  const results =
    await Promise.allSettled(
      requests.map(
        async (
          [
            label,
            url,
            parser
          ]
        ) => {
          const html =
            await fetchText(url);

          return {
            label,
            parsed:
              parser(html)
          };
        }
      )
    );

  for (
    let i = 0;
    i < results.length;
    i++
  ) {
    const label =
      requests[i][0];

    const r =
      results[i];

    if (
      r.status ===
      "fulfilled"
    ) {
      for (
        const n
        of r.value.parsed
      ) {
        names.add(n);
      }

      sourceStatus[label] = {
        ok: true,
        count:
          r.value.parsed.length
      };

    } else {
      sourceStatus[label] = {
        ok: false,
        error:
          String(
            r.reason?.message ||
            r.reason
          )
      };
    }
  }

  return {
    names:
      [...names],

    aliases:
      buildAliases(names),

    sourceStatus
  };
}

/* --------------------------------
   SAME PROVIDER NAME PARSING
--------------------------------- */

function stripEventPrefix(name) {
  return cleanSpace(name)
    .replace(
      /^NFHS\s+Network\s+\d+\s*:\s*/i,
      ""
    );
}

function stripEventTime(name) {
  return stripEventPrefix(name)
    .replace(
      /\s*@\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*ET\s*$/i,
      ""
    )
    .trim();
}

const SPORT_AND_LEVEL_SUFFIX =
  new RegExp(
    String.raw`(?:\s+(?:Varsity|Junior Varsity|JV|Freshman|Middle School|MS|7th Grade|8th Grade|Boys|Girls))*` +
    String.raw`\s+(?:Football|Flag Football|Volleyball|Basketball|Baseball|Softball|Soccer|Wrestling|Lacrosse|Field Hockey|Ice Hockey|Hockey|Tennis|Swimming|Track(?: and Field)?|Cross Country|Golf|Cheerleading)\s*$`,
    "i"
  );

function cleanTeamName(team) {
  let s =
    cleanSpace(team)
      .replace(
        /^(?:Home|Away|None)\s+/i,
        ""
      )
      .replace(
        /\s+at\s+.+$/i,
        ""
      );

  for (
    let i = 0;
    i < 3;
    i++
  ) {
    s =
      s.replace(
        SPORT_AND_LEVEL_SUFFIX,
        ""
      ).trim();
  }

  return s
    .replace(
      /\s+(?:Varsity|Junior Varsity|JV|Freshman|Middle School|MS|Boys|Girls)\s*$/i,
      ""
    )
    .trim();
}

function eventTeams(streamName) {
  const body =
    stripEventTime(
      streamName
    );

  const parts =
    body
      .split(
        /\s+vs\.?\s+|\s+versus\s+/i
      )
      .map(cleanTeamName)
      .filter(Boolean);

  if (
    parts.length >= 2
  ) {
    return parts.slice(0, 2);
  }

  const atParts =
    body
      .split(/\s+@\s+/)
      .map(cleanTeamName)
      .filter(Boolean);

  if (
    atParts.length >= 2
  ) {
    return atParts.slice(0, 2);
  }

  return [
    cleanTeamName(body)
  ];
}

function scoreTeamAgainstAliases(
  team,
  aliases
) {
  const t =
    normalize(team);

  if (!t) {
    return {
      matched: false,
      core: "",
      confidence: 0
    };
  }

  const explicit =
    EXPLICIT_TEAM_ALIASES.get(t);

  if (
    explicit &&
    aliases.has(explicit)
  ) {
    return {
      matched: true,
      core: explicit,
      confidence: 3
    };
  }

  if (
    aliases.has(t)
  ) {
    const oneWord =
      t.split(" ").length === 1;

    const confidence =
      LOCAL_PRIORITY.has(t)
        ? 3
        : (
            AMBIGUOUS_CORES.has(t) ||
            oneWord
          )
          ? 1
          : 2;

    return {
      matched: true,
      core: t,
      confidence
    };
  }

  return {
    matched: false,
    core: "",
    confidence: 0
  };
}

function isGeorgiaEvent(
  name,
  aliases
) {
  const teams =
    eventTeams(name);

  const scored =
    teams.map(
      t => ({
        team: t,
        ...scoreTeamAgainstAliases(
          t,
          aliases
        )
      })
    );

  const matches =
    scored.filter(
      x => x.matched
    );

  if (
    !matches.length
  ) {
    return {
      keep: false,
      teams,
      matches: []
    };
  }

  if (
    matches.some(
      x =>
        x.confidence >= 2
    )
  ) {
    return {
      keep: true,
      teams,
      matches
    };
  }

  if (
    matches.length >= 2
  ) {
    return {
      keep: true,
      teams,
      matches
    };
  }

  return {
    keep: false,
    teams,
    matches
  };
}

function parseEventStart(
  name,
  now =
    DateTime.now()
      .setZone(EASTERN)
) {
  const m =
    String(name).match(
      /@\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET\s*$/i
    );

  if (!m) {
    return null;
  }

  const [
    ,
    dayS,
    monS,
    hourS,
    minS,
    ampm
  ] = m;

  const month =
    DateTime
      .fromFormat(
        monS,
        "LLL",
        {
          zone: EASTERN
        }
      ).month;

  if (!month) {
    return null;
  }

  let hour =
    Number(hourS) % 12;

  if (
    ampm.toUpperCase() ===
    "PM"
  ) {
    hour += 12;
  }

  let dt =
    DateTime.fromObject(
      {
        year:
          now.year,

        month,

        day:
          Number(dayS),

        hour,

        minute:
          Number(minS),

        second: 0
      },
      {
        zone: EASTERN
      }
    );

  if (!dt.isValid) {
    return null;
  }

  if (
    dt.diff(
      now,
      "days"
    ).days > 180
  ) {
    dt =
      dt.minus({
        years: 1
      });
  }

  if (
    dt.diff(
      now,
      "days"
    ).days < -180
  ) {
    dt =
      dt.plus({
        years: 1
      });
  }

  return dt;
}

/* --------------------------------
   PROVIDER
--------------------------------- */

async function getProvider() {
  const base =
    cleanSpace(
      process.env.XTREAM_BASE_URL ||
      ""
    ).replace(/\/+$/, "");

  const username =
    process.env.XTREAM_USERNAME ||
    "";

  const password =
    process.env.XTREAM_PASSWORD ||
    "";

  if (
    !base ||
    !username ||
    !password
  ) {
    throw new Error(
      "Missing XTREAM_BASE_URL, XTREAM_USERNAME, or XTREAM_PASSWORD."
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
        ).toLowerCase() ===
        wanted
    );

  if (!category) {
    category =
      categories.find(
        c =>
          /nfhs/i.test(
            String(
              c.category_name ||
              ""
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
      `&category_id=${
        encodeURIComponent(
          category.category_id
        )
      }`
    );

  streams =
    streams.filter(
      s =>
        String(
          s.category_id
        ) ===
          String(
            category.category_id
          ) ||
        !s.category_id
    );

  return {
    category,
    streams
  };
}

function providerNumber(
  name = ""
) {
  const m =
    String(name).match(
      /^NFHS\s+Network\s+(\d+)\s*:/i
    );

  return m
    ? Number(m[1])
    : null;
}

/* --------------------------------
   OFFICIAL NFHS SCHEDULE
--------------------------------- */

async function scrapeAssociation(
  source
) {
  try {
    const html =
      await fetchText(
        source.url
      );

    const $ =
      cheerio.load(html);

    const events = [];
    const seen =
      new Set();

    $("a").each(
      (_, el) => {
        let href =
          cleanSpace(
            $(el).attr(
              "href"
            ) || ""
          );

        if (!href) {
          return;
        }

        if (
          href.startsWith("/")
        ) {
          href =
            `https://www.nfhsnetwork.com${href}`;
        }

        const m =
          href.match(
            /\/events\/[^/]+\/((?:gam|evt)[a-z0-9]+)(?:[/?#]|$)/i
          );

        if (!m) {
          return;
        }

        const eventId =
          m[1];

        if (
          seen.has(eventId)
        ) {
          return;
        }

        seen.add(eventId);

        events.push({
          source:
            source.label,

          event_id:
            eventId,

          link_text:
            cleanSpace(
              $(el).text()
            ),

          href
        });
      }
    );

    return {
      source:
        source.label,

      url:
        source.url,

      ok: true,

      event_count:
        events.length,

      events
    };

  } catch (err) {
    return {
      source:
        source.label,

      url:
        source.url,

      ok: false,

      event_count: 0,

      events: [],

      error:
        String(
          err?.message ||
          err
        )
    };
  }
}

async function getEventMetadata(
  event
) {
  try {
    const data =
      await fetchJson(
        `https://cfunity.nfhsnetwork.com/v2/game_or_event/${event.event_id}`
      );

    const publishers =
      Array.isArray(
        data?.publishers
      )
        ? data.publishers
        : [];

    const publisher =
      publishers[0] ||
      null;

    return {
      ...event,

      metadata_ok:
        true,

      local_start_time:
        data?.local_start_time ??
        null,

      city:
        data?.city ??
        null,

      state_name:
        data?.state_name ??
        null,

      publisher_name:
        publisher?.formatted_name ??
        publisher?.name ??
        null,

      publisher_slug:
        publisher?.slug ??
        null
    };

  } catch (err) {
    return {
      ...event,

      metadata_ok:
        false,

      metadata_error:
        String(
          err?.message ||
          err
        )
    };
  }
}

async function mapLimit(
  items,
  limit,
  fn
) {
  const results =
    new Array(
      items.length
    );

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index =
        nextIndex++;

      if (
        index >=
        items.length
      ) {
        return;
      }

      results[index] =
        await fn(
          items[index],
          index
        );
    }
  }

  const workers =
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          )
      },
      () => worker()
    );

  await Promise.all(
    workers
  );

  return results;
}

function easternStart(
  event
) {
  if (
    !event.local_start_time
  ) {
    return null;
  }

  const dt =
    DateTime.fromISO(
      event.local_start_time,
      {
        setZone: true
      }
    ).setZone(EASTERN);

  return dt.isValid
    ? dt
    : null;
}

function officialTeamText(
  linkText
) {
  let s =
    cleanSpace(
      linkText
    );

  s =
    s.replace(
      /[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s*\|\s*\d{1,2}:\d{2}\s*(?:AM|PM)\s*UTC.*$/i,
      ""
    );

  s =
    s.replace(
      /^(?:(?:Junior Varsity|Varsity|Freshman|Middle School|JV|MS|7th Grade|8th Grade)\s+)?(?:(?:Boys|Girls|Coed)\s+)?(?:Flag Football|Football|Volleyball|Basketball|Baseball|Softball|Soccer|Wrestling|Lacrosse|Field Hockey|Ice Hockey|Hockey|Tennis|Swimming|Track(?: and Field)?|Cross Country|Golf|Badminton|Cheer(?:leading)?|Sports Show|Other Sports)\s*/i,
      ""
    );

  return cleanSpace(s);
}

function officialTeams(event) {
  const body =
    officialTeamText(
      event.link_text ||
      ""
    );

  const parts =
    body
      .split(
        /\s+vs\.?\s+|\s+versus\s+/i
      )
      .map(cleanSpace)
      .filter(Boolean);

  if (
    parts.length >= 2
  ) {
    return parts.slice(0, 2);
  }

  return body
    ? [body]
    : [];
}

function teamLooksSame(
  a,
  b
) {
  const x =
    normalizeComparable(a);

  const y =
    normalizeComparable(b);

  if (
    !x ||
    !y
  ) {
    return false;
  }

  if (
    x === y
  ) {
    return true;
  }

  if (
    x.length >= 6 &&
    y.includes(x)
  ) {
    return true;
  }

  if (
    y.length >= 6 &&
    x.includes(y)
  ) {
    return true;
  }

  return false;
}

function candidateForOfficial(
  official,
  stream,
  now
) {
  const officialStart =
    easternStart(
      official
    );

  const providerStart =
    parseEventStart(
      stream.name ||
      "",
      now
    );

  const oTeams =
    officialTeams(
      official
    );

  const pTeams =
    eventTeams(
      stream.name ||
      ""
    );

  let teamMatches = 0;

  const used =
    new Set();

  for (
    const ot
    of oTeams
  ) {
    for (
      let i = 0;
      i < pTeams.length;
      i++
    ) {
      if (
        used.has(i)
      ) {
        continue;
      }

      if (
        teamLooksSame(
          ot,
          pTeams[i]
        )
      ) {
        teamMatches++;
        used.add(i);
        break;
      }
    }
  }

  let minutesApart =
    null;

  if (
    officialStart &&
    providerStart
  ) {
    minutesApart =
      Math.abs(
        officialStart.diff(
          providerStart,
          "minutes"
        ).minutes
      );
  }

  let score = 0;

  if (
    oTeams.length >= 2 &&
    teamMatches >= 2
  ) {
    score += 100;
  } else if (
    teamMatches === 1
  ) {
    score += 40;
  }

  if (
    minutesApart !== null
  ) {
    if (
      minutesApart <= 5
    ) {
      score += 30;
    } else if (
      minutesApart <= 15
    ) {
      score += 20;
    } else if (
      minutesApart <= 60
    ) {
      score += 5;
    }
  }

  return {
    provider_nfhs_number:
      providerNumber(
        stream.name ||
        ""
      ),

    stream_id:
      stream.stream_id,

    provider_name:
      cleanSpace(
        stream.name ||
        ""
      ),

    provider_start:
      providerStart
        ?.toISO() ||
      null,

    team_matches:
      teamMatches,

    official_team_count:
      oTeams.length,

    minutes_apart:
      minutesApart,

    score
  };
}

function providerTimeBucket(
  dt
) {
  if (!dt) {
    return "unparsed";
  }

  return dt.toFormat(
    "h:mm a"
  );
}

async function main() {
  const now =
    DateTime.now()
      .setZone(EASTERN);

  console.log(
    `Running v10 at ${now.toISO()}`
  );

  const [
    provider,
    schoolData,
    associationResults
  ] =
    await Promise.all([
      getProvider(),

      getGeorgiaSchoolAliases(),

      Promise.all(
        OFFICIAL_SCHEDULE_SOURCES
          .map(
            source =>
              scrapeAssociation(
                source
              )
          )
      )
    ]);

  /* -----------------------------
     PROVIDER VIEW
  ------------------------------ */

  const providerParsed =
    provider.streams.map(
      s => {
        const name =
          cleanSpace(
            s.name || ""
          );

        const start =
          parseEventStart(
            name,
            now
          );

        const geo =
          isGeorgiaEvent(
            name,
            schoolData.aliases
          );

        return {
          provider_nfhs_number:
            providerNumber(
              name
            ),

          stream_id:
            s.stream_id,

          name,

          start,

          is_georgia_by_production_logic:
            geo.keep,

          matched_schools:
            geo.matches.map(
              x => ({
                team:
                  x.team,

                core:
                  x.core,

                confidence:
                  x.confidence
              })
            )
        };
      }
    );

  const providerToday =
    providerParsed.filter(
      x =>
        x.start &&
        x.start.hasSame(
          now,
          "day"
        )
    );

  const providerAtOrAfter4 =
    providerToday.filter(
      x =>
        x.start.hour >= 16
    );

  const providerAfter4Strict =
    providerToday.filter(
      x =>
        x.start.hour > 16 ||
        (
          x.start.hour === 16 &&
          x.start.minute > 0
        )
    );

  const providerGeorgiaToday =
    providerToday.filter(
      x =>
        x.is_georgia_by_production_logic
    );

  const providerGeorgiaAtOrAfter4 =
    providerAtOrAfter4.filter(
      x =>
        x.is_georgia_by_production_logic
    );

  const providerGeorgiaAfter4Strict =
    providerAfter4Strict.filter(
      x =>
        x.is_georgia_by_production_logic
    );

  const timeBucketMap =
    new Map();

  for (
    const x
    of providerGeorgiaToday
  ) {
    const bucket =
      providerTimeBucket(
        x.start
      );

    timeBucketMap.set(
      bucket,
      (
        timeBucketMap.get(
          bucket
        ) || 0
      ) + 1
    );
  }

  /* -----------------------------
     OFFICIAL NFHS VIEW
  ------------------------------ */

  const scrapedEvents =
    associationResults
      .flatMap(
        r => r.events || []
      );

  const uniqueOfficial =
    [
      ...new Map(
        scrapedEvents.map(
          e => [
            e.event_id,
            e
          ]
        )
      ).values()
    ];

  console.log(
    `Official event IDs discovered: ${uniqueOfficial.length}`
  );

  const officialWithMetadata =
    await mapLimit(
      uniqueOfficial,
      8,
      getEventMetadata
    );

  const officialGeorgiaToday =
    officialWithMetadata
      .map(
        event => {
          const start =
            easternStart(event);

          return {
            ...event,

            eastern_start:
              start?.toISO() ||
              null,

            eastern_time:
              start
                ?.toFormat(
                  "h:mm a"
                ) ||
              null,

            teams:
              officialTeams(
                event
              )
          };
        }
      )
      .filter(
        event => {
          const start =
            event.eastern_start
              ? DateTime.fromISO(
                  event.eastern_start,
                  {
                    setZone: true
                  }
                ).setZone(
                  EASTERN
                )
              : null;

          if (
            !start ||
            !start.hasSame(
              now,
              "day"
            )
          ) {
            return false;
          }

          // Association pages should already
          // represent Georgia, but this prevents
          // accidental cross-association junk.
          if (
            event.state_name &&
            String(
              event.state_name
            ).toLowerCase() !==
              "georgia"
          ) {
            return false;
          }

          return true;
        }
      );

  const officialAtOrAfter4 =
    officialGeorgiaToday
      .filter(
        event => {
          const dt =
            DateTime.fromISO(
              event.eastern_start,
              {
                setZone: true
              }
            ).setZone(
              EASTERN
            );

          return (
            dt.hour >= 16
          );
        }
      );

  const officialAfter4Strict =
    officialAtOrAfter4
      .filter(
        event => {
          const dt =
            DateTime.fromISO(
              event.eastern_start,
              {
                setZone: true
              }
            ).setZone(
              EASTERN
            );

          return (
            dt.hour > 16 ||
            (
              dt.hour === 16 &&
              dt.minute > 0
            )
          );
        }
      );

  /* -----------------------------
     MATCH OFFICIAL EVENTS TO
     CURRENT PROVIDER TITLES
  ------------------------------ */

  const officialComparison =
    officialAtOrAfter4.map(
      official => {
        const candidates =
          provider.streams
            .map(
              stream =>
                candidateForOfficial(
                  official,
                  stream,
                  now
                )
            )
            .filter(
              x =>
                x.score > 0
            )
            .sort(
              (a, b) =>
                b.score -
                a.score
            )
            .slice(
              0,
              5
            );

        const best =
          candidates[0] ||
          null;

        const confident =
          Boolean(
            best &&
            best.team_matches >= 2 &&
            best.minutes_apart !== null &&
            best.minutes_apart <= 15
          );

        const teamMatchWrongTime =
          Boolean(
            best &&
            best.team_matches >= 2 &&
            (
              best.minutes_apart === null ||
              best.minutes_apart > 15
            )
          );

        let diagnosis =
          "no_matching_provider_title";

        if (confident) {
          diagnosis =
            "provider_title_match";
        } else if (
          teamMatchWrongTime
        ) {
          diagnosis =
            "same_teams_but_provider_time_differs";
        } else if (
          best &&
          best.team_matches === 1
        ) {
          diagnosis =
            "only_one_team_found_in_provider_titles";
        }

        return {
          source:
            official.source,

          event_id:
            official.event_id,

          official_text:
            official.link_text,

          eastern_start:
            official.eastern_start,

          eastern_time:
            official.eastern_time,

          city:
            official.city,

          state_name:
            official.state_name,

          publisher_name:
            official.publisher_name,

          teams:
            official.teams,

          diagnosis,

          confident_provider_title_match:
            confident,

          best_provider_candidate:
            best,

          top_provider_candidates:
            candidates
        };
      }
    );

  const matchedOfficial =
    officialComparison.filter(
      x =>
        x.confident_provider_title_match
    );

  const unmatchedOfficial =
    officialComparison.filter(
      x =>
        !x.confident_provider_title_match
    );

  const unmatchedAfter4Strict =
    unmatchedOfficial.filter(
      x => {
        const dt =
          DateTime.fromISO(
            x.eastern_start,
            {
              setZone: true
            }
          ).setZone(
            EASTERN
          );

        return (
          dt.hour > 16 ||
          (
            dt.hour === 16 &&
            dt.minute > 0
          )
        );
      }
    );

  /* -----------------------------
     SUMMARY / DIAGNOSIS
  ------------------------------ */

  const likelyProviderTitleProblem =
    officialAfter4Strict.length > 0 &&
    providerGeorgiaAfter4Strict.length === 0;

  const payload = {
    generated_at:
      now.toISO(),

    diagnostic_only:
      true,

    modifies_epg:
      false,

    diagnostic_version:
      10,

    purpose:
      "Compare the official Georgia NFHS schedule against the provider's current 5,000 NFHS titles and the same Georgia-name logic used by the production updater, with special focus on events after 4:00 PM Eastern.",

    date:
      now.toISODate(),

    provider: {
      category:
        provider.category
          ?.category_name ||
        DEFAULT_CATEGORY,

      source_stream_count:
        provider.streams.length,

      provider_titles_today:
        providerToday.length,

      provider_titles_at_or_after_4pm:
        providerAtOrAfter4.length,

      provider_titles_after_4pm_strict:
        providerAfter4Strict.length,

      provider_georgia_titles_today:
        providerGeorgiaToday.length,

      provider_georgia_titles_at_or_after_4pm:
        providerGeorgiaAtOrAfter4.length,

      provider_georgia_titles_after_4pm_strict:
        providerGeorgiaAfter4Strict.length
    },

    production_school_directories:
      schoolData.sourceStatus,

    official_schedule_sources:
      associationResults.map(
        r => ({
          source:
            r.source,

          url:
            r.url,

          ok:
            r.ok,

          event_count:
            r.event_count,

          error:
            r.error ??
            null
        })
      ),

    official: {
      unique_event_ids_discovered:
        uniqueOfficial.length,

      georgia_events_today:
        officialGeorgiaToday.length,

      georgia_events_at_or_after_4pm:
        officialAtOrAfter4.length,

      georgia_events_after_4pm_strict:
        officialAfter4Strict.length,

      matched_to_provider_title_at_or_after_4pm:
        matchedOfficial.length,

      unmatched_at_or_after_4pm:
        unmatchedOfficial.length,

      unmatched_after_4pm_strict:
        unmatchedAfter4Strict.length
    },

    conclusion: {
      official_later_georgia_events_exist:
        officialAfter4Strict.length > 0,

      provider_has_any_later_titles:
        providerAfter4Strict.length > 0,

      production_logic_sees_later_georgia_titles:
        providerGeorgiaAfter4Strict.length > 0,

      likely_provider_title_problem:
        likelyProviderTitleProblem,

      explanation:
        likelyProviderTitleProblem
          ? "Official NFHS has Georgia events after 4 PM, and the provider has streams labeled after 4 PM, but none of those provider titles are recognized as Georgia by the production title matcher. This strongly supports stale/missing/wrong provider titles as the reason later Georgia events do not populate."
          : "Review the counts and per-event comparison. Later Georgia titles were found by production logic, or the official schedule did not expose later events in this run."
    },

    provider_georgia_time_buckets:
      Object.fromEntries(
        [...timeBucketMap.entries()]
      ),

    provider_georgia_titles_at_or_after_4pm:
      providerGeorgiaAtOrAfter4
        .map(
          x => ({
            provider_nfhs_number:
              x.provider_nfhs_number,

            stream_id:
              x.stream_id,

            name:
              x.name,

            start:
              x.start?.toISO() ||
              null,

            matched_schools:
              x.matched_schools
          })
        ),

    official_georgia_events_at_or_after_4pm:
      officialComparison,

    unmatched_official_georgia_events_after_4pm:
      unmatchedAfter4Strict
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
    "Diagnostic v10 complete."
  );

  console.log(
    `Official Georgia events after 4 PM: ${officialAfter4Strict.length}`
  );

  console.log(
    `Provider Georgia titles after 4 PM: ${providerGeorgiaAfter4Strict.length}`
  );

  console.log(
    `Unmatched official events after 4 PM: ${unmatchedAfter4Strict.length}`
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
