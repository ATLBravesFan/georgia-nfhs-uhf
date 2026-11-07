import fs from "node:fs/promises";
import { DateTime } from "luxon";

// Generate an XMLTV schedule for the exact IDs of the Georgia NFHS M3U.
// A separate programme covers UPCOMING, scheduled LIVE, and ENDED windows,
// so UHF advances statuses by clock time, not by reloading title strings.
const EASTERN = "America/New_York";
const xml = v => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const epgTime = d => d.toUTC().toFormat("yyyyLLddHHmmss") + " +0000";
function programme(lines, id, start, stop, title, description, sport) {
  if (!start?.isValid || !stop?.isValid || stop <= start) return;
  lines.push('  <programme start="' + epgTime(start) + '" stop="' +
    epgTime(stop) + '" channel="' + xml(id) + '">');
  lines.push('    <title lang="en">' + xml(title) + '</title>');
  lines.push('    <desc lang="en">' + xml(description) + '</desc>');
  lines.push('    <category lang="en">Sports</category>');
  lines.push('    <category lang="en">' + xml(sport) + '</category>');
  lines.push('  </programme>');
}
const input = process.env.EPG_INPUT || "public/events.json";
const output = process.env.EPG_OUTPUT || "public/epg.xml";
const data = JSON.parse(await fs.readFile(input, "utf8"));
const events = Array.isArray(data.channels) ? data.channels : [];
const now = DateTime.now().setZone(EASTERN);
const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
  '<tv generator-info-name="Georgia NFHS Enhanced EPG">'];

for (const e of events) {
  if (!e.id) continue;
  lines.push('  <channel id="' + xml(e.id) + '">');
  lines.push('    <display-name>' + xml(e.name || e.original_name || "Georgia NFHS") +
    '</display-name>');
  if (e.logo) lines.push('    <icon src="' + xml(e.logo) + '" />');
  lines.push('  </channel>');
}
let programmeCount = 0;
for (const e of events) {
  if (!e.id) continue;
  const start = DateTime.fromISO(e.start || "", {zone: EASTERN});
  const stop = DateTime.fromISO(e.stop || "", {zone: EASTERN});
  const sport = e.sport || "High School Sports";
  const matchup = e.name || e.original_name || "Georgia NFHS event";
  if (!start.isValid || !stop.isValid || stop <= start) {
    programme(lines,e.id,now.minus({hours:6}),now.plus({hours:18}),
      "📅 " + sport + " • Schedule pending", matchup + ". Time unavailable.",sport);
    programmeCount++;
    continue;
  }
  const startsAt = start.toFormat("h:mm a");
  const details = matchup + ". Scheduled " +
    start.toFormat("ccc, LLL d 'at' h:mm a") + " ET; estimated finish " +
    stop.toFormat("ccc, LLL d 'at' h:mm a") +
    " ET. LIVE NOW reflects the scheduled window, not verified stream playback.";
  const pregame = now.startOf("day") < start.startOf("day") ?
    now.startOf("day") : start.startOf("day");
  const guideEnd = stop.plus({days:1}).startOf("day").plus({hours:5});
  programme(lines,e.id,pregame,start,
    "🕒 " + sport + " • Starts " + startsAt,details,sport);
  programme(lines,e.id,start,stop,
    "🔴 LIVE NOW • " + sport + " • In progress",details,sport);
  programme(lines,e.id,stop,guideEnd,
    "✅ " + sport + " • Event ended",details,sport);
  programmeCount += 3;
}
lines.push("</tv>");
await fs.mkdir(output.replace(/\/[^/]*$/, "") || ".", {recursive: true});
await fs.writeFile(output, lines.join("\n") + "\n","utf8");
console.log("Enhanced EPG: " + events.length + " channels, " +
  programmeCount + " programme windows -> " + output);
