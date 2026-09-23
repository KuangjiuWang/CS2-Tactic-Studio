import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShellProvider } from "../../context/AppShellContext";
import TacticalPlaybookPage from "./TacticalPlaybookPage";
import API from "../../api/api";

vi.mock("../../api/api", () => ({
  API_BASE_URL: "",
  default: { get: vi.fn(), post: vi.fn() },
}));

vi.mock("../demo-analysis/replay/Demo2DReplayPreview", () => ({
  default: ({ externalSeekTick }) => <div data-testid="radar-seek">{externalSeekTick ?? "none"}</div>,
}));

const players = [
  ...Array.from({ length: 5 }, (_, index) => ({ name: `A${index}`, steam_id64: `a${index}`, team_key: "a" })),
  ...Array.from({ length: 5 }, (_, index) => ({ name: `B${index}`, steam_id64: `b${index}`, team_key: "b" })),
];
const workspace = {
  map_name: "de_mirage", tick_rate: 64, players,
  team_a_name: "Alpha", team_b_name: "Bravo",
  rounds: [
    { round_number: 1, start_tick: 100, freeze_end_tick: 200, round_end_tick: 1000, team_a_side: "T", team_b_side: "CT" },
    { round_number: 13, start_tick: 3000, freeze_end_tick: 3200, round_end_tick: 5000, team_a_side: "CT", team_b_side: "T" },
  ],
};

describe("TacticalPlaybookPage", () => {
  beforeEach(() => {
    API.get.mockReset().mockResolvedValue({ data: { folders: [], tactics: [] } });
    API.post.mockReset();
  });

  const show = () => render(<AppShellProvider value={{
    analysisWorkspace: workspace,
    uploadedDemos: [{ path: "C:/demos/match.dem" }],
    currentMatchIndex: 0,
  }}><TacticalPlaybookPage /></AppShellProvider>);

  it("switches the actual T roster after halftime and submits that round", async () => {
    show();
    fireEvent.change(screen.getByLabelText("Round"), { target: { value: "13" } });
    expect(screen.getByTestId("pov-1").textContent).toContain("B0");
    API.post.mockResolvedValueOnce({ data: { id: "batch", status: "Complete", players: [] } });
    fireEvent.click(screen.getByRole("button", { name: /生成五个真实 POV|Generate 5 real POVs/ }));
    await waitFor(() => expect(API.post).toHaveBeenCalled());
    expect(API.post.mock.calls[0][1]).toMatchObject({ round_number: 13, side: "T" });
  });

  it("retains the demo tick when switching POV to 2D", async () => {
    API.get.mockImplementation((url) => Promise.resolve({ data: url.includes("playbooks") ? { folders: [], tactics: [] } : {} }));
    show();
    API.post.mockResolvedValueOnce({ data: {
      id: "batch", status: "Complete", players: players.slice(0, 5).map((player, index) => ({
        player_name: player.name, steam_id64: player.steam_id64,
        coverage_start_tick: 100 + index * 10, coverage_end_tick: 1000,
        status: "Complete", proxy_url: `/proxy${index}`, stream_url: `/video${index}`,
      })),
    } });
    fireEvent.click(screen.getByRole("button", { name: /生成五个真实 POV|Generate 5 real POVs/ }));
    await waitFor(() => expect(screen.getByTestId("pov-1").textContent).toContain("Complete"));
    fireEvent.click(screen.getByTestId("pov-1"));
    const video = document.querySelector("main video");
    Object.defineProperty(video, "currentTime", { configurable: true, value: 5, writable: true });
    fireEvent.timeUpdate(video);
    expect(screen.getByText(/Tick 420/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("pov-2"));
    const secondVideo = document.querySelector("main video");
    fireEvent.loadedMetadata(secondVideo);
    expect(secondVideo.currentTime).toBeCloseTo((420 - 110) / 64);
    expect(screen.getByText(/Tick 420/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("pov-2d"));
    expect(screen.getByText(/Tick 420/)).toBeTruthy();
    expect(screen.getByTestId("radar-seek").textContent).toBe("420");
  });
});
