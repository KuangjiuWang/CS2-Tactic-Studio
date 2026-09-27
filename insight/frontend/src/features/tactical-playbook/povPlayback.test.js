import { describe, expect, it, vi } from "vitest";
import { syncPovVideo } from "./povPlayback";

function makeVideo({ currentTime = 0, duration = 10, paused = true } = {}) {
  return {
    currentTime,
    duration,
    readyState: 2,
    paused,
    ended: false,
    muted: false,
    playbackRate: 1,
    play: vi.fn(function play() {
      this.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(function pause() {
      this.paused = true;
    }),
  };
}

const pov = {
  status: "Complete",
  coverage_start_tick: 100,
  coverage_end_tick: 740,
};

describe("shared POV playback synchronization", () => {
  it("lets the leader drive the clock without seeking its own playhead", () => {
    const video = makeVideo({ currentTime: 2, paused: false });
    syncPovVideo(video, pov, {
      tick: 100 + 4 * 64,
      tickRate: 64,
      playing: true,
      speed: 1.5,
      role: "leader",
    });

    expect(video.currentTime).toBe(2);
    expect(video.playbackRate).toBe(1.5);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("nudges a follower smoothly when the drift is small", () => {
    const video = makeVideo({ currentTime: 3.9, paused: false });
    syncPovVideo(video, pov, {
      tick: 100 + 4 * 64,
      tickRate: 64,
      playing: true,
      speed: 1,
    });

    expect(video.currentTime).toBe(3.9);
    expect(video.playbackRate).toBeCloseTo(1.04);
  });

  it("seeks a follower after a large drift and restores the requested speed", () => {
    const video = makeVideo({ currentTime: 2, paused: false });
    syncPovVideo(video, pov, {
      tick: 100 + 4 * 64,
      tickRate: 64,
      playing: true,
      speed: 1.5,
    });

    expect(video.currentTime).toBe(4);
    expect(video.playbackRate).toBe(1.5);
  });

  it("parks a POV before and after its recorded coverage", () => {
    const before = makeVideo({ currentTime: 2, paused: false });
    syncPovVideo(before, pov, { tick: 90, tickRate: 64, playing: true });
    expect(before.currentTime).toBe(0);
    expect(before.pause).toHaveBeenCalledOnce();

    const after = makeVideo({ currentTime: 8, paused: false });
    syncPovVideo(after, pov, { tick: 800, tickRate: 64, playing: true });
    expect(after.currentTime).toBe(10);
    expect(after.pause).toHaveBeenCalledOnce();
  });

  it("pauses previews when the page is hidden or the POV is incomplete", () => {
    const hidden = makeVideo({ paused: false });
    syncPovVideo(hidden, pov, { tick: 200, tickRate: 64, playing: true, pageVisible: false });
    expect(hidden.pause).toHaveBeenCalledOnce();

    const incomplete = makeVideo({ paused: false });
    syncPovVideo(incomplete, { ...pov, status: "Encoding" }, { tick: 200, tickRate: 64, playing: true });
    expect(incomplete.pause).toHaveBeenCalledOnce();
  });
});
