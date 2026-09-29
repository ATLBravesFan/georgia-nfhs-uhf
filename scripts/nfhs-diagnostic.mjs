import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import * as cheerio from "cheerio";
import { DateTime } from "luxon";

const EASTERN = "America/New_York";
const DEFAULT_CATEGORY = "USA | NFHS Network";

const PROVIDER_CONCURRENCY = 2;
const CAPTURE_TIMEOUT_MS = 12000;

const OFFICIAL_SOURCES = [
  {
    label: "GHSA",
    url: "https://get.nfhsnetwork.com/associations/ghsa/"
  },
  {
    label: "GAPPS",
    url: "https://get.nfhsnetwork.com/associations/gapps"
  },
  {
    label: "WATCH",
    url: "https://get.nfhsnetwork.com/watch-events"
  }
];

const STOP_WORDS = new Set([
  "high",
  "school",
  "schools",
  "academy",
  "county",
  "christian",
  "preparatory",
  "prep",
  "middle",
  "varsity",
  "junior",
  "girls",
  "boys",
  "coed",
  "the",
  "and",
  "athletics",
  "association",
  "ghsa",
  "gapps",
  "georgia"
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
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function providerNumber(name = "") {
  const m = String(name).match(
    /^NFHS\s+Network\s+(\d+)\s*:/i
  );

  return m ? Number(m[1]) : null;
}

function redactError(value, provider) {
  let s = String(value || "");

  if (provider?.username) {
    s = s
      .split(provider.username)
      .join("[USERNAME]");
  }

  if (provider?.password) {
    s = s
      .split(provider.password)
      .join("[PASSWORD]");
  }

  s = s.replace(
    /https?:\/\/[^\s"'\\]+/gi,
    "[REDACTED-URL]"
  );

  return s.slice(0, 800);
}

async function fetchText(
  url,
  timeoutMs = 15000
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
        signal: ac.signal,

        headers: {
          "User-Agent":
            "Mozilla/5.0 Georgia-NFHS-Diagnostic/13.0"
        }
      });

    const text =
      await r.text();

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

function parseProviderStart(
  name,
  now = DateTime.now().setZone(EASTERN)
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
    monthS,
    hourS,
    minuteS,
    ampm
  ] = m;

  const month =
    DateTime.fromFormat(
      monthS,
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
          Number(minuteS),

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

  if (!Array.isArray(streams)) {
    throw new Error(
      "Xtream live stream response was not an array."
    );
  }

  streams =
    streams.filter(
      s =>
        String(s.category_id) ===
          String(
            category.category_id
          ) ||
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

function streamUrl(
  provider,
  streamId
) {
  return (
    `${provider.base}/live/` +
    `${encodeURIComponent(
      provider.username
    )}/` +
    `${encodeURIComponent(
      provider.password
    )}/` +
    `${streamId}.ts`
  );
}

function runProcess(
  command,
  args,
  timeoutMs = 10000
) {
  return new Promise(resolve => {
    let finished = false;

    function finish(value) {
      if (finished) {
        return;
      }

      finished = true;
      resolve(value);
    }

    const child =
      spawn(
        command,
        args,
        {
          stdio: [
            "ignore",
            "pipe",
            "pipe"
          ]
        }
      );

    const stdout = [];
    const stderr = [];

    let timedOut = false;

    const timer =
      setTimeout(
        () => {
          timedOut = true;

          try {
            child.kill(
              "SIGKILL"
            );
          } catch {}
        },
        timeoutMs
      );

    child.stdout.on(
      "data",
      chunk => {
        stdout.push(chunk);
      }
    );

    child.stderr.on(
      "data",
      chunk => {
        stderr.push(chunk);
      }
    );

    child.on(
      "error",
      err => {
        clearTimeout(timer);

        finish({
          ok: false,
          timed_out:
            timedOut,

          code: null,

          stdout:
            Buffer.concat(
              stdout
            ).toString(),

          stderr:
            Buffer.concat(
              stderr
            ).toString(),

          error:
            String(
              err?.message ||
              err
            )
        });
      }
    );

    child.on(
      "close",
      code => {
        clearTimeout(timer);

        finish({
          ok:
            code === 0 &&
            !timedOut,

          timed_out:
            timedOut,

          code,

          stdout:
            Buffer.concat(
              stdout
            ).toString(),

          stderr:
            Buffer.concat(
              stderr
            ).toString()
        });
      }
    );
  });
}

/*
  We deliberately skip the old HTTP "is live?" test.

  FFmpeg itself gets the stream and tries to produce two frames,
  approximately two seconds apart.
*/
async function captureFrames(
  provider,
  streamId,
  outputPattern
) {
  const url =
    streamUrl(
      provider,
      streamId
    );

  const result =
    await runProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",

        "-rw_timeout",
        "10000000",

        "-analyzeduration",
        "3000000",

        "-probesize",
        "3000000",

        "-user_agent",
        "Mozilla/5.0 Georgia-NFHS-Diagnostic/13.0",

        "-i",
        url,

        "-vf",
        "fps=1/2,scale=1280:-2",

        "-frames:v",
        "2",

        "-q:v",
        "3",

        "-y",
        outputPattern
      ],
      CAPTURE_TIMEOUT_MS
    );

  const files = [];

  for (
    let i = 1;
    i <= 2;
    i++
  ) {
    const file =
      outputPattern.replace(
        "%02d",
        String(i).padStart(
          2,
          "0"
        )
      );

    try {
      const stat =
        await fs.stat(file);

      if (
        stat.size >= 5000
      ) {
        files.push(file);
      }

    } catch {}
  }

  return {
    ok:
      files.length > 0,

    files,

    timed_out:
      result.timed_out,

    code:
      result.code,

    error:
      result.ok
        ? null
        : redactError(
            result.stderr ||
            result.error ||
            "FFmpeg produced no usable frame.",
            provider
          )
  };
}

async function makeCrop(
  inputFile,
  outputFile,
  region
) {
  let filter;

  if (
    region === "top"
  ) {
    filter =
      "crop=iw:ih*0.42:0:0,scale=iw*2:ih*2";

  } else {
    filter =
      "crop=iw:ih*0.42:0:ih*0.58,scale=iw*2:ih*2";
  }

  const result =
    await runProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",

        "-i",
        inputFile,

        "-vf",
        filter,

        "-frames:v",
        "1",

        "-q:v",
        "2",

        "-y",
        outputFile
      ],
      5000
    );

  return result.ok;
}

