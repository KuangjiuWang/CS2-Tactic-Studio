import {
  MAX_SMOKE_TRAJECTORY_SECONDS,
  grenadeTrajectoryTimingIsValid,
} from "./replayGrenadeTrajectory";

function safeLabel(value, fallback = "") {
  const text = String(value ?? "").trim();
  return !text || ["nan", "nat", "none", "null", "undefined"].includes(text.toLowerCase()) ? fallback : text;
}

function grenadeLandingPoint(event) {
  if (Number.isFinite(Number(event?.x)) && Number.isFinite(Number(event?.y))) {
    return { x: Number(event.x), y: Number(event.y) };
  }
  const last = Array.isArray(event?.trajectory) ? event.trajectory.at(-1) : null;
  return Number.isFinite(Number(last?.x)) && Number.isFinite(Number(last?.y))
    ? { x: Number(last.x), y: Number(last.y) }
    : null;
}

function smokeTrajectoryQuality(event, tickRate) {
  const points = Array.isArray(event?.trajectory) ? event.trajectory : [];
  if (points.length < 2) return 0;
  const span = Number(points.at(-1)?.tick || 0) - Number(points[0]?.tick || 0);
  const landing = grenadeLandingPoint(event);
  const endpoint = points.at(-1);
  const endpointDistance = landing && endpoint
    ? Math.hypot(Number(endpoint.x) - landing.x, Number(endpoint.y) - landing.y)
    : 0;
  if (
    !grenadeTrajectoryTimingIsValid(points, event?.tick, tickRate, true)
    || endpointDistance > 256
  ) return -1;
  return points.length
    + Math.min(span, tickRate * MAX_SMOKE_TRAJECTORY_SECONDS) / Math.max(1, tickRate);
}

function grenadeThrowTick(event, tickRate) {
  const trajectoryStart = Array.isArray(event?.trajectory) ? Number(event.trajectory[0]?.tick || 0) : 0;
  const parsed = Number(event?.throw_tick || trajectoryStart || 0);
  if (parsed > 0) return parsed;
  const isSmoke = /烟|smoke/i.test(safeLabel(event?.kind));
  return Math.max(0, Number(event?.tick || 0) - tickRate * (isSmoke ? 2.25 : 1));
}

function grenadeIdentity(actor, kind) {
  return JSON.stringify([actor, kind]);
}

function isDuplicateGrenade(candidate, eventInfo, tickRate, isSmoke) {
  const sameThrow = Math.abs(candidate.throwTick - eventInfo.throwTick) <= tickRate * 0.6;
  const eventWindow = isSmoke ? tickRate * 4 : tickRate * 0.75;
  if (!sameThrow && Math.abs(candidate.tick - eventInfo.tick) > eventWindow) return false;
  if (!sameThrow) {
    if (!candidate.landing || !eventInfo.landing) return false;
    if (Math.hypot(
      eventInfo.landing.x - candidate.landing.x,
      eventInfo.landing.y - candidate.landing.y,
    ) > 96) return false;
  }
  return true;
}

/**
 * Deduplicate and order one round's replay events.
 * The grenade index limits fuzzy duplicate checks to the same actor and type;
 * unrelated events no longer trigger a scan of the entire accumulated list.
 */
export function replayEventsForRound(round, tickRate = 64) {
  const startTick = Number(round?.freeze_end_tick ?? round?.start_tick ?? -Infinity);
  const endTick = Number(round?.record_end_tick ?? round?.end_tick ?? Infinity);
  const seen = new Set();
  const terminalEvents = new Set();
  const merged = [];
  const grenadeIndexes = new Map();
  const grenadeInfoByIndex = [];
  const grenadeQualityByIndex = [];

  for (const event of round?.events || []) {
    const tick = Number(event?.tick || 0);
    if (Number.isFinite(startTick) && tick < startTick) continue;
    if (Number.isFinite(endTick) && tick > endTick) continue;
    if (["explode", "defuse"].includes(event?.type)) {
      if (terminalEvents.has(event.type)) continue;
      terminalEvents.add(event.type);
    }
    const identity = [event?.type, tick, event?.actor, event?.target, event?.kind].join("|");
    if (seen.has(identity)) continue;
    seen.add(identity);

    if (event?.type !== "grenade") {
      merged.push(event);
      continue;
    }

    const actor = safeLabel(event.actor).toLowerCase();
    const kind = safeLabel(event.kind).toLowerCase();
    const key = grenadeIdentity(actor, kind);
    const eventInfo = {
      tick,
      throwTick: grenadeThrowTick(event, tickRate),
      landing: grenadeLandingPoint(event),
    };
    const candidates = grenadeIndexes.get(key) || [];
    let duplicateIndex = -1;
    const isSmoke = /烟|smoke/i.test(kind);
    for (const index of candidates) {
      if (isDuplicateGrenade(grenadeInfoByIndex[index], eventInfo, tickRate, isSmoke)) {
        duplicateIndex = index;
        break;
      }
    }

    if (duplicateIndex < 0) {
      const index = merged.push(event) - 1;
      grenadeInfoByIndex[index] = eventInfo;
      candidates.push(index);
      grenadeIndexes.set(key, candidates);
    } else {
      const candidateQuality = grenadeQualityByIndex[duplicateIndex]
        ?? smokeTrajectoryQuality(merged[duplicateIndex], tickRate);
      grenadeQualityByIndex[duplicateIndex] = candidateQuality;
      const eventQuality = smokeTrajectoryQuality(event, tickRate);
      if (eventQuality > candidateQuality) {
        merged[duplicateIndex] = event;
        grenadeInfoByIndex[duplicateIndex] = eventInfo;
        grenadeQualityByIndex[duplicateIndex] = eventQuality;
      }
    }
  }

  return merged.sort((left, right) => Number(left.tick || 0) - Number(right.tick || 0));
}

export function replayEndTickForRound(round, rounds, workspace, tickRate = 64) {
  const storedEnd = Number(round?.record_end_tick ?? round?.end_tick ?? round?.round_end_tick ?? 0);
  const roundEnd = Number(round?.round_end_tick ?? round?.end_tick ?? 0);
  const roundNumber = Number(round?.round_number || 0);
  if (!(roundEnd > 0)) return storedEnd;

  let nextRoundStart = 0;
  let nextRoundNumber = Infinity;
  for (const candidate of rounds || []) {
    const candidateNumber = Number(candidate?.round_number || 0);
    if (!(candidateNumber > roundNumber) || candidateNumber >= nextRoundNumber) continue;
    nextRoundNumber = candidateNumber;
    nextRoundStart = Number(candidate?.start_tick || 0);
  }

  const demoEndTick = Number(workspace?.demo_end_tick || 0);
  const availableEnd = nextRoundStart > 0 ? nextRoundStart - 1 : demoEndTick;
  if (!(availableEnd > roundEnd)) return storedEnd;
  const desiredEnd = Math.min(
    roundEnd + Math.max(1, Math.round((Number(tickRate) || 64) * 3)),
    availableEnd,
  );
  return Math.min(Math.max(storedEnd, desiredEnd), availableEnd);
}
