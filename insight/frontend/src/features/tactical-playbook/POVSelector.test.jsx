import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import POVSelector from "./POVSelector";

vi.mock("../../api/api", () => ({ API_BASE_URL: "", default: {} }));

describe("POVSelector previews", () => {
  it("plays low-resolution proxy previews at the shared tick and speed", () => {
    const players = Array.from({ length: 5 }, (_, index) => ({
      name: `Player ${index + 1}`,
      steam_id64: String(index + 1),
    }));
    const batch = {
      players: players.map((player) => ({
        steam_id64: player.steam_id64,
        status: "Complete",
        proxy_url: `/proxy/${player.steam_id64}`,
        coverage_start_tick: 300,
    })),
    };
    localStorage.setItem("tacticalPovLowResource", "false");
    const playedVideos = [];
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function playPreview() {
      playedVideos.push(this);
      return Promise.resolve();
    });
    render(<POVSelector players={players} batch={batch} selected="0" selectView={() => {}} tick={320} tickRate={64} playing speed={1.5} />);

    const previews = players.map((_, index) => screen.getByTestId(`pov-preview-${index + 1}`));
    previews.forEach((video, index) => expect(video.src).toContain(`/proxy/${players[index].steam_id64}`));
    expect(play).toHaveBeenCalledTimes(5);
    for (const video of previews) {
      fireEvent.loadedMetadata(video);
      expect(video.currentTime).toBeCloseTo(20 / 64);
      expect(video.playbackRate).toBe(1.5);
      expect(video.muted).toBe(true);
    }
    expect(playedVideos.slice(0, 5)).toEqual(previews);
    play.mockRestore();
  });

  it("plays only the selected proxy in low-resource mode", () => {
    localStorage.removeItem("tacticalPovLowResource");
    const players = Array.from({ length: 5 }, (_, index) => ({ name: `Player ${index + 1}`, steam_id64: String(index + 1) }));
    const batch = { players: players.map((player) => ({
      steam_id64: player.steam_id64, status: "Complete", proxy_url: `/proxy/${player.steam_id64}`, coverage_start_tick: 300,
    })) };
    const playedVideos = [];
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function playPreview() {
      playedVideos.push(this);
      return Promise.resolve();
    });
    render(<POVSelector players={players} batch={batch} selected="2" selectView={() => {}} tick={320} tickRate={64} playing speed={1} />);

    expect(play).toHaveBeenCalledTimes(1);
    expect(playedVideos).toEqual([screen.getByTestId("pov-preview-3")]);
    [0, 1, 3, 4].forEach((index) => fireEvent.loadedMetadata(screen.getByTestId(`pov-preview-${index + 1}`)));
    [0, 1, 3, 4].forEach((index) => expect(screen.getByTestId(`pov-preview-${index + 1}`).currentTime).toBeCloseTo(20 / 64));
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Save preview resources").checked).toBe(true);
    play.mockRestore();
  });
});