async function runOcr(
  filename,
  psm = 11
) {
  const result =
    await runProcess(
      "tesseract",
      [
        filename,
        "stdout",
        "--psm",
        String(psm)
      ],
      10000
    );

  if (!result.ok) {
    return "";
  }

  return cleanSpace(
    result.stdout
  );
}

async function ocrOneFrame(
  frameFile
) {
  const dir =
    path.dirname(
      frameFile
    );

  const base =
    path.basename(
      frameFile,
      path.extname(
        frameFile
      )
    );

  const topFile =
    path.join(
      dir,
      `${base}-top.jpg`
    );

  const bottomFile =
    path.join(
      dir,
      `${base}-bottom.jpg`
    );

  const fullText =
    await runOcr(
      frameFile,
      11
    );

  const topOk =
    await makeCrop(
      frameFile,
      topFile,
      "top"
    );

  const bottomOk =
    await makeCrop(
      frameFile,
      bottomFile,
      "bottom"
    );

  const topText =
    topOk
      ? await runOcr(
          topFile,
          11
        )
      : "";

  const bottomText =
    bottomOk
      ? await runOcr(
          bottomFile,
          11
        )
      : "";

  const combined =
    cleanSpace(
      [
        fullText,
        topText,
        bottomText
      ]
        .filter(Boolean)
        .join(" | ")
    );

  for (
    const f
    of [
      topFile,
      bottomFile
    ]
  ) {
    try {
      await fs.unlink(f);
    } catch {}
  }

  return {
    full:
      fullText,

    top:
      topText,

    bottom:
      bottomText,

    combined
  };
}

