import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import * as cheerio from "cheerio";
import { DateTime } from "luxon";

const EASTERN = "America/New_York";
const DEFAULT_CATEGORY = "USA | NFHS Network";

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

async function fetchText(url, timeoutMs = 15000) {
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
          "Mozilla/5.0 Georgia-NFHS-Diagnostic/12.0"
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

function providerNumber(name = "") {
  const m = String(name).match(
    /^NFHS\s+Network\s+(\d+)\s*:/i
  );

  return m ? Number(m[1]) : null;
}

function parseProviderStart(
  name,
  now = DateTime.now().setZone(EASTERN)
) {
  const m = String(name).match(
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
    minuteS,
    ampm
  ] = m;

  const month =
    DateTime.fromFormat(
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
    ampm.toUpperCase() === "PM"
  ) {
    hour += 12;
  }

  const dt =
    DateTime.fromObject(
      {
        year: now.year,
        month,
        day: Number(dayS),
        hour,
        minute: Number(minuteS),
        second: 0
      },
      {
        zone: EASTERN
      }
    );

  return dt.isValid
    ? dt
    : null;
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
      "Missing Xtream credentials."
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
    category,
    streams
  };
}

function streamUrl(provider, streamId) {
  return (
    `${provider.base}/live/` +
    `${encodeURIComponent(provider.username)}/` +
    `${encodeURIComponent(provider.password)}/` +
    `${streamId}.ts`
  );
}

/*
  Quick test to determine whether a stale channel is
  actually carrying video right now.
*/
async function streamIsLive(url) {
  const ac =
    new AbortController();

  const timer =
    setTimeout(
      () => ac.abort(),
      2500
    );

  try {
    const r =
      await fetch(url, {
        signal: ac.signal,
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 Georgia-NFHS-Diagnostic/12.0"
        }
      });

    const type =
      String(
        r.headers.get(
          "content-type"
        ) || ""
      );

    try {
      await r.body?.cancel();
    } catch {}

    return (
      r.ok &&
      (
        type.includes("video") ||
        type.includes("mp2t") ||
        type.includes("octet-stream")
      )
    );

  } catch {
    return false;

  } finally {
    clearTimeout(timer);
  }
}

function runProcess(
  command,
  args,
  {
    timeoutMs = 10000,
    binary = false
  } = {}
) {
  return new Promise(resolve => {
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
    let stderr = "";
    let timedOut = false;

    const timer =
      setTimeout(
        () => {
          timedOut = true;

          try {
            child.kill("SIGKILL");
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
        stderr +=
          chunk.toString();
      }
    );

    child.on(
      "error",
      err => {
        clearTimeout(timer);

        resolve({
          ok: false,
          timed_out: timedOut,
          error:
            String(
              err?.message || err
            )
        });
      }
    );

    child.on(
      "close",
      code => {
        clearTimeout(timer);

        const buffer =
          Buffer.concat(stdout);

        resolve({
          ok:
            code === 0 &&
            !timedOut,

          timed_out:
            timedOut,

          stdout:
            binary
              ? buffer
              : buffer.toString(),

          error:
            stderr.slice(0, 1000)
        });
      }
    );
  });
}

async function captureFrame(
  url,
  filename
) {
  const result =
    await runProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",

        "-rw_timeout",
        "5000000",

        "-i",
        url,

        "-frames:v",
        "1",

        "-vf",
        "scale=1280:-2",

        "-q:v",
        "3",

        "-y",
        filename
      ],
      {
        timeoutMs: 8000
      }
    );

  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error ||
        "ffmpeg failed"
    };
  }

  try {
    const stat =
      await fs.stat(filename);

    if (
      stat.size < 5000
    ) {
      return {
        ok: false,
        error:
          "Captured image was too small."
      };
    }

  } catch {
    return {
      ok: false,
      error:
        "No frame was created."
    };
  }

  return {
    ok: true
  };
}

async function runOcr(filename) {
  const result =
    await runProcess(
      "tesseract",
      [
        filename,
        "stdout",
        "--psm",
        "11"
      ],
      {
        timeoutMs: 12000
      }
    );

  if (!result.ok) {
    return {
      ok: false,
      text: "",
      error:
        result.error ||
        "OCR failed"
    };
  }

  return {
    ok: true,

    text:
      cleanSpace(
        result.stdout
      )
  };
}

/* --------------------------
   OFFICIAL GEORGIA EVENTS
--------------------------- */

