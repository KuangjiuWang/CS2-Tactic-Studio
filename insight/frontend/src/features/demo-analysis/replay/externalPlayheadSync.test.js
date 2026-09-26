import { describe, expect, it } from "vitest";
import { shouldSyncExternalPlayhead } from "./externalPlayheadSync";

describe("external replay playhead sync", () => {
  it("ignores normal clock drift but corrects large drift", () => {
    expect(shouldSyncExternalPlayhead(1000, 1020, 64)).toBe(false);
    expect(shouldSyncExternalPlayhead(1000, 1033, 64)).toBe(true);
  });

  it("uses the supplied tick rate and aligns when the current tick is unknown", () => {
    expect(shouldSyncExternalPlayhead(1000, 1011, 32)).toBe(false);
    expect(shouldSyncExternalPlayhead(Number.NaN, 1000, 64)).toBe(true);
    expect(shouldSyncExternalPlayhead(1000, Number.NaN, 64)).toBe(false);
  });
});
