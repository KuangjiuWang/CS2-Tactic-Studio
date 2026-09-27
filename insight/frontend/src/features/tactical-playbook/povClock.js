export function tickToPovSeconds(tick, coverageStartTick, tickRate, duration = Infinity, coverageEndTick = Infinity) {
  const start = Number(coverageStartTick);
  const rate = Number(tickRate);
  const requestedTick = Number(tick);
  if (!Number.isFinite(start) || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(requestedTick)) return 0;

  const end = Number(coverageEndTick);
  const boundedTick = Number.isFinite(end) ? Math.min(requestedTick, Math.max(start, end)) : requestedTick;
  const requestedSeconds = Math.max(0, (boundedTick - start) / rate);
  const maxDuration = Number.isFinite(Number(duration)) && Number(duration) >= 0
    ? Number(duration)
    : Infinity;
  return Math.min(requestedSeconds, maxDuration);
}

export function povSecondsToTick(seconds, coverageStartTick, tickRate, coverageEndTick = Infinity) {
  const start = Number(coverageStartTick);
  const rate = Number(tickRate);
  const elapsed = Number(seconds);
  if (!Number.isFinite(start) || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(elapsed)) {
    return Number.isFinite(start) ? start : 0;
  }

  const mappedTick = start + Math.round(Math.max(0, elapsed) * rate);
  const end = Number(coverageEndTick);
  return Number.isFinite(end) ? Math.min(mappedTick, Math.max(start, end)) : mappedTick;
}