async function scrapeOfficialPage(source) {
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
            $(el).attr("href") ||
            ""
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
      ok: true,
      events
    };

  } catch (err) {
    return {
      ok: false,
      events: [],
      error:
        String(
          err?.message || err
        )
    };
  }
}

async function getOfficialMetadata(event) {
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

      publisher_name:
        publisher?.formatted_name ??
        publisher?.name ??
        null
    };

  } catch (err) {
    return {
      ...event,

      metadata_ok: false,

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
  const result =
    new Array(
      items.length
    );

  let next = 0;

  async function worker() {
    while (true) {
      const index =
        next++;

      if (
        index >=
        items.length
      ) {
        return;
      }

      result[index] =
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
            items.length
          )
      },
      () => worker()
    )
  );

  return result;
}

function removeLeadingSport(text) {
  let s =
    cleanSpace(text);

  s =
    s.replace(
      /^(?:Junior Varsity|Varsity|Freshman|Middle School|JV|MS|7th Grade|8th Grade)\s*/i,
      ""
    );

  s =
    s.replace(
      /^(?:Girls|Boys|Coed)\s*/i,
      ""
    );

  s =
    s.replace(
      /^(?:Flag Football|Football|Volleyball|Basketball|Baseball|Softball|Soccer|Wrestling|Lacrosse|Field Hockey|Ice Hockey|Hockey|Tennis|Swimming|Track(?: and Field)?|Cross Country|Golf|Badminton)\s*/i,
      ""
    );

  s =
    s.replace(
      /^2026\s+GHSA\s+Girls\s+Volleyball\s+Playoffs/i,
      ""
    );

  return cleanSpace(s);
}

function officialTeamTerms(event) {
  const terms =
    new Set();

  let text =
    cleanSpace(
      event.link_text || ""
    );

  text =
    text.replace(
      /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}.*$/i,
      ""
    );

  const parts =
    text.split(
      /\s+vs\.?\s+|\s+versus\s+/i
    );

  if (
    parts.length >= 2
  ) {
    const left =
      removeLeadingSport(
        parts[0]
      );

    const right =
      cleanSpace(
        parts[1]
      );

    if (left) {
      terms.add(left);
    }

    if (right) {
      terms.add(right);
    }
  }

  if (
    event.publisher_name
  ) {
    let publisher =
      cleanSpace(
        event.publisher_name
      )
        .replace(
          /^[^:]+:\s*/,
          ""
        )
        .replace(
          /,\s*[^,]+,\s*GA\s*$/i,
          ""
        );

    if (publisher) {
      terms.add(publisher);
    }
  }

  return [...terms];
}

function distinctiveWords(term) {
  return normalize(term)
    .split(" ")
    .filter(
      word =>
        word.length >= 4 &&
        !STOP_WORDS.has(word)
    );
}

function scoreOcrAgainstEvent(
  ocrText,
  event
) {
  const ocr =
    normalize(ocrText);

  if (!ocr) {
    return {
      score: 0,
      evidence: []
    };
  }

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
      score += 80;

      evidence.push(
        `full:${term}`
      );
    }

    for (
      const word
      of distinctiveWords(term)
    ) {
      if (
        ocr.includes(word)
      ) {
        score += 20;

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
    ocr.includes(city)
  ) {
    score += 10;

    evidence.push(
      `city:${event.city}`
    );
  }

  return {
    score,

    evidence:
      [...new Set(evidence)]
  };
}

