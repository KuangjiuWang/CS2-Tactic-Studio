import { tickToPovSeconds } from "./povClock";

const PAUSED_SEEK_EPSILON_SECONDS = 0.04;
const FOLLOWER_RATE_ADJUST_THRESHOLD_SECONDS = 0.08;
const FOLLOWER_HARD_SEEK_THRESHOLD_SECONDS = 0.4;
const MAX_RATE_CORRECTION = 0.08;

function normalizedSpeed(speed) {
  const value = Number(speed);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function pause(video) {
  if (!video.paused) video.pause();
}

function setTime(video, seconds) {
  try {
    video.currentTime = seconds;
  } catch {
    // A media element can reject a seek while it is still opening its source.
  }
}

function play(video) {
  try {
    void video.play()?.catch(() => {});
  } catch {
    // Browser autoplay and decoder readiness can temporarily reject a preview.
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Keep every POV on the shared demo-tick clock.
 *
 * The main POV or selected multiview tile is the clock leader. Other video
 * elements are followers: small drift is corrected with a bounded rate nudge,
 * while larger drift is corrected with one seek. Players remain parked outside
 * their recorded coverage instead of playing unrelated frames.
 */
export function syncPovVideo(video, pov, {
  tick,
  tickRate,
  playing,
  speed = 1,
  pageVisible = true,
  role = "follower",
  forceSeek = false,
  muted = false,
} = {}) {
  if (!video) return;
  const baseRate = normalizedSpeed(speed);
  video.muted = muted;
  video.playbackRate = baseRate;

  if (!pageVisible || pov?.status !== "Complete") {
    pause(video);
    return;
  }

  const sharedTick = Number(tick);
  const startTick = Number(pov.coverage_start_tick);
  const endTick = Number(pov.coverage_end_tick);
  const validSharedTick = Number.isFinite(sharedTick);
  const beforeCoverage = validSharedTick && Number.isFinite(startTick) && sharedTick < startTick;
  const afterCoverage = validSharedTick && Number.isFinite(endTick) && sharedTick >= endTick;
  const rawDuration = Number(video.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : Infinity;
  const target = tickToPovSeconds(sharedTick, startTick, tickRate, duration, endTick);
  const currentTime = Number(video.currentTime);
  const drift = target - (Number.isFinite(currentTime) ? currentTime : 0);
  const canSeek = forceSeek || video.readyState >= 1;

  if (forceSeek || !playing || beforeCoverage || afterCoverage) {
    if (canSeek && (forceSeek || Math.abs(drift) > PAUSED_SEEK_EPSILON_SECONDS)) {
      setTime(video, target);
    }
  } else if (role !== "leader" && canSeek) {
    if (Math.abs(drift) >= FOLLOWER_HARD_SEEK_THRESHOLD_SECONDS) {
      setTime(video, target);
      video.playbackRate = baseRate;
    } else if (Math.abs(drift) >= FOLLOWER_RATE_ADJUST_THRESHOLD_SECONDS) {
      const correction = clamp(drift * 0.4, -MAX_RATE_CORRECTION, MAX_RATE_CORRECTION);
      video.playbackRate = baseRate * (1 + correction);
    }
  }

  const shouldPlay = Boolean(playing && !beforeCoverage && !afterCoverage);
  if (shouldPlay && video.paused && !video.ended) play(video);
  else if (!shouldPlay) pause(video);
}
