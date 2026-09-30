import fs from "node:fs/promises";
import { DateTime } from "luxon";

const DEFAULT_CATEGORY = "USA | NFHS Network";
const STATE_PATH = "public/nfhs-provider-state.json";
const WATCH_PATH = "public/nfhs-provider-watch.json";
const EASTERN = "America/New_York";
const MAX_HISTORY = 500;

function cleanSpace(s = "") {
  return String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function providerNumber(name = "") {
  const m = String(name).match(/^NFHS\s+Network\s+(\d+)\s*:/i);
  return m ? Number(m[1]) : null;
}

function parseProviderStart(name = "") {
  const m = String(name).match(/@\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET\s*$/i);
  if (!m) return null;

  const year = DateTime.now().setZone(EASTERN).year;
  const dt = DateTime.fromFormat(
    `${m[1]} ${m[2]} ${year} ${m[3]}:${m[4]} ${m[5].toUpperCase()}`,
    "d LLL yyyy h:mm a",
    { zone: EASTERN, locale: "en-US" }
  );
  return dt.isValid ? dt : null;
}

async function fetchText(url, timeoutMs = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 Georgia-NFHS-Provider-Watch/1.0" }
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${text.slice(0,180)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 30000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function countByDay(rows) {
  const out = {};
  for (const row of rows) {
    const day = row.provider_day || "undated";
    out[day] = (out[day] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a],[b]) => a.localeCompare(b))
  );
}

function stateComparable(state) {
  return JSON.stringify({
    category: state.category,
    rows: state.rows
  });
}

async function main() {
  const base = cleanSpace(process.env.XTREAM_BASE_URL || "").replace(/\/+$/, "");
  const username = process.env.XTREAM_USERNAME || "";
  const password = process.env.XTREAM_PASSWORD || "";

  if (!base || !username || !password) {
    throw new Error("Missing XTREAM_BASE_URL, XTREAM_USERNAME, or XTREAM_PASSWORD.");
  }

  const auth = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const categories = await fetchJson(`${base}/player_api.php?${auth}&action=get_live_categories`);
  if (!Array.isArray(categories)) throw new Error("Category response was not an array.");

  const wanted = cleanSpace(process.env.NFHS_CATEGORY_NAME || DEFAULT_CATEGORY).toLowerCase();
  let category = categories.find(c => cleanSpace(c.category_name).toLowerCase() === wanted);
  if (!category) category = categories.find(c => /nfhs/i.test(String(c.category_name || "")));
  if (!category) throw new Error("Could not find NFHS category.");

  const streams = await fetchJson(
    `${base}/player_api.php?${auth}&action=get_live_streams&category_id=${encodeURIComponent(category.category_id)}`
  );
  if (!Array.isArray(streams)) throw new Error("Provider stream response was not an array.");

  const rows = streams
    .map(s => {
      const n = providerNumber(s.name || "");
      if (n === null) return null;
      const start = parseProviderStart(s.name || "");
      return {
        provider_nfhs_number: n,
        stream_id: Number(s.stream_id),
        title: cleanSpace(s.name || ""),
        provider_start: start?.toISO() || null,
        provider_day: start?.toISODate() || null,
        added: Number(s.added || 0) || null,
        epg_channel_id: s.epg_channel_id || null,
        custom_sid: s.custom_sid || null
      };
    })
    .filter(Boolean)
    .sort((a,b) => a.provider_nfhs_number - b.provider_nfhs_number);

  const now = new Date().toISOString();
  const current = {
    category: cleanSpace(category.category_name || DEFAULT_CATEGORY),
    stream_count: rows.length,
    title_day_counts: countByDay(rows),
    rows
  };

  const previous = await readJson(STATE_PATH, null);
  const prevMap = new Map((previous?.rows || []).map(x => [x.provider_nfhs_number, x]));
  const currMap = new Map(rows.map(x => [x.provider_nfhs_number, x]));

  const addedSlots = [];
  const removedSlots = [];
  const changedSlots = [];

  for (const row of rows) {
    const old = prevMap.get(row.provider_nfhs_number);
    if (!old) {
      addedSlots.push(row);
      continue;
    }

    const changes = {};
    for (const key of [
      "stream_id","title","provider_start","provider_day","added","epg_channel_id","custom_sid"
    ]) {
      if ((old[key] ?? null) !== (row[key] ?? null)) {
        changes[key] = { before: old[key] ?? null, after: row[key] ?? null };
      }
    }

    if (Object.keys(changes).length) {
      changedSlots.push({
        provider_nfhs_number: row.provider_nfhs_number,
        changes
      });
    }
  }

  for (const old of previous?.rows || []) {
    if (!currMap.has(old.provider_nfhs_number)) removedSlots.push(old);
  }

  const days = Object.keys(current.title_day_counts).filter(x => x !== "undated").sort();
  const latestDay = days.at(-1) || null;
  const previousDays = Object.keys(previous?.title_day_counts || {}).filter(x => x !== "undated").sort();
  const previousLatestDay = previousDays.at(-1) || null;

  const changed =
    !previous ||
    addedSlots.length ||
    removedSlots.length ||
    changedSlots.length ||
    latestDay !== previousLatestDay;

  console.log(JSON.stringify({
    checked_at: now,
    provider_stream_count: rows.length,
    latest_title_day: latestDay,
    previous_latest_title_day: previousLatestDay,
    added_slots: addedSlots.length,
    removed_slots: removedSlots.length,
    changed_slots: changedSlots.length,
    changed: Boolean(changed)
  }, null, 2));

  if (!changed) {
    console.log("No provider metadata changes. No files written.");
    return;
  }

  const stateToWrite = {
    captured_at: now,
    ...current
  };

  const watch = await readJson(WATCH_PATH, {
    diagnostic_only: true,
    modifies_epg: false,
    purpose:
      "Track changes in the provider's 5,000 NFHS slot metadata over time so we can learn how stale titles and stream-slot reuse actually behave. No playback is opened.",
    history: []
  });

  watch.last_change_at = now;
  watch.current = {
    stream_count: rows.length,
    latest_title_day: latestDay,
    title_day_counts: current.title_day_counts
  };
  watch.history = Array.isArray(watch.history) ? watch.history : [];
  watch.history.push({
    captured_at: now,
    previous_latest_title_day: previousLatestDay,
    latest_title_day: latestDay,
    added_slot_count: addedSlots.length,
    removed_slot_count: removedSlots.length,
    changed_slot_count: changedSlots.length,
    added_slots: addedSlots.slice(0, 150),
    removed_slots: removedSlots.slice(0, 150),
    changed_slots: changedSlots.slice(0, 500)
  });
  if (watch.history.length > MAX_HISTORY) {
    watch.history = watch.history.slice(-MAX_HISTORY);
  }

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(stateToWrite, null, 2) + "\n", "utf8");
  await fs.writeFile(WATCH_PATH, JSON.stringify(watch, null, 2) + "\n", "utf8");

  console.log("Provider watch state updated.");
  console.log("public/events.json was NOT modified.");
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
