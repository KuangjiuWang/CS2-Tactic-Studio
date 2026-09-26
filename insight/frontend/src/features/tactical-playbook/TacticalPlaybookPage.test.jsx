import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppShellProvider } from "../../context/AppShellContext";
import TacticalPlaybookPage from "./TacticalViewer";
import API from "../../api/api";

const desktopBridgeMock = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));

vi.mock("../../api/api", () => ({
  API_BASE_URL: "",
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() },
}));

vi.mock("../../desktop/desktopBridge.js", () => ({ desktopBridge: desktopBridgeMock }));

vi.mock("../demo-analysis/replay/Demo2DReplayPreview", () => ({
  default: ({ externalSeekTick, externalPlaying }) => <div data-testid="radar-seek" data-playing={String(externalPlaying)}>{externalSeekTick ?? "none"}</div>,
}));

const players = [
  ...Array.from({ length: 5 }, (_, index) => ({ name: `A${index}`, steam_id64: `a${index}`, team_key: "a" })),
  ...Array.from({ length: 5 }, (_, index) => ({ name: `B${index}`, steam_id64: `b${index}`, team_key: "b" })),
];
const workspace = {
  map_name: "de_mirage", tick_rate: 64, players,
  team_a_name: "Alpha", team_b_name: "Bravo",
  rounds: [
    { round_number: 1, start_tick: 100, freeze_end_tick: 200, round_end_tick: 1000, team_a_side: "T", team_b_side: "CT", team_a_score_before: 0, team_b_score_before: 0, team_a_score_after: 1, team_b_score_after: 0 },
    { round_number: 13, start_tick: 3000, freeze_end_tick: 3200, round_end_tick: 5000, team_a_side: "CT", team_b_side: "T", team_a_score_before: 9, team_b_score_before: 3 },
  ],
};

