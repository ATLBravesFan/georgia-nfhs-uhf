import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import { DateTime } from "luxon";

const EASTERN = "America/New_York";
const DEFAULT_CATEGORY = "USA | NFHS Network";
const DEFAULT_GHSA_URL = "https://www.ghsa.net/2026-2027-region-alignments";
const GIAA_URL = "https://www.giaasports.org/members/";
const GAPPS_URL = "https://gappsports.com/member-schools";
const LOOKAHEAD_DAYS = Math.max(1, Math.min(14, Number(process.env.LOOKAHEAD_DAYS || 7)));

const FALLBACK_GEORGIA_SCHOOLS = [
  "Lowndes", "Valdosta", "Camden County", "Colquitt County", "Tift County",
  "Coffee", "Ware County", "Pierce County", "Brooks County", "Berrien", "Cook",
  "Bacon County", "Appling County", "Brantley County", "Charlton County", "Clinch County",
  "Atkinson County", "Lanier County", "Echols County", "Irwin County", "Jeff Davis",
  "Thomas County Central", "Thomasville", "Bainbridge", "Cairo", "Worth County",
  "Lee County", "Houston County", "Veterans", "Northside, Warner Robins", "Warner Robins",
  "Georgia Christian School", "Valwood School", "Highland Christian Academy",
  "Citizens Christian Academy", "Tiftarea Academy", "Southwest Georgia Academy",
  "Deerfield-Windsor School", "Sherwood Christian Academy", "Westwood School",
  "Scintilla Charter Academy", "Southwest Georgia STEM", "Spring Creek Charter Academy"
];

const AMBIGUOUS_CORES = new Set([
  "alexander", "archer", "bainbridge", "bremen", "brunswick", "calhoun", "campbell",
  "carrollton", "commerce", "columbus", "decatur", "discovery", "douglas county",
  "dublin", "evans", "gainesville", "greenville", "griffin", "hampton", "harrison",
  "jackson", "jefferson", "jordan", "lambert", "manchester", "marietta", "midtown",
  "model", "monroe", "newton", "newnan", "norcross", "parkview", "perry", "rome",
  "salem", "savannah", "stockbridge", "temple", "thomasville", "trinity christian",
  "walker", "walton", "washington", "wheeler", "woodstock", "westwood", "spring creek",
  "lee county", "baker county", "houston county", "worth county", "union county",
  "washington county", "jefferson county", "jasper county", "madison county", "franklin county",
  // Nationally duplicated names that can otherwise produce false Georgia matches.
  "river ridge", "blessed trinity", "st mary s"
]);

const LOCAL_PRIORITY = new Set([
  "lowndes", "valdosta", "camden county", "colquitt county", "tift county", "coffee",
  "ware county", "pierce county", "brooks county", "berrien", "cook", "bacon county",
  "appling county", "brantley county", "charlton county", "clinch county", "atkinson county",
  "lanier county", "echols county", "irwin county", "jeff davis", "thomas county central",
  "georgia christian", "valwood", "highland christian"
]);

const EXPLICIT_TEAM_ALIASES = new Map([
  ["georgia christian generals", "georgia christian"],
  ["lowndes vikings", "lowndes"],
  ["valdosta wildcats", "valdosta"],
  ["pierce county bears", "pierce county"],
  ["ware county gators", "ware county"],
  ["brooks county trojans", "brooks county"],
  ["colquitt county packers", "colquitt county"],
  ["tift county blue devils", "tift county"],
  ["coffee trojans", "coffee"]
]);

