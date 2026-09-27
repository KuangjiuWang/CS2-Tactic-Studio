import { describe, expect, it } from "vitest";
import { povSecondsToTick, tickToPovSeconds } from "./povClock";

describe("shared demo tick across real POV sources", () => {
  it("keeps the same tick when switching between different coverage starts", () => {
    const tick = 3456;
    const firstSeconds = tickToPovSeconds(tick, 1000, 64);
    const secondSeconds = tickToPovSeconds(tick, 1040, 64);
    expect(povSecondsToTick(firstSeconds, 1000, 64)).toBe(tick);
    expect(povSecondsToTick(secondSeconds, 1040, 64)).toBe(tick);
  });

  it("clamps outside a player's genuine recorded coverage", () => {
    expect(tickToPovSeconds(900, 1000, 64)).toBe(0);
    expect(tickToPovSeconds(2000, 1000, 64, 5)).toBe(5);
  });

  it("clamps tick conversion to the POV's declared end coverage", () => {
    expect(tickToPovSeconds(300, 100, 64, 5, 150)).toBeCloseTo(50 / 64);
    expect(povSecondsToTick(9, 100, 64, 150)).toBe(150);
  });

  it("returns a safe value for invalid ticks and tick rates", () => {
    expect(tickToPovSeconds(Number.NaN, 100, 64)).toBe(0);
    expect(tickToPovSeconds(300, 100, 0)).toBe(0);
    expect(povSecondsToTick(3, 100, Number.NaN)).toBe(100);
  });
});
