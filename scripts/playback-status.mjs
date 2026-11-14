// Non-sensitive stream verification labels shared by the builder and probe.
// A working video stream is NOT proof that the advertised matchup is correct.
export const PLAYBACK_STATE_PATH = "public/stream-verification.json";
export const VIDEO_FRESH_MS = 25 * 60 * 1000;
export const FAILURE_FRESH_MS = 25 * 60 * 1000;

function fresh(iso, nowMs, maxAge) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) && ms <= nowMs + 60_000 && nowMs - ms >= 0 && nowMs - ms <= maxAge;
}

export function decorateChannel(channel, state, nowMs = Date.now()) {
  const id = String(channel.stream_id || "");
  const record = state?.streams?.[id];
  const title = channel.original_name || "";
  const sameEvent = Boolean(record && record.original_name === title);
  const recentVideo = sameEvent && record.last_result === "video_detected" &&
    fresh(record.last_checked_at, nowMs, VIDEO_FRESH_MS);
  const recentFailure = sameEvent && record.last_result !== "video_detected" &&
    (record.consecutive_failures || 0) >= 2 &&
    fresh(record.last_checked_at, nowMs, FAILURE_FRESH_MS);
  const status = recentVideo ? "video_detected" : recentFailure ? "probe_failed" : "unverified";
  const baseName = String(channel.name || "").replace(/^(?:🎥 VIDEO DETECTED \| |⚠️ PLAYBACK UNCONFIRMED \| )/u, "");
  const prefix = status === "video_detected" ? "🎥 VIDEO DETECTED | " :
    status === "probe_failed" ? "⚠️ PLAYBACK UNCONFIRMED | " : "";
  return {
    ...channel,
    name: prefix + baseName,
    playback_verification: {
      status,
      checked_at: sameEvent ? record.last_checked_at || null : null,
      last_video_at: sameEvent ? record.last_video_at || null : null,
      reason: sameEvent ? record.last_result || null : null,
      // Video detected does not establish that the advertised teams are on screen.
      matchup_confirmed: false
    }
  };
}