async function getTonightGeorgiaEvents(now) {
  const pages =
    await Promise.all(
      OFFICIAL_SOURCES.map(
        scrapeOfficialPage
      )
    );

  const discovered =
    pages.flatMap(
      p => p.events
    );

  const unique =
    [
      ...new Map(
        discovered.map(
          x => [
            x.event_id,
            x
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

  return metadata
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
            officialTeamTerms(
              event
            )
        };
      }
    )
    .filter(
      event => {
        if (
          String(
            event.state_name || ""
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

        const start =
          DateTime.fromISO(
            event.eastern_start
          ).setZone(
            EASTERN
          );

        if (
          !start.hasSame(
            now,
            "day"
          )
        ) {
          return false;
        }

        /*
          Keep games from 4 PM through tonight.
          A game may still be live several hours
          after the listed start time.
        */
        return (
          start.hour >= 16
        );
      }
    );
}

async function main() {
  const now =
    DateTime.now()
      .setZone(EASTERN);

  const provider =
    await getProvider();

  console.log(
    `V12 started at ${now.toISO()}`
  );

  const officialEvents =
    await getTonightGeorgiaEvents(
      now
    );

  console.log(
    `Official Georgia events from 4 PM onward: ${officialEvents.length}`
  );

  /*
    V10 proved provider metadata ends at 4 PM.

    Scan the slots immediately surrounding that
    cutoff because these are the channels most
    likely to be reused later in the evening.
  */
  const staleCandidates =
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
        x => {
          if (!x.start) {
            return false;
          }

          if (
            !x.start.hasSame(
              now,
              "day"
            )
          ) {
            return false;
          }

          const minutes =
            x.start.hour * 60 +
            x.start.minute;

          /*
            3:45 PM through 4:00 PM.
          */
          return (
            minutes >=
              15 * 60 + 45 &&
            minutes <=
              16 * 60
          );
        }
      );

  console.log(
    `Stale provider slots to test: ${staleCandidates.length}`
  );

  const tmpDir =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        "nfhs-v12-"
      )
    );

  const results = [];

  let checked = 0;

  /*
    INTENTIONALLY SEQUENTIAL.
    Only one provider stream is touched at a time.
  */
  for (
    const candidate
    of staleCandidates
  ) {
    checked++;

    const stream =
      candidate.stream;

    const number =
      providerNumber(
        stream.name || ""
      );

    if (
      checked % 20 === 0
    ) {
      console.log(
        `Checked ${checked}/${staleCandidates.length}`
      );
    }

    const url =
      streamUrl(
        provider,
        stream.stream_id
      );

    const active =
      await streamIsLive(url);

    if (!active) {
      continue;
    }

    const frameFile =
      path.join(
        tmpDir,
        `nfhs-${number}-${stream.stream_id}.jpg`
      );

    const frame =
      await captureFrame(
        url,
        frameFile
      );

    if (!frame.ok) {
      results.push({
        provider_nfhs_number:
          number,

        stream_id:
          stream.stream_id,

        stale_provider_title:
          cleanSpace(
            stream.name || ""
          ),

        active:
          true,

        frame_ok:
          false,

        frame_error:
          frame.error
      });

      continue;
    }

    const ocr =
      await runOcr(
        frameFile
      );

    const matches =
      officialEvents
        .map(
          event => {
            const scored =
              scoreOcrAgainstEvent(
                ocr.text,
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

    results.push({
      provider_nfhs_number:
        number,

      stream_id:
        stream.stream_id,

      stale_provider_title:
        cleanSpace(
          stream.name || ""
        ),

      stale_provider_start:
        candidate.start
          ?.toISO() ||
        null,

      active:
        true,

      frame_ok:
        true,

      ocr_ok:
        ocr.ok,

      ocr_text:
        ocr.text,

      best_georgia_match:
        best,

      likely_match:
        Boolean(
          best &&
          best.score >= 80
        ),

      top_georgia_matches:
        matches
    });

    try {
      await fs.unlink(
        frameFile
      );
    } catch {}
  }

  const likelyMatches =
    results
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

  const payload = {
    generated_at:
      now.toISO(),

    diagnostic_only:
      true,

    modifies_epg:
      false,

    diagnostic_version:
      12,

    purpose:
      "Scan stale late-afternoon provider NFHS slots that are still carrying video, OCR one current video frame from each, and compare visible text against official Georgia NFHS events from 4 PM onward.",

    safety: {
      provider_connections_used_concurrently:
        1,

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

      stale_slots_tested:
        staleCandidates.length,

      active_stale_slots:
        results.length
    },

    official: {
      georgia_events_from_4pm:
        officialEvents.length,

      events:
        officialEvents.map(
          x => ({
            source:
              x.source,

            event_id:
              x.event_id,

            text:
              x.link_text,

            eastern_start:
              x.eastern_start,

            publisher_name:
              x.publisher_name,

            city:
              x.city,

            match_terms:
              x.match_terms
          })
        )
    },

    summary: {
      active_streams_with_frames:
        results.filter(
          x =>
            x.frame_ok
        ).length,

      streams_with_nonempty_ocr:
        results.filter(
          x =>
            cleanSpace(
              x.ocr_text || ""
            )
        ).length,

      likely_georgia_matches:
        likelyMatches.length
    },

    likely_georgia_matches:
      likelyMatches,

    active_stream_results:
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
    "Diagnostic v12 complete."
  );

  console.log(
    `Active stale slots: ${results.length}`
  );

  console.log(
    `Likely Georgia OCR matches: ${likelyMatches.length}`
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
