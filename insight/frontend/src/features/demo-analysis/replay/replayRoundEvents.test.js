import { describe, expect, test } from "vitest";
import { replayEventsForRound } from "./replayRoundEvents";

describe("replayEventsForRound", () => {
  test("keeps event filtering, terminal-event handling, and tick ordering", () => {
    const events = replayEventsForRound({
      freeze_end_tick: 10,
      record_end_tick: 40,
      events: [
        { type: "kill", tick: 30, actor: "A", target: "B" },
        { type: "kill", tick: 5, actor: "A", target: "B" },
        { type: "kill", tick: 30, actor: "A", target: "B" },
        { type: "defuse", tick: 35, actor: "A" },
        { type: "defuse", tick: 39, actor: "B" },
        { type: "explode", tick: 50 },
      ],
    });

    expect(events).toEqual([
      { type: "kill", tick: 30, actor: "A", target: "B" },
      { type: "defuse", tick: 35, actor: "A" },
    ]);
  });

  test("only fuzzy-matches grenades with the same normalized actor and kind", () => {
    const events = replayEventsForRound({
      events: [
        { type: "grenade", tick: 100, throw_tick: 80, actor: "Alpha", kind: "smoke", x: 0, y: 0 },
        { type: "grenade", tick: 110, throw_tick: 80, actor: "alpha", kind: "SMOKE", x: 500, y: 500 },
        { type: "grenade", tick: 112, throw_tick: 80, actor: "Bravo", kind: "smoke", x: 0, y: 0 },
        { type: "grenade", tick: 113, throw_tick: 80, actor: "Alpha", kind: "flash", x: 0, y: 0 },
      ],
    });

    // Same throw is a duplicate even when the landing coordinates differ.
    expect(events.map((event) => [event.actor, event.kind])).toEqual([
      ["Alpha", "smoke"],
      ["Bravo", "smoke"],
      ["Alpha", "flash"],
    ]);
  });

  test("uses the existing time-and-landing fallback when throw ticks differ", () => {
    const nearbyLanding = replayEventsForRound({
      events: [
        { type: "grenade", tick: 100, throw_tick: 10, actor: "Alpha", kind: "smoke", x: 100, y: 100 },
        { type: "grenade", tick: 110, throw_tick: 500, actor: "Alpha", kind: "smoke", x: 160, y: 160 },
      ],
    });
    const distantLanding = replayEventsForRound({
      events: [
        { type: "grenade", tick: 100, throw_tick: 10, actor: "Alpha", kind: "smoke", x: 100, y: 100 },
        { type: "grenade", tick: 110, throw_tick: 500, actor: "Alpha", kind: "smoke", x: 300, y: 100 },
      ],
    });

    expect(nearbyLanding).toHaveLength(1);
    expect(distantLanding).toHaveLength(2);
  });

  test("keeps distinct smoke and fire throws when their effect windows overlap", () => {
    const smoke = replayEventsForRound({
      events: [
        { type: "grenade", tick: 1_800, throw_tick: 1_000, actor: "Alpha", kind: "smoke", x: 100, y: 100 },
        { type: "grenade", tick: 2_500, throw_tick: 1_700, actor: "Alpha", kind: "smoke", x: 100, y: 100 },
      ],
    });
    const fire = replayEventsForRound({
      events: [
        { type: "grenade", tick: 1_800, throw_tick: 1_000, actor: "Alpha", kind: "molotov", x: 100, y: 100 },
        { type: "grenade", tick: 2_200, throw_tick: 1_400, actor: "Alpha", kind: "molotov", x: 100, y: 100 },
      ],
    });

    expect(smoke).toHaveLength(2);
    expect(fire).toHaveLength(2);
  });

  test("prefers a valid, richer smoke trajectory when duplicate reports merge", () => {
    const basic = {
      type: "grenade",
      tick: 200,
      throw_tick: 100,
      actor: "Alpha",
      kind: "smoke",
      x: 10,
      y: 10,
      trajectory: [
        { tick: 100, x: 0, y: 0 },
        { tick: 200, x: 10, y: 10 },
      ],
    };
    const richer = {
      ...basic,
      tick: 201,
      trajectory: [
        { tick: 100, x: 0, y: 0 },
        { tick: 150, x: 5, y: 5 },
        { tick: 201, x: 10, y: 10 },
      ],
    };

    expect(replayEventsForRound({ events: [basic, richer] })).toEqual([richer]);
  });
});