/* -----------------------------
   OFFICIAL NFHS SCHEDULE
------------------------------ */

async function scrapeOfficialPage(
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
          seen.has(
            eventId
          )
        ) {
          return;
        }

        seen.add(
          eventId
        );

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

      ok: true,

      events
    };

  } catch (err) {
    return {
      source:
        source.label,

      ok: false,

      events: [],

      error:
        String(
          err?.message ||
          err
        )
    };
  }
}

async function getOfficialMetadata(
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
  const output =
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

      output[index] =
        await fn(
          items[index],
          index
        );
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            limit,
            Math.max(
              1,
              items.length
            )
          )
      },
      () => worker()
    )
  );

  return output;
}

function removeTimerPrefix(s) {
  return cleanSpace(s)
    .replace(
      /^\d{1,2}:\d{2}(?::\d{2})?/,
      ""
    )
    .trim();
}

function removeSportPrefix(s) {
  let value =
    cleanSpace(s);

  for (
    let i = 0;
    i < 4;
    i++
  ) {
    const before =
      value;

    value =
      value.replace(
        /^(?:(?:Junior Varsity|Varsity|Freshman|Middle School|JV|MS|7th Grade|8th Grade)\s*)?(?:(?:Girls|Boys|Coed)\s*)?(?:Flag Football|Football|Volleyball|Basketball|Baseball|Softball|Soccer|Wrestling|Lacrosse|Field Hockey|Ice Hockey|Hockey|Tennis|Swimming|Track(?: and Field)?|Cross Country|Golf|Badminton|Cheerleading)\s*/i,
        ""
      );

    value =
      value.replace(
        /^2026\s+GHSA\s+Girls\s+Volleyball\s+Playoffs\s*/i,
        ""
      );

    value =
      removeTimerPrefix(
        value
      );

    if (
      value === before
    ) {
      break;
    }
  }

  return cleanSpace(
    value
  );
}

function publisherSchoolName(
  publisherName = ""
) {
  let s =
    cleanSpace(
      publisherName
    );

  s =
    s.replace(
      /^[^:]+:\s*/,
      ""
    );

  s =
    s.replace(
      /,\s*[^,]+,\s*GA\s*$/i,
      ""
    );

  return cleanSpace(s);
}

function officialMatchTerms(
  event
) {
  const terms =
    new Set();

  let text =
    cleanSpace(
      event.link_text ||
      ""
    );

  text =
    text.replace(
      /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}.*$/i,
      ""
    );

  const pieces =
    text.split(
      /\s+vs\.?\s+|\s+versus\s+/i
    );

  if (
    pieces.length >= 2
  ) {
    const left =
      removeSportPrefix(
        pieces[0]
      );

    const right =
      removeSportPrefix(
        pieces[1]
      );

    if (left) {
      terms.add(left);
    }

    if (right) {
      terms.add(right);
    }

  } else {
    const single =
      removeSportPrefix(
        text
      );

    if (single) {
      terms.add(single);
    }
  }

  const publisher =
    publisherSchoolName(
      event.publisher_name ||
      ""
    );

  if (publisher) {
    terms.add(
      publisher
    );
  }

  return [
    ...terms
  ];
}

