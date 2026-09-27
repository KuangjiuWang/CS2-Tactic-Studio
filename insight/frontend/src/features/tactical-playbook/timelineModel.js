export function orderTacticSteps(steps = []) {
  return [...steps]
    .filter((step) => Number.isFinite(Number(step?.tick)))
    .sort((left, right) => Number(left.tick) - Number(right.tick));
}

export function activeTacticStep(steps = [], tick) {
  const playhead = Number(tick);
  let active = null;
  for (const step of steps) {
    if (!Number.isFinite(Number(step.tick)) || Number(step.tick) > playhead) break;
    active = step;
  }
  return active;
}

export function addDeathTimelineEvents(events = []) {
  return events.flatMap((event) => {
    if (event?.type !== "kill" || !event.target) return [event];
    return [event, {
      ...event,
      type: "death",
      actor: event.target,
      target: event.actor,
      sourceType: event.type,
    }];
  });
}
