import { describe, expect, it } from "vitest";
import { activeTacticStep, addDeathTimelineEvents, orderTacticSteps } from "./timelineModel";

describe("tactical timeline model", () => {
  const steps = [
    { id: "second", tick: 800 },
    { id: "first", tick: 500 },
    { id: "invalid", tick: "bad" },
  ];

  it("orders valid steps and returns the step active at the playhead", () => {
    const ordered = orderTacticSteps(steps);

    expect(ordered.map((step) => step.id)).toEqual(["first", "second"]);
    expect(activeTacticStep(ordered, 499)).toBeNull();
    expect(activeTacticStep(ordered, 500)?.id).toBe("first");
    expect(activeTacticStep(ordered, 799)?.id).toBe("first");
    expect(activeTacticStep(ordered, 800)?.id).toBe("second");
  });

  it("adds a death marker for the eliminated player without changing the kill event", () => {
    const kill = { type: "kill", tick: 350, actor: "A0", target: "B0" };

    expect(addDeathTimelineEvents([kill, { type: "plant", tick: 500 }])).toEqual([
      kill,
      { ...kill, type: "death", actor: "B0", target: "A0", sourceType: "kill" },
      { type: "plant", tick: 500 },
    ]);
  });
});
