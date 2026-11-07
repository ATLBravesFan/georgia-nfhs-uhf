// Enhanced Georgia NFHS -> UHF Cloudflare Worker
// Environment: DATA_URL, XTREAM_BASE_URL, XTREAM_USERNAME,
// XTREAM_PASSWORD, ACCESS_KEY. Keep credentials as Worker secrets.
const EASTERN = "America/New_York";
const DAY_MS = 86400000;
const EASTERN_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});
const TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN, hour: "numeric", minute: "2-digit", hour12: true
});
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN, weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", hour12: true
});
function xml(v) {
  return String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function m3u(v) { return String(v ?? "").replace(/[\r\n]/g, " ").replace(/"/g, "'"); }
function utcXmltv(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14) + " +0000";
}
function easternParts(date) {
  return Object.fromEntries(EASTERN_PARTS.formatToParts(date)
    .filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
}
function easternAt(day, hour = 0) {
  const [y, m, d] = day.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, hour, 0, 0);
  let estimate = wanted + 5 * 3600000;
  for (let i = 0; i < 4; i++) {
    const p = easternParts(new Date(estimate));
    const observed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    estimate += wanted - observed;
  }
  return estimate;
}
function easternDay(ms) {
  const p = easternParts(new Date(ms));
  return [p.year, String(p.month).padStart(2, "0"), String(p.day).padStart(2, "0")].join("-");
}
function followingDay(day) {
  return new Date(Date.parse(day + "T00:00:00Z") + DAY_MS).toISOString().slice(0, 10);
}
function programme(lines, id, begin, end, title, description, sport) {
  if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin) return;
  lines.push('  <programme channel="' + xml(id) + '" start="' + utcXmltv(begin) + '" stop="' + utcXmltv(end) + '">');
  lines.push('    <title lang="en">' + xml(title) + '</title>');
  lines.push('    <desc lang="en">' + xml(description) + '</desc>');
  lines.push('    <category lang="en">Sports</category>');
  lines.push('    <category lang="en">' + xml(sport) + '</category>');
  lines.push('  </programme>');
}
function sportName(e) {
  if (String(e.sport || "").trim()) return String(e.sport).trim();
  const match = String(e.name || "").match(/flag football|football|basketball|volleyball|baseball|softball|soccer|wrestling|lacrosse|field hockey|hockey|tennis|swimming|track|cross country|golf/i);
  return match ? match[0].replace(/\b\w/g, c => c.toUpperCase()) : "High School Sports";
}
function eventStatus(e, now) {
  const start = Date.parse(e.start || ""), stop = Date.parse(e.stop || "");
  if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return "unscheduled";
  if (now < start) return "upcoming";
  if (now < stop) return "in_progress_estimate";
  return "ended_estimate";
}
function buildEpg(data, now = Date.now()) {
  const events = Array.isArray(data.channels) ? data.channels : [];
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="Georgia NFHS UHF Enhanced Guide">'];
  for (const e of events) {
    if (!e.id) continue;
    lines.push('  <channel id="' + xml(e.id) + '">');
    lines.push('    <display-name>' + xml(e.name || e.original_name || "Georgia NFHS") + '</display-name>');
    if (e.logo) lines.push('    <icon src="' + xml(e.logo) + '" />');
    lines.push('  </channel>');
  }
  for (const e of events) {
    if (!e.id) continue;
    const sport = sportName(e);
    const matchup = e.name || e.original_name || "Georgia NFHS event";
    const start = Date.parse(e.start || ""), stop = Date.parse(e.stop || "");
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) {
      programme(lines, e.id, now - 3600000, now + 21600000,
        "📅 " + sport + " • Schedule pending", matchup + ". Broadcast times unavailable.", sport);
      continue;
    }
    const time = TIME_FORMATTER.format(new Date(start));
    const dateTime = DATE_FORMATTER.format(new Date(start));
    const estimatedEnd = DATE_FORMATTER.format(new Date(stop));
    const details = matchup + ". Scheduled " + dateTime + " ET; estimated end " +
      estimatedEnd + " ET. Status is based on schedule, not verified playback.";
    const currentLocalDay = easternDay(now), eventLocalDay = easternDay(start);
    const dayBegin = easternAt(currentLocalDay < eventLocalDay ? currentLocalDay : eventLocalDay);
    const endsAt = easternAt(followingDay(easternDay(stop)), 5);
    programme(lines, e.id, dayBegin, start, "🕒 " + sport + " • Starts " + time, details, sport);
    programme(lines, e.id, start, stop, "🔴 LIVE NOW • " + sport + " • In progress", details, sport);
    programme(lines, e.id, stop, endsAt, "✅ " + sport + " • Event ended", details, sport);
  }
  lines.push("</tv>");
  return lines.join("\n") + "\n";
}
function buildPlaylist(events, requestUrl, env) {
  const url = new URL(requestUrl);
  url.searchParams.set("format", "xml");
  const lines = ['#EXTM3U url-tvg="' + m3u(url.toString()) + '"'];
  const base = String(env.XTREAM_BASE_URL).replace(/\/+$/, "");
  for (const e of events) {
    if (!e.id || !e.stream_id) continue;
    const title = e.name || e.original_name || "Georgia NFHS";
    const attrs = ['tvg-id="' + m3u(e.id) + '"', 'tvg-name="' + m3u(title) + '"',
      'group-title="NFHS | Georgia"'];
    if (e.logo) attrs.push('tvg-logo="' + m3u(e.logo) + '"');
    lines.push("#EXTINF:-1 " + attrs.join(" ") + "," + title.replace(/[\r\n]/g, " "));
    const ext = /^[a-z0-9]+$/i.test(e.extension || "") ? e.extension : "ts";
    lines.push(base + "/live/" + encodeURIComponent(env.XTREAM_USERNAME) + "/" +
      encodeURIComponent(env.XTREAM_PASSWORD) + "/" + encodeURIComponent(e.stream_id) + "." + ext);
  }
  return lines.join("\n") + "\n";
}
function response(content, contentType, status = 200) {
  return new Response(content, {status, headers:{
    "Content-Type": contentType, "Cache-Control": "private, no-store",
    "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff"
  }});
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.ACCESS_KEY || url.searchParams.get("key") !== env.ACCESS_KEY) {
      return response("Unauthorized", "text/plain; charset=utf-8", 401);
    }
    if (!env.DATA_URL) return response("DATA_URL not configured", "text/plain; charset=utf-8", 503);
    const format = String(url.searchParams.get("format") || "m3u").toLowerCase();
    if (!["m3u","xml","xmltv","epg","json","status","debug"].includes(format)) {
      return response("Unknown format", "text/plain; charset=utf-8", 400);
    }
    const sourceUrl = new URL(env.DATA_URL);
    sourceUrl.searchParams.set("_nfhs_minute", String(Math.floor(Date.now() / 60000)));
    let data;
    try {
      const source = await fetch(sourceUrl.toString(), {headers:{"Accept":"application/json"}});
      if (!source.ok) throw new Error("HTTP " + source.status);
      data = await source.json();
      if (!data || !Array.isArray(data.channels)) throw new Error("invalid events format");
    } catch (err) {
      return response("Georgia NFHS data temporarily unavailable: " + String(err.message || err),
        "text/plain; charset=utf-8", 502);
    }
    const now = Date.now();
    if (["xml","xmltv","epg"].includes(format)) {
      return response(buildEpg(data, now), "application/xml; charset=utf-8");
    }
    if (["json","status","debug"].includes(format)) {
      return response(JSON.stringify({...data,epg_format:"enhanced-v1",
        epg_generated_at:new Date(now).toISOString(),
        currently_in_schedule_window:data.channels.filter(e => eventStatus(e, now) === "in_progress_estimate").length,
        channels:data.channels.map(e => ({...e,schedule_status:eventStatus(e, now)}))}, null, 2),
        "application/json; charset=utf-8");
    }
    for (const field of ["XTREAM_BASE_URL","XTREAM_USERNAME","XTREAM_PASSWORD"]) {
      if (!env[field]) return response("Missing Worker secret " + field, "text/plain; charset=utf-8", 503);
    }
    return response(buildPlaylist(data.channels, request.url, env), "application/x-mpegURL; charset=utf-8");
  }
};