function strippedSchoolPhrase(
  term
) {
  return normalize(term)
    .replace(
      /\bhigh school\b/g,
      " "
    )
    .replace(
      /\bmiddle school\b/g,
      " "
    )
    .replace(
      /\belementary school\b/g,
      " "
    )
    .replace(
      /\bschool\b/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function acronymForTerm(
  term
) {
  const words =
    normalize(term)
      .split(" ")
      .filter(Boolean);

  if (
    words.length < 2
  ) {
    return "";
  }

  const acronym =
    words
      .map(
        w => w[0]
      )
      .join("");

  if (
    acronym.length < 3 ||
    acronym.length > 7
  ) {
    return "";
  }

  return acronym;
}

function distinctiveWords(
  term
) {
  return normalize(term)
    .split(" ")
    .filter(
      word =>
        word.length >= 4 &&
        !STOP_WORDS.has(
          word
        )
    );
}

function scoreOcrAgainstEvent(
  ocrText,
  event
) {
  const ocr =
    normalize(
      ocrText
    );

  if (!ocr) {
    return {
      score: 0,
      evidence: []
    };
  }

  const tokens =
    new Set(
      ocr.split(" ")
    );

  let score = 0;

  const evidence = [];

  for (
    const term
    of event.match_terms
  ) {
    const n =
      normalize(term);

    if (
      n.length >= 5 &&
      ocr.includes(n)
    ) {
      score += 120;

      evidence.push(
        `full:${term}`
      );
    }

    const stripped =
      strippedSchoolPhrase(
        term
      );

    if (
      stripped.length >= 6 &&
      stripped.split(" ").length >= 2 &&
      ocr.includes(
        stripped
      )
    ) {
      score += 90;

      evidence.push(
        `root:${stripped}`
      );
    }

    const acronym =
      acronymForTerm(
        term
      );

    if (
      acronym &&
      tokens.has(
        acronym
      )
    ) {
      score += 70;

      evidence.push(
        `acronym:${acronym.toUpperCase()}`
      );
    }

    for (
      const word
      of distinctiveWords(
        term
      )
    ) {
      if (
        tokens.has(word)
      ) {
        score += 25;

        evidence.push(
          `word:${word}`
        );
      }
    }
  }

  const city =
    normalize(
      event.city || ""
    );

  if (
    city.length >= 5 &&
    tokens.has(city)
  ) {
    score += 15;

    evidence.push(
      `city:${event.city}`
    );
  }

  return {
    score,

    evidence:
      [
        ...new Set(
          evidence
        )
      ]
  };
}

async function getGeorgiaEvents(
  now
) {
  const pages =
    await Promise.all(
      OFFICIAL_SOURCES.map(
        scrapeOfficialPage
      )
    );

  const discovered =
    pages.flatMap(
      p =>
        p.events ||
        []
    );

  const unique =
    [
      ...new Map(
        discovered.map(
          event => [
            event.event_id,
            event
          ]
        )
      ).values()
    ];

  const metadata =
    await mapLimit(
      unique,
      8,
      getOfficialMetadata
    );

  const events =
    metadata
      .map(
        event => {
          const start =
            event.local_start_time
              ? DateTime.fromISO(
                  event.local_start_time,
                  {
                    setZone: true
                  }
                ).setZone(
                  EASTERN
                )
              : null;

          return {
            ...event,

            eastern_start:
              start?.isValid
                ? start.toISO()
                : null,

            match_terms:
              officialMatchTerms(
                event
              )
          };
        }
      )
      .filter(
        event => {
          if (
            String(
              event.state_name ||
              ""
            ).toLowerCase() !==
            "georgia"
          ) {
            return false;
          }

          if (
            !event.eastern_start
          ) {
            return false;
          }

          const dt =
            DateTime.fromISO(
              event.eastern_start
            ).setZone(
              EASTERN
            );

          if (
            !dt.hasSame(
              now,
              "day"
            )
          ) {
            return false;
          }

          return (
            dt.hour >= 16
          );
        }
      );

  return {
    pages,
    events
  };
}

async function scanProviderSlot({
  provider,
  candidate,
  officialEvents,
  tmpDir
}) {
  const stream =
    candidate.stream;

  const number =
    providerNumber(
      stream.name ||
      ""
    );

  const prefix =
    path.join(
      tmpDir,
      `nfhs-${number}-${stream.stream_id}`
    );

  const pattern =
    `${prefix}-%02d.jpg`;

  const captured =
    await captureFrames(
      provider,
      stream.stream_id,
      pattern
    );

  if (!captured.ok) {
    return {
      provider_nfhs_number:
        number,

      stream_id:
        stream.stream_id,

      stale_provider_title:
        cleanSpace(
          stream.name ||
          ""
        ),

      stale_provider_start:
        candidate.start
          ?.toISO() ||
        null,

      frame_ok:
        false,

      ffmpeg_timed_out:
        captured.timed_out,

      ffmpeg_code:
        captured.code,

      ffmpeg_error:
        captured.error
    };
  }

  const ocrPasses = [];

  for (
    const frameFile
    of captured.files
  ) {
    const ocr =
      await ocrOneFrame(
        frameFile
      );

    ocrPasses.push(
      ocr
    );

    try {
      await fs.unlink(
        frameFile
      );
    } catch {}
  }

  const combinedOcr =
    cleanSpace(
      ocrPasses
        .map(
          x =>
            x.combined
        )
        .filter(Boolean)
        .join(" | ")
    );

  const matches =
    officialEvents
      .map(
        event => {
          const scored =
            scoreOcrAgainstEvent(
              combinedOcr,
              event
            );

          return {
            event_id:
              event.event_id,

            official_text:
              event.link_text,

            eastern_start:
              event.eastern_start,

            publisher_name:
              event.publisher_name,

            city:
              event.city,

            match_terms:
              event.match_terms,

            score:
              scored.score,

            evidence:
              scored.evidence
          };
        }
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
    matches[0] ||
    null;

  return {
    provider_nfhs_number:
      number,

    stream_id:
      stream.stream_id,

    stale_provider_title:
      cleanSpace(
        stream.name ||
        ""
      ),

    stale_provider_start:
      candidate.start
        ?.toISO() ||
      null,

    frame_ok:
      true,

    frames_captured:
      captured.files.length,

    ocr_text:
      combinedOcr,

    ocr_passes:
      ocrPasses,

    best_georgia_match:
      best,

    likely_match:
      Boolean(
        best &&
        best.score >= 90
      ),

    possible_match:
      Boolean(
        best &&
        best.score >= 50
      ),

    top_georgia_matches:
      matches
  };
}

async function main() {
  const now =
    DateTime.now()
      .setZone(
        EASTERN
      );

  console.log(
    `NFHS diagnostic v13 started at ${now.toISO()}`
  );

  const [
    provider,
    officialData
  ] =
    await Promise.all([
      getProvider(),
      getGeorgiaEvents(now)
    ]);

  const officialEvents =
    officialData.events;

  console.log(
    `Official Georgia events from 4 PM onward: ${officialEvents.length}`
  );

  /*
    V10 showed 288 provider titles for today.
    Unlike V12, scan ALL of today's provider slots,
    not merely 3:45-4:00 PM.
  */
  const todayCandidates =
    provider.streams
      .map(
        stream => ({
          stream,

          start:
            parseProviderStart(
              stream.name || "",
              now
            )
        })
      )
      .filter(
        item =>
          item.start &&
          item.start.hasSame(
            now,
            "day"
          )
      )
      .sort(
        (a, b) => {
          const na =
            providerNumber(
              a.stream.name ||
              ""
            ) || 0;

          const nb =
            providerNumber(
              b.stream.name ||
              ""
            ) || 0;

          return na - nb;
        }
      );

  console.log(
    `Today's provider NFHS slots to test: ${todayCandidates.length}`
  );

  console.log(
    `Provider stream concurrency: ${PROVIDER_CONCURRENCY}`
  );

  const tmpDir =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        "nfhs-v13-"
      )
    );

  let completed = 0;

  const scanResults =
    await mapLimit(
      todayCandidates,
      PROVIDER_CONCURRENCY,
      async candidate => {
        const result =
          await scanProviderSlot({
            provider,
            candidate,
            officialEvents,
            tmpDir
          });

        completed++;

        if (
          completed % 20 === 0 ||
          completed ===
            todayCandidates.length
        ) {
          console.log(
            `Completed ${completed}/${todayCandidates.length}`
          );
        }

        return result;
      }
    );

  const active =
    scanResults.filter(
      x =>
        x.frame_ok
    );

  const withOcr =
    active.filter(
      x =>
        cleanSpace(
          x.ocr_text ||
          ""
        )
    );

  const likely =
    active
      .filter(
        x =>
          x.likely_match
      )
      .sort(
        (a, b) =>
          (
            b.best_georgia_match
              ?.score || 0
          ) -
          (
            a.best_georgia_match
              ?.score || 0
          )
      );

  const possible =
    active
      .filter(
        x =>
          x.possible_match &&
          !x.likely_match
      )
      .sort(
        (a, b) =>
          (
            b.best_georgia_match
              ?.score || 0
          ) -
          (
            a.best_georgia_match
              ?.score || 0
          )
      );

  const failures =
    scanResults.filter(
      x =>
        !x.frame_ok
    );

  const controls =
    [3552, 3572]
      .map(
        number => {
          const result =
            scanResults.find(
              x =>
                x.provider_nfhs_number ===
                number
            );

          if (!result) {
            return {
              provider_nfhs_number:
                number,

              tested:
                false
            };
          }

          return {
            provider_nfhs_number:
              number,

            tested:
              true,

            frame_ok:
              result.frame_ok,

            ocr_text:
              result.ocr_text ||
              null,

            ffmpeg_error:
              result.ffmpeg_error ||
              null
          };
        }
      );

  const payload = {
    generated_at:
      now.toISO(),

    diagnostic_only:
      true,

    modifies_epg:
      false,

    diagnostic_version:
      13,

    purpose:
      "Test every NFHS provider slot labeled for today directly with FFmpeg, capture two frames from playable streams, OCR full/top/bottom image areas, and compare visible text with official Georgia NFHS events from 4 PM onward.",

    safety: {
      provider_connections_used_concurrently:
        PROVIDER_CONCURRENCY,

      frames_saved_to_repository:
        false,

      public_events_json_modified:
        false
    },

    provider: {
      category:
        provider.category
          ?.category_name ||
        DEFAULT_CATEGORY,

      source_stream_count:
        provider.streams.length,

      today_provider_slots_tested:
        todayCandidates.length
    },

    official: {
      georgia_events_from_4pm:
        officialEvents.length,

      schedule_sources:
        officialData.pages.map(
          page => ({
            source:
              page.source,

            ok:
              page.ok,

            event_count:
              page.events
                ?.length || 0,

            error:
              page.error ||
              null
          })
        ),

      events:
        officialEvents.map(
          event => ({
            source:
              event.source,

            event_id:
              event.event_id,

            text:
              event.link_text,

            eastern_start:
              event.eastern_start,

            publisher_name:
              event.publisher_name,

            city:
              event.city,

            match_terms:
              event.match_terms
          })
        )
    },

    summary: {
      provider_slots_tested:
        scanResults.length,

      streams_with_frames:
        active.length,

      streams_with_nonempty_ocr:
        withOcr.length,

      likely_georgia_matches:
        likely.length,

      possible_georgia_matches:
        possible.length,

      ffmpeg_failures:
        failures.length
    },

    known_control_diagnostics:
      controls,

    likely_georgia_matches:
      likely,

    possible_georgia_matches:
      possible,

    active_stream_results:
      active,

    ffmpeg_failure_sample:
      failures
        .slice(
          0,
          40
        )
        .map(
          x => ({
            provider_nfhs_number:
              x.provider_nfhs_number,

            stream_id:
              x.stream_id,

            stale_provider_title:
              x.stale_provider_title,

            ffmpeg_timed_out:
              x.ffmpeg_timed_out,

            ffmpeg_code:
              x.ffmpeg_code,

            ffmpeg_error:
              x.ffmpeg_error
          })
        )
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

  try {
    await fs.rm(
      tmpDir,
      {
        recursive: true,
        force: true
      }
    );
  } catch {}

  console.log(
    "Diagnostic v13 complete."
  );

  console.log(
    `Provider slots tested: ${scanResults.length}`
  );

  console.log(
    `Streams with frames: ${active.length}`
  );

  console.log(
    `Streams with OCR: ${withOcr.length}`
  );

  console.log(
    `Likely Georgia matches: ${likely.length}`
  );

  console.log(
    `Possible Georgia matches: ${possible.length}`
  );

  console.log(
    `FFmpeg failures: ${failures.length}`
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
