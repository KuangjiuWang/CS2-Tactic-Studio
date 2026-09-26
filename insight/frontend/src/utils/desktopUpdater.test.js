import { describe, expect, it, vi } from "vitest";
import { createDesktopUpdateCheck, normalizeUpdateMode } from "./desktopUpdater.js";

const bridge = vi.hoisted(() => ({ checkForUpdate: vi.fn(), openExternal: vi.fn(), relaunch: vi.fn() }));
vi.mock("../desktop/desktopBridge.js", () => ({ desktopBridge: bridge, isDesktopApp: true }));

describe("normalizeUpdateMode", () => {
  it("defaults to normal", () => {
    expect(normalizeUpdateMode(undefined)).toBe("normal");
    expect(normalizeUpdateMode("")).toBe("normal");
    expect(normalizeUpdateMode("NORMAL")).toBe("normal");
    expect(normalizeUpdateMode("other")).toBe("normal");
  });

  it("accepts force", () => {
    expect(normalizeUpdateMode("force")).toBe("force");
    expect(normalizeUpdateMode(" Force ")).toBe("force");
  });
});

describe("desktop updater", () => {
  it("opens the GitHub release page for older unsigned releases", async () => {
    bridge.checkForUpdate.mockResolvedValueOnce({
      version: "1.2.0",
      body: "Release notes",
      rawJson: { update_mode: "normal", manual_url: "https://github.com/KuangjiuWang/CS2-Tactic-Studio/releases/latest" },
      close: vi.fn(),
    });
    bridge.openExternal.mockResolvedValueOnce();
    const statuses = [];
    const controller = createDesktopUpdateCheck((state) => statuses.push(state));
    controller.start();
    await vi.waitFor(() => expect(statuses.some((state) => state.status === "available")).toBe(true));
    controller.confirm();
    await vi.waitFor(() => expect(statuses.some((state) => state.status === "manual-opened")).toBe(true));
    expect(bridge.openExternal).toHaveBeenCalledWith("https://github.com/KuangjiuWang/CS2-Tactic-Studio/releases/latest");
    expect(bridge.relaunch).not.toHaveBeenCalled();
  });
});