function cleanSpace(s = "") {
  return String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
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

async function fetchText(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 Georgia-NFHS-UHF/2.0" }
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 20000) {
  const text = await fetchText(url, timeoutMs);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Provider returned non-JSON data: ${text.slice(0, 180)}`);
  }
}

function looksLikeNoise(line) {
  const s = cleanSpace(line);
  if (!s) return true;
  if (/^\|$/.test(s)) return true;
  if (/^[A-Z]{1,7}\s*\(\d+\)$/.test(s)) return true;
  if (/^\d+-[A-Z]{1,7}\s*\(\d+\)$/.test(s)) return true;
  if (/^\d+\s+Schools?$/i.test(s)) return true;
  if (/^\*\*/.test(s) || /Schools Not Playing/i.test(s) || /Non-Region/i.test(s)) return true;
  if (/^202\d-202\d Region Alignments$/i.test(s)) return true;
  return false;
}

function cleanGhsaName(line) {
  return cleanSpace(line).replace(/\s+\*\*.*$/, "").replace(/\s+NR\s*$/, "").trim();
}

function extractGhsaSchools(html) {
  const $ = cheerio.load(html);
  const out = new Set();
  $("td").each((_, el) => {
    const raw = $(el).html() || "";
    const txt = cheerio.load(`<div>${raw.replace(/<br\s*\/?\s*>/gi, "\n")}</div>`)("div").text();
    for (const part of txt.split(/\n+/)) {
      const s = cleanGhsaName(part);
      if (!looksLikeNoise(s) && /[A-Za-z]/.test(s) && s.length <= 80) out.add(s);
    }
  });
  const lines = $("body").text().split(/\r?\n/).map(cleanSpace).filter(Boolean);
  let active = false;
  for (const raw of lines) {
    if (/202\d-202\d Region Alignments/i.test(raw)) { active = true; continue; }
    if (active && /^\d+\s+Schools$/i.test(raw)) break;
    if (!active) continue;
    const s = cleanGhsaName(raw);
    if (!looksLikeNoise(s) && /[A-Za-z]/.test(s) && s.length <= 80) out.add(s);
  }
  for (const x of [...out]) {
    if (/^(print|return|footer|schools|sports|activities|inside ghsa|resources)$/i.test(x)) out.delete(x);
    if (/^(AAAA|AAA|AA|A)+/i.test(x) && /\d/.test(x)) out.delete(x);
  }
  return [...out];
}

function extractGiaaSchools(html) {
  const $ = cheerio.load(html);
  const out = new Set();
  let active = false;

  // The GIAA page lists the member schools as links between the
  // "GIAA MEMBERS" and "GISA MEMBERS" headings. Walking DOM elements
  // is more reliable than splitting body text because WordPress may
  // collapse the visible text into one long line.
  $("body *").each((_, el) => {
    const tag = String(el.tagName || el.name || "").toLowerCase();
    const text = cleanSpace($(el).text());

    if (/^h[1-6]$/.test(tag)) {
      if (/^GIAA MEMBERS$/i.test(text)) { active = true; return; }
      if (active && /^GISA MEMBERS$/i.test(text)) { active = false; return false; }
    }

    if (!active || tag !== "a") return;
    const name = cleanSpace($(el).text());
    if (!name || name.length < 3 || name.length > 110) return;
    if (/^(email|login|tickets|more|members|about)$/i.test(name)) return;
    out.add(name);
  });

  // Fallback for a future page redesign: look for text bounded by the
  // same headings and split on common list separators.
  if (!out.size) {
    const body = cleanSpace($("body").text());
    const m = body.match(/GIAA MEMBERS\s+([\s\S]*?)\s+GISA MEMBERS/i);
    if (m) {
      for (const piece of m[1].split(/\s{2,}|\n|\r|\t/)) {
        const name = cleanSpace(piece);
        if (name && name.length >= 3 && name.length <= 110) out.add(name);
      }
    }
  }

  return [...out];
}

function extractGappsSchools(html) {
  const $ = cheerio.load(html);
  const out = new Set();
  $("a").each((_, el) => {
    const text = cleanSpace($(el).text());
    const href = ($(el).attr("href") || "").toLowerCase();
    if (!text || text.length > 110) return;
    if (href.includes("gappsports.com") || href.startsWith("#") || href.startsWith("mailto:")) return;
    if (/school|academy|christian|homeschool|preparatory|prep|athletics|college|institute|tribe|force|campus|classical|montessori/i.test(text)) out.add(text);
  });
  ["Georgia Force", "North Georgia Tribe", "The Campus", "Central Georgia Arts & Athletics"].forEach(x => out.add(x));
  return [...out];
}

function buildAliases(names) {
  const aliases = new Set();
  for (const rawName of names) {
    if (!rawName) continue;
    const cleaned = cleanSpace(rawName);
    const variants = new Set([cleaned]);
    if (cleaned.includes(",")) {
      const [a, b] = cleaned.split(",").map(cleanSpace);
      variants.add(`${a} ${b}`);
      variants.add(`${a} - ${b}`);
      if (normalize(a).length >= 9 && !AMBIGUOUS_CORES.has(normalize(a))) variants.add(a);
    }
    variants.add(cleaned.replace(/\bCatholic High School\b/i, "Catholic"));
    variants.add(cleaned.replace(/\bPreparatory School\b/i, "Prep"));
    variants.add(cleaned.replace(/\bPreparatory Academy\b/i, "Prep Academy"));
    variants.add(cleaned.replace(/\bChristian Academy\b/i, "Christian"));
    variants.add(cleaned.replace(/\bCharter Academy\b/i, "Charter"));
    for (const v of variants) {
      const n = normalize(v);
      if (n.length >= 4) aliases.add(n);
    }
  }
  return aliases;
}

async function getGeorgiaSchoolAliases() {
  const ghsaUrl = process.env.GHSA_DIRECTORY_URL || DEFAULT_GHSA_URL;
  const names = new Set(FALLBACK_GEORGIA_SCHOOLS);
  const sourceStatus = {};
  const requests = [
    ["GHSA", ghsaUrl, extractGhsaSchools],
    ["GIAA", GIAA_URL, extractGiaaSchools],
    ["GAPPS", GAPPS_URL, extractGappsSchools]
  ];
  const results = await Promise.allSettled(requests.map(async ([label, url, parser]) => {
    const html = await fetchText(url);
    return { label, parsed: parser(html) };
  }));
  for (let i = 0; i < results.length; i++) {
    const label = requests[i][0];
    const r = results[i];
    if (r.status === "fulfilled") {
      for (const n of r.value.parsed) names.add(n);
      sourceStatus[label] = { ok: true, count: r.value.parsed.length };
    } else {
      sourceStatus[label] = { ok: false, error: String(r.reason?.message || r.reason) };
    }
  }
  return { names: [...names], aliases: buildAliases(names), sourceStatus };
}

function stripEventPrefix(name) {
  return cleanSpace(name).replace(/^NFHS\s+Network\s+\d+\s*:\s*/i, "");
}

function stripEventTime(name) {
  return stripEventPrefix(name).replace(/\s*@\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*ET\s*$/i, "").trim();
}

const SPORT_AND_LEVEL_SUFFIX = new RegExp(
  String.raw`(?:\s+(?:Varsity|Junior Varsity|JV|Freshman|Middle School|MS|7th Grade|8th Grade|Boys|Girls))*` +
  String.raw`\s+(?:Football|Flag Football|Volleyball|Basketball|Baseball|Softball|Soccer|Wrestling|Lacrosse|Field Hockey|Ice Hockey|Hockey|Tennis|Swimming|Track(?: and Field)?|Cross Country|Golf|Cheerleading)\s*$`,
  "i"
);

function cleanTeamName(team) {
  let s = cleanSpace(team).replace(/^(?:Home|Away|None)\s+/i, "").replace(/\s+at\s+.+$/i, "");
  for (let i = 0; i < 3; i++) s = s.replace(SPORT_AND_LEVEL_SUFFIX, "").trim();
  return s.replace(/\s+(?:Varsity|Junior Varsity|JV|Freshman|Middle School|MS|Boys|Girls)\s*$/i, "").trim();
}

function eventTeams(streamName) {
  const body = stripEventTime(streamName);
  const parts = body.split(/\s+vs\.?\s+|\s+versus\s+/i).map(cleanTeamName).filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, 2);
  const atParts = body.split(/\s+@\s+/).map(cleanTeamName).filter(Boolean);
  if (atParts.length >= 2) return atParts.slice(0, 2);
  return [cleanTeamName(body)];
}

function scoreTeamAgainstAliases(team, aliases) {
  const t = normalize(team);
  if (!t) return { matched: false, core: "", confidence: 0 };
  const explicit = EXPLICIT_TEAM_ALIASES.get(t);
  if (explicit && aliases.has(explicit)) return { matched: true, core: explicit, confidence: 3 };
  if (aliases.has(t)) {
    const oneWord = t.split(" ").length === 1;
    const confidence = LOCAL_PRIORITY.has(t) ? 3 : ((AMBIGUOUS_CORES.has(t) || oneWord) ? 1 : 2);
    return { matched: true, core: t, confidence };
  }
  return { matched: false, core: "", confidence: 0 };
}

function isGeorgiaEvent(name, aliases) {
  const teams = eventTeams(name);
  const scored = teams.map(t => ({ team: t, ...scoreTeamAgainstAliases(t, aliases) }));
  const matches = scored.filter(x => x.matched);
  if (!matches.length) return { keep: false, teams, matches: [] };
  if (matches.some(x => x.confidence >= 2)) return { keep: true, teams, matches };
  if (matches.length >= 2) return { keep: true, teams, matches };
  return { keep: false, teams, matches };
}

function parseEventStart(name, now = DateTime.now().setZone(EASTERN)) {
  const m = String(name).match(/@\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET\s*$/i);
  if (!m) return null;
  const [, dayS, monS, hourS, minS, ampm] = m;
  const month = DateTime.fromFormat(monS, "LLL", { zone: EASTERN }).month;
  if (!month) return null;
  let hour = Number(hourS) % 12;
  if (ampm.toUpperCase() === "PM") hour += 12;
  let dt = DateTime.fromObject({ year: now.year, month, day: Number(dayS), hour, minute: Number(minS), second: 0 }, { zone: EASTERN });
  if (!dt.isValid) return null;
  if (dt.diff(now, "days").days > 180) dt = dt.minus({ years: 1 });
  if (dt.diff(now, "days").days < -180) dt = dt.plus({ years: 1 });
  return dt;
}

function durationMinutes(name) {
  const s = name.toLowerCase();
  if (s.includes("football")) return 210;
  if (s.includes("baseball") || s.includes("softball")) return 180;
  if (s.includes("volleyball") || s.includes("basketball")) return 150;
  if (s.includes("soccer") || s.includes("lacrosse") || s.includes("field hockey")) return 150;
  if (s.includes("wrestling")) return 180;
  return 180;
}

function detectSport(name) {
  const n = name.toLowerCase();
  for (const s of ["flag football", "football", "volleyball", "basketball", "baseball", "softball", "soccer", "wrestling", "lacrosse", "field hockey", "hockey", "tennis", "swimming", "track", "cross country", "golf"])
    if (n.includes(s)) return s.replace(/\b\w/g, c => c.toUpperCase());
  return "High School Sports";
}

async function getNfhsStreams() {
  const base = cleanSpace(process.env.XTREAM_BASE_URL || "").replace(/\/+$/, "");
  const username = process.env.XTREAM_USERNAME || "";
  const password = process.env.XTREAM_PASSWORD || "";
  if (!base || !username || !password) throw new Error("Missing XTREAM_BASE_URL, XTREAM_USERNAME, or XTREAM_PASSWORD GitHub secret.");
  const auth = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const categories = await fetchJson(`${base}/player_api.php?${auth}&action=get_live_categories`);
  if (!Array.isArray(categories)) throw new Error("Xtream live category response was not an array.");
  const wanted = cleanSpace(process.env.NFHS_CATEGORY_NAME || DEFAULT_CATEGORY).toLowerCase();
  let category = categories.find(c => cleanSpace(c.category_name).toLowerCase() === wanted);
  if (!category) category = categories.find(c => /nfhs/i.test(String(c.category_name || "")));
  if (!category) throw new Error("Could not find an NFHS category in the provider account.");
  let streams = await fetchJson(`${base}/player_api.php?${auth}&action=get_live_streams&category_id=${encodeURIComponent(category.category_id)}`);
  if (!Array.isArray(streams)) throw new Error("Xtream live stream response was not an array.");
  streams = streams.filter(s => String(s.category_id) === String(category.category_id) || !s.category_id);
  return { category, streams };
}

function createOutputStreams(provider, aliases) {
  const now = DateTime.now().setZone(EASTERN);
  const maxStart = now.plus({ days: LOOKAHEAD_DAYS });
  const output = [];
  let totalGeorgiaMatches = 0;
  let completedTodayButVisible = 0;

  for (const s of provider.streams) {
    const name = cleanSpace(s.name || "");
    if (!name || /NO EVENT/i.test(name)) continue;
    const geo = isGeorgiaEvent(name, aliases);
    if (!geo.keep) continue;
    totalGeorgiaMatches++;

    const start = parseEventStart(name, now);
    const stop = start ? start.plus({ minutes: durationMinutes(name) }) : null;
    if (start && start > maxStart) continue;
    if (start && stop < now.minus({ minutes: 20 })) {
      if (start.hasSame(now, "day")) completedTodayButVisible++;
      continue;
    }

    const ext = cleanSpace(s.container_extension || "ts").replace(/^\./, "") || "ts";
    output.push({
      id: `ga-nfhs-${s.stream_id}`,
      stream_id: s.stream_id,
      extension: ext,
      original_name: name,
      name: stripEventTime(name),
      logo: s.stream_icon || "",
      start: start?.toISO() || null,
      stop: stop?.toISO() || null,
      sport: detectSport(name),
      teams: geo.teams,
      matched_schools: geo.matches.map(x => ({ team: x.team, core: x.core, confidence: x.confidence }))
    });
  }

  output.sort((a, b) => {
    if (a.start && b.start) return Date.parse(a.start) - Date.parse(b.start);
    if (a.start) return -1;
    if (b.start) return 1;
    return a.name.localeCompare(b.name);
  });
  return { output, totalGeorgiaMatches, completedTodayButVisible };
}

async function main() {
  const now = DateTime.now().setZone(EASTERN);
  const [provider, schoolData] = await Promise.all([getNfhsStreams(), getGeorgiaSchoolAliases()]);
  const { output, totalGeorgiaMatches, completedTodayButVisible } = createOutputStreams(provider, schoolData.aliases);
  const currentlyLive = output.filter(x => x.start && x.stop && DateTime.fromISO(x.start) <= now && DateTime.fromISO(x.stop) >= now).length;
  const upcoming = output.filter(x => x.start && DateTime.fromISO(x.start) > now).length;
  const payload = {
    generated_at: now.toISO(),
    eastern_date: now.toISODate(),
    lookahead_days: LOOKAHEAD_DAYS,
    category: provider.category?.category_name || DEFAULT_CATEGORY,
    source_stream_count: provider.streams.length,
    total_georgia_matches_found: totalGeorgiaMatches,
    georgia_channel_count: output.length,
    currently_live_estimate: currentlyLive,
    upcoming_next_7_days: upcoming,
    completed_today_but_still_visible: completedTodayButVisible,
    placeholder_active: output.length === 0,
    directory_sources: schoolData.sourceStatus,
    school_name_count: schoolData.names.length,
    channels: output
  };
  await fs.mkdir("public", { recursive: true });
  await fs.writeFile("public/events.json", JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${output.length} Georgia NFHS channel(s) from ${provider.streams.length} NFHS source streams.`);
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