describe("TacticalPlaybookPage", () => {
  beforeEach(() => {
    localStorage.removeItem("tacticalPovLowResource");
    API.get.mockReset().mockResolvedValue({ data: { folders: [], tactics: [] } });
    API.post.mockReset();
    API.put.mockReset().mockResolvedValue({ data: { ok: true } });
    API.patch.mockReset();
    desktopBridgeMock.showOpenDialog.mockReset();
  });

  const show = () => render(<MemoryRouter><AppShellProvider value={{
    analysisWorkspace: workspace,
    uploadedDemos: [{ path: "C:/demos/match.dem" }],
    currentMatchIndex: 0,
  }}><TacticalPlaybookPage /></AppShellProvider></MemoryRouter>);

  const showSavedTactic = () => render(<MemoryRouter initialEntries={["/tactics/saved-tactic"]}><AppShellProvider value={{
    analysisWorkspace: null,
    uploadedDemos: [],
    currentMatchIndex: 0,
  }}><Routes><Route path="/tactics/:tacticId" element={<TacticalPlaybookPage />} /></Routes></AppShellProvider></MemoryRouter>);

  it("shows background recording failures without selecting a player and allows retry", async () => {
    API.post.mockResolvedValueOnce({ data: { id: "draft", name: "Mirage T", metadata: {} } })
      .mockResolvedValueOnce({ data: { id: "failed", status: "Failed", error: "OBS connection failed", players: [] } });
    show();
    const button = screen.getByRole("button", { name: /生成五个真实 POV|Generate 5 real POVs/ });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("OBS connection failed"));
    expect(button.disabled).toBe(false);
  });

  it("does not submit duplicate five-player batches", async () => {
    let finish;
    API.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    API.post.mockResolvedValueOnce({ data: { id: "batch", status: "Failed", players: [] } });
    show();
    const button = screen.getByRole("button", { name: /生成五个真实 POV|Generate 5 real POVs/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(API.post).toHaveBeenCalledTimes(1);
    finish({ data: { id: "draft", name: "Mirage T", metadata: {} } });
    await waitFor(() => expect(API.post).toHaveBeenCalledTimes(2));
    expect(API.post.mock.calls[1][0]).toBe("/tactical/prepare-povs");
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("automatically saves a completed five-POV batch as map and side", async () => {
    const completedBatch = {
      id: "completed-batch", status: "Complete", round_number: 1, side: "T", demo_path: "C:/demos/match.dem",
      players: players.slice(0, 5).map((player) => ({ steam_id64: player.steam_id64, status: "Complete" })),
    };
    API.post.mockResolvedValueOnce({ data: { id: "saved-tactic", name: "Mirage T", metadata: {} } })
      .mockResolvedValueOnce({ data: completedBatch });
    API.get.mockResolvedValue({ data: { id: "saved-tactic", name: "Mirage T", metadata: { pov_batch_id: completedBatch.id } } });
    show();
    fireEvent.click(screen.getByRole("button", { name: /生成五个真实 POV|Generate 5 real POVs/ }));
    await waitFor(() => expect(API.put).toHaveBeenCalledWith("/tactical/tactics/saved-tactic/recording", { batch_id: completedBatch.id }));
    expect(API.post).toHaveBeenCalledTimes(2);
    expect(API.post.mock.calls[0][0]).toBe("/tactical/tactics");
    expect(API.post.mock.calls[0][1]).toMatchObject({ name: "Mirage T" });
    expect(API.post.mock.calls[1][0]).toBe("/tactical/prepare-povs");
    expect(API.post.mock.calls[1][1]).toMatchObject({ tactic_id: "saved-tactic" });
  });

  it("shows automatic save failure and retries the completed batch", async () => {
    const completedBatch = {
      id: "retry-save-batch", status: "Complete", round_number: 1, side: "T", demo_path: "C:/demos/match.dem",
      players: players.slice(0, 5).map((player) => ({ steam_id64: player.steam_id64, status: "Complete" })),
    };
    API.post.mockResolvedValueOnce({ data: { id: "saved-tactic", name: "Mirage T", metadata: {} } })
      .mockResolvedValueOnce({ data: completedBatch });
    API.put.mockRejectedValueOnce(new Error("temporary database error"))
      .mockResolvedValueOnce({ data: { ok: true } });
    API.get.mockResolvedValue({ data: { id: "saved-tactic", name: "Mirage T", metadata: { pov_batch_id: completedBatch.id } } });
    show();
    fireEvent.click(screen.getByRole("button", { name: /Generate 5 real POVs/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Automatic save failed");
    expect(screen.getByText("temporary database error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("POVs saved automatically"));
    expect(API.put).toHaveBeenCalledTimes(2);
    expect(API.put).toHaveBeenLastCalledWith("/tactical/tactics/saved-tactic/recording", { batch_id: completedBatch.id });
  });

  it("defaults to OBS and sends HLAE only when the alternate renderer is selected", async () => {
    show();
    expect(screen.getByTestId("record-mode-obs").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("record-mode-hlae").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("record-mode-hlae"));
    expect(screen.getByTestId("record-mode-hlae").getAttribute("aria-pressed")).toBe("true");
    API.post.mockResolvedValueOnce({ data: { id: "draft", name: "Mirage T", metadata: {} } })
      .mockResolvedValueOnce({ data: { id: "hlae-batch", status: "Failed", players: [] } });
    fireEvent.click(screen.getByRole("button", { name: /生成五个真实 POV|Generate 5 real POVs/ }));
    await waitFor(() => expect(API.post).toHaveBeenCalled());
    expect(API.post.mock.calls[1][0]).toBe("/tactical/prepare-povs");
    expect(API.post.mock.calls[1][1]).toMatchObject({ recording_mode: "hlae", tactic_id: "draft" });
  });

  it("switches the actual T roster after halftime and submits that round", async () => {
    show();
    expect(screen.getByText("0 : 0")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Round"), { target: { value: "13" } });
    expect(screen.getByTestId("pov-1").textContent).toContain("B0");
    expect(screen.getByText("9 : 3")).toBeTruthy();
    API.post.mockResolvedValueOnce({ data: { id: "draft", name: "Mirage T", metadata: {} } })
      .mockResolvedValueOnce({ data: { id: "batch", status: "Complete", players: [] } });
    fireEvent.click(screen.getByRole("button", { name: /生成五个真实 POV|Generate 5 real POVs/ }));
    await waitFor(() => expect(API.post).toHaveBeenCalled());
    expect(API.post.mock.calls[1][1]).toMatchObject({ round_number: 13, side: "T", tactic_id: "draft" });
  });

  it("retains the demo tick when switching POV to 2D", async () => {
    API.get.mockImplementation((url) => Promise.resolve({ data: url.includes("playbooks") ? { folders: [], tactics: [] } : {} }));
    show();
    API.post.mockResolvedValueOnce({ data: { id: "saved", name: "Mirage T", metadata: {} } })
      .mockResolvedValueOnce({ data: {
      id: "batch", status: "Complete", round_number: 1, side: "T", demo_path: "C:/demos/match.dem", players: players.slice(0, 5).map((player, index) => ({
        player_name: player.name, steam_id64: player.steam_id64,
        coverage_start_tick: 100 + index * 10, coverage_end_tick: 1000,
        status: "Complete", proxy_url: `/proxy${index}`, stream_url: `/video${index}`,
      })),
    } });
    API.get.mockResolvedValue({ data: { id: "saved", name: "Mirage T", metadata: { pov_batch_id: "batch" } } });
    fireEvent.click(screen.getByRole("button", { name: /生成五个真实 POV|Generate 5 real POVs/ }));
    await waitFor(() => expect(screen.getByTestId("pov-1").textContent).toContain("Complete"));
    fireEvent.click(screen.getByTestId("pov-1"));
    const video = document.querySelector("main video");
    Object.defineProperty(video, "currentTime", { configurable: true, value: 5, writable: true });
    fireEvent.timeUpdate(video);
    expect(screen.getByText(/Tick 420/)).toBeTruthy();
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    fireEvent.play(video);
    expect(screen.getByTestId("radar-seek").getAttribute("data-playing")).toBe("true");
    fireEvent.click(screen.getByTestId("pov-2"));
    const secondVideo = document.querySelector("main video");
    fireEvent.loadedMetadata(secondVideo);
    expect(secondVideo.currentTime).toBeCloseTo((420 - 110) / 64);
    expect(screen.getByText(/Tick 420/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("pov-2d"));
    expect(screen.getByText(/Tick 420/)).toBeTruthy();
    expect(screen.getByTestId("radar-seek").textContent).toBe("420");
    playSpy.mockRestore();
  });

  it("shows five synchronized preview streams in the one-click review grid", async () => {
    const completedBatch = {
      id: "grid-batch", status: "Complete", round_number: 1, side: "T", demo_path: "C:/demos/match.dem", players: players.slice(0, 5).map((player, index) => ({
        player_name: player.name, steam_id64: player.steam_id64,
        coverage_start_tick: 100 + index * 10, coverage_end_tick: 1000,
        status: "Complete", proxy_url: `/proxy${index}`, stream_url: `/video${index}`,
      })),
    };
    API.post.mockResolvedValueOnce({ data: { id: "grid-tactic", name: "Mirage T", metadata: {} } })
      .mockResolvedValueOnce({ data: completedBatch });
    API.get.mockResolvedValue({ data: { id: "grid-tactic", name: "Mirage T", metadata: { pov_batch_id: completedBatch.id } } });
    show();
    fireEvent.click(screen.getByRole("button", { name: /Generate 5 real POVs/ }));
    await screen.findByTestId("pov-preview-1");
    fireEvent.click(screen.getByTestId("toggle-multiview"));
    expect(await screen.findByTestId("tactical-multiview")).toBeTruthy();
    expect(screen.getAllByTestId(/^multiview-pov-/)).toHaveLength(5);
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const leader = screen.getByTestId("multiview-pov-1");
    Object.defineProperty(leader, "currentTime", { configurable: true, value: 3, writable: true });
    fireEvent.timeUpdate(leader);
    expect(screen.getByText(/Tick 292/)).toBeTruthy();
    expect(pauseSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Single POV" }));
    expect(screen.queryByTestId("tactical-multiview")).toBeNull();
    expect(pauseSpy).toHaveBeenCalledTimes(5);
    expect(screen.getByTestId("pov-1")).toBeTruthy();
    pauseSpy.mockRestore();
  });

  it("ignores a POV batch response after the selected round changes", async () => {
    let resolveBatch;
    const oldBatch = {
      id: "old-round-batch", status: "Complete", round_number: 1, side: "T", demo_path: "C:/demos/match.dem",
      players: players.slice(0, 5).map((player) => ({ steam_id64: player.steam_id64, status: "Complete" })),
    };
    const tactic = {
      id: "saved-tactic", name: "Mirage T", map_name: "de_mirage", side: "T", round_number: 1,
      source_demo_path: "C:/demos/match.dem", source_demo_available: true,
      metadata: { analysis_workspace: workspace, pov_batch_id: oldBatch.id }, steps: [],
    };
    API.get.mockImplementation((url) => url.includes("prepare-povs")
      ? new Promise((resolve) => { resolveBatch = resolve; })
      : Promise.resolve({ data: tactic }));
    showSavedTactic();
    await screen.findByLabelText("Round");
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/tactical/prepare-povs/old-round-batch"));
    fireEvent.change(screen.getByLabelText("Round"), { target: { value: "13" } });
    resolveBatch({ data: oldBatch });
    await waitFor(() => expect(screen.getByLabelText("Round").value).toBe("13"));
    expect(API.post).not.toHaveBeenCalled();
    expect(screen.queryByTestId("multiview-pov-1")).toBeNull();
  });

  it("jumps between nearby match events and tactical steps", async () => {
    const reviewWorkspace = structuredClone(workspace);
    reviewWorkspace.rounds[0].events = [
      { type: "kill", tick: 350, actor: "A0" },
      { type: "plant", tick: 650, actor: "A1" },
    ];
    API.get.mockResolvedValue({ data: {
      id: "saved-tactic", name: "Mirage T", map_name: "de_mirage", side: "T", round_number: 1,
      source_demo_path: "C:/demos/match.dem", source_demo_available: true,
      metadata: { analysis_workspace: reviewWorkspace },
      steps: [
        { id: "step-1", step_number: 1, tick: 500, title: "Setup", note: "" },
        { id: "step-2", step_number: 2, tick: 800, title: "Execute", note: "" },
      ],
    } });
    showSavedTactic();
    await screen.findByText(/Tick 200/);
    fireEvent.click(screen.getByRole("button", { name: "Next event" }));
    expect(screen.getByText(/Tick 350/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next event" }));
    expect(screen.getByText(/Tick 650/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous event" }));
    expect(screen.getByText(/Tick 350/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(screen.getByText(/Tick 500/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(screen.getByText(/Tick 800/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous step" }));
    expect(screen.getByText(/Tick 500/)).toBeTruthy();
  });

  it("relinks an older tactic after explicit confirmation when its original file is gone", async () => {
    const tactic = {
      id: "saved-tactic", name: "Mirage T", map_name: "de_mirage", side: "T", round_number: 1,
      source_demo_path: "C:/old/match.dem", source_demo_available: false,
      metadata: { analysis_workspace: workspace }, steps: [],
    };
    API.get.mockResolvedValue({ data: tactic });
    desktopBridgeMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["D:/new/match.dem"] });
    const mismatch = new Error("legacy source cannot be verified");
    mismatch.response = { data: { detail: { code: "DEMO_UNVERIFIED", message: mismatch.message } } };
    API.patch.mockRejectedValueOnce(mismatch).mockResolvedValueOnce({ data: {
      ...tactic, source_demo_path: "D:/new/match.dem", source_demo_available: true,
    } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    showSavedTactic();

    fireEvent.click(await screen.findByTestId("relink-demo"));
    await waitFor(() => expect(API.patch).toHaveBeenCalledTimes(2));
    expect(API.patch.mock.calls[1]).toEqual([
      "/tactical/tactics/saved-tactic/source-demo",
      { demo_path: "D:/new/match.dem", allow_unverified: true },
    ]);
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByText(/The source demo is unavailable/)).toBeNull();
    confirm.mockRestore();
  });
});
