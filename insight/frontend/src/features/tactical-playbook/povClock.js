export function tickToPovSeconds(tick, coverageStartTick, tickRate, duration = Infinity) {
  return Math.max(0, Math.min(duration, (tick - coverageStartTick) / tickRate));
}

export function povSecondsToTick(seconds, coverageStartTick, tickRate) {
  return coverageStartTick + Math.round(seconds * tickRate);
}
