export function shouldSyncExternalPlayhead(currentTick, targetTick, tickRate, toleranceSeconds = 0.5) {
  const target = Number(targetTick);
  if (!Number.isFinite(target)) return false;

  const current = Number(currentTick);
  if (!Number.isFinite(current)) return true;

  const rate = Number(tickRate);
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 64;
  const tolerance = Number(toleranceSeconds);
  const safeTolerance = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0.5;
  return Math.abs(target - current) > safeRate * safeTolerance;
}
