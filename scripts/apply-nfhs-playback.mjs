import fs from "node:fs/promises";
import { decorateChannel, PLAYBACK_STATE_PATH } from "./playback-status.mjs";

// Reapply just-computed video statuses to the latest remote Georgia events.
// This is run AFTER git fetch/reset so a concurrent directory refresh is retained.
const events = JSON.parse(await fs.readFile("public/events.json", "utf8"));
const state = JSON.parse(await fs.readFile(PLAYBACK_STATE_PATH, "utf8"));
if (!Array.isArray(events.channels) || !state.streams) {
  throw new Error("Missing Georgia events or playback state.");
}
const now = Date.now();
events.channels = events.channels.map(e => decorateChannel(e, state, now));
events.playback_checked_at = state.last_run_at || null;
events.playback_verification_method =
  "Short authorized-provider media sample and ffprobe; actual matchup identity is not confirmed";
await fs.writeFile("public/events.json", JSON.stringify(events, null, 2) + "\n");
console.log(JSON.stringify({
  checked_at: state.last_run_at || null,
  channels: events.channels.length,
  detected_video: events.channels.filter(e => e.playback_verification?.status === "video_detected").length,
  unconfirmed_playback: events.channels.filter(e => e.playback_verification?.status === "probe_failed").length
}));
