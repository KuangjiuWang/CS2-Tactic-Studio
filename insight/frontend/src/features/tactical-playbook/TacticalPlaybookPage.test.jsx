import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppShellProvider } from "../../context/AppShellContext";
import TacticalPlaybookPage from "./TacticalViewer";
import TacticalPlaybookLibrary from "./TacticalPlaybookPage";
import API from "../../api/api";

const desktopBridgeMock = vi.hoisted(() => ({ showOpenDialog: vi.fn(), saveTacticPackage: vi.fn(), showItemInFolder: vi.fn() }));

vi.mock("../../api/api", () => ({
  API_BASE_URL: "",
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("../../desktop/desktopBridge.js", () => ({ desktopBridge: desktopBridgeMock }));

vi.mock("../demo-analysis/replay/Demo2DReplayPreview", () => ({
  default: ({ externalSeekTick, externalPlaying, annotations = [] }) => <div data-testid="radar-seek" data-annotations={annotations.map((item) => item.id).join(",")} data-playing={String(externalPlaying)}>{externalSeekTick ?? "none"}</div>,
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
    API.delete.mockReset();
    desktopBridgeMock.showOpenDialog.mockReset();
    desktopBridgeMock.saveTacticPackage.mockReset();
    desktopBridgeMock.showItemInFolder.mockReset();
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

  const showLibrary = () => render(<MemoryRouter><AppShellProvider value={{
    analysisWorkspace: null, uploadedDemos: [], currentMatchIndex: 0,
  }}><TacticalPlaybookLibrary /></AppShellProvider></MemoryRouter>);

  it("expands the POV to the app window and provides an exit control", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Fullscreen|全屏/ }));
    expect(document.querySelector(".tactical-stage.is-pov-expanded")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pov-fullscreen-exit"));
    expect(document.querySelector(".tactical-stage.is-pov-expanded")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Fullscreen|全屏/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".tactical-stage.is-pov-expanded")).toBeNull();
  });

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
    expect(screen.getByTestId("record-mode-advanced-obs").getAttribute("aria-pressed")).toBe("false");
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

  it("sends advanced Demo OBS as a separate five-POV recording mode", async () => {
    show();
    const advancedMode = screen.getByTestId("record-mode-advanced-obs");
    expect(advancedMode.getAttribute("aria-label")).toMatch(/高级 Demo OBS 回放|Advanced Demo playback recorded by OBS|Advanced Demo OBS playback/);
    fireEvent.click(advancedMode);
    expect(advancedMode.getAttribute("aria-pressed")).toBe("true");
    API.post.mockResolvedValueOnce({ data: { id: "draft", name: "Mirage T", metadata: {} } })
      .mockResolvedValueOnce({ data: { id: "advanced-batch", status: "Failed", players: [] } });
    fireEvent.click(screen.getByRole("button", { name: /生成五个真实 POV|Generate 5 real POVs/ }));
    await waitFor(() => expect(API.post).toHaveBeenCalledTimes(2));
    expect(API.post.mock.calls[1][0]).toBe("/tactical/prepare-povs");
    expect(API.post.mock.calls[1][1]).toMatchObject({ recording_mode: "advanced_obs", tactic_id: "draft" });
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

  it("moves the multiview clock to another POV when the focused clip ends early", async () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const completedBatch = {
      id: "grid-short-clip-batch", status: "Complete", round_number: 1, side: "T", demo_path: "C:/demos/match.dem",
      players: players.slice(0, 5).map((player, index) => ({
        player_name: player.name, steam_id64: player.steam_id64,
        coverage_start_tick: 100, coverage_end_tick: index === 0 ? 300 : 1000,
        status: "Complete", proxy_url: `/proxy${index}`, stream_url: `/video${index}`,
      })),
    };
    API.post.mockResolvedValueOnce({ data: { id: "grid-short-tactic", name: "Mirage T", metadata: {} } })
      .mockResolvedValueOnce({ data: completedBatch });
    API.get.mockResolvedValue({ data: { id: "grid-short-tactic", name: "Mirage T", metadata: { pov_batch_id: completedBatch.id } } });
    show();
    fireEvent.click(screen.getByRole("button", { name: /Generate 5 real POVs/ }));
    await screen.findByTestId("pov-preview-1");
    fireEvent.click(screen.getByTestId("toggle-multiview"));

    const shortLeader = await screen.findByTestId("multiview-pov-1");
    Object.defineProperty(shortLeader, "currentTime", { configurable: true, value: 4, writable: true });
    fireEvent.timeUpdate(shortLeader);
    expect(screen.getByText(/Tick 300/)).toBeTruthy();

    const replacementLeader = screen.getByTestId("multiview-pov-2");
    Object.defineProperty(replacementLeader, "currentTime", { configurable: true, value: 5, writable: true });
    fireEvent.timeUpdate(replacementLeader);
    expect(screen.getByText(/Tick 420/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Single POV" }));
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
      { type: "kill", tick: 350, actor: "A0", target: "B0" },
      { type: "grenade", tick: 700, actor: "A1", kind: "hegrenade" },
      { type: "grenade", tick: 750, actor: "A2", kind: "decoy" },
      { type: "plant", tick: 650, actor: "A1" },
    ];
    API.get.mockResolvedValue({ data: {
      id: "saved-tactic", name: "Mirage T", map_name: "de_mirage", side: "T", round_number: 1,
      source_demo_path: "C:/demos/match.dem", source_demo_available: true,
      metadata: { analysis_workspace: reviewWorkspace },
      steps: [
        { id: "step-1", step_number: 1, tick: 500, title: "Setup", note: "Hold mid", annotations: [{ id: "step-1-note", type: "note", text: "Hold mid" }] },
        { id: "step-2", step_number: 2, tick: 800, title: "Execute", note: "Go now", annotations: [{ id: "step-2-arrow", type: "arrow" }] },
      ],
    } });
    showSavedTactic();
    await screen.findByText(/Tick 200/);
    expect(screen.queryByTestId("current-tactic-step")).toBeNull();
    expect(screen.getByTestId("timeline-event-death-350-combat")).toBeTruthy();
    expect(screen.getByTestId("timeline-event-grenade-700-utility")).toBeTruthy();
    expect(screen.getByTestId("timeline-event-grenade-750-utility")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next event" }));
    expect(screen.getByText(/Tick 350/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next event" }));
    expect(screen.getByText(/Tick 650/)).toBeTruthy();
    expect(screen.getByTestId("current-tactic-step").textContent).toContain("Setup");
    expect(screen.getByTestId("radar-seek").getAttribute("data-annotations")).toBe("step-1-note");
    fireEvent.click(screen.getByRole("button", { name: "Previous event" }));
    expect(screen.getByText(/Tick 350/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(screen.getByText(/Tick 500/)).toBeTruthy();
    expect(screen.getByTestId("radar-seek").getAttribute("data-annotations")).toBe("step-1-note");
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(screen.getByText(/Tick 800/)).toBeTruthy();
    expect(screen.getByTestId("current-tactic-step").textContent).toContain("Execute");
    expect(screen.getByTestId("radar-seek").getAttribute("data-annotations")).toBe("step-2-arrow");
    fireEvent.click(screen.getByRole("button", { name: "Previous step" }));
    expect(screen.getByText(/Tick 500/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("timeline-event-plant-650-bomb"));
    expect(screen.getByText(/Tick 650/)).toBeTruthy();
    expect(screen.getByTestId("current-tactic-step").textContent).toContain("Setup");
    fireEvent.click(screen.getByTestId("timeline-step-marker-step-2"));
    expect(screen.getByText(/Tick 800/)).toBeTruthy();
    expect(screen.getByTestId("current-tactic-step").textContent).toContain("Execute");
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

  it("saves a .cstactic export through the desktop dialog and shows where it went", async () => {
    API.get.mockResolvedValue({ data: { folders: [], tactics: [{
      id: "share-me", name: "Mirage T", map_name: "de_mirage", side: "T", round_number: 3,
      metadata: {}, pov_status: "ready", pov_count: 5,
    }] } });
    desktopBridgeMock.saveTacticPackage.mockResolvedValue("C:/exports/Mirage T.cstactic");
    showLibrary();
    fireEvent.click(await screen.findByRole("button", { name: /Actions Mirage T|操作 Mirage T/ }));
    fireEvent.click(screen.getByRole("button", { name: /Export Tactic|导出战术/ }));
    await waitFor(() => expect(desktopBridgeMock.saveTacticPackage).toHaveBeenCalledWith("share-me", "Mirage T.cstactic", expect.any(String)));
    expect(await screen.findByText(/C:\/exports\/Mirage T\.cstactic/)).toBeTruthy();
    expect(API.get).toHaveBeenCalledTimes(1);
  });

  it("shows packaging failures when sharing instead of silently doing nothing", async () => {
    API.get.mockResolvedValue({ data: { folders: [], tactics: [{ id: "share-me", name: "Mirage T", map_name: "de_mirage", side: "T", round_number: 3, metadata: {} }] } });
    desktopBridgeMock.saveTacticPackage.mockRejectedValue("player 2 full-quality POV video is missing");
    showLibrary();
    fireEvent.click(await screen.findByRole("button", { name: /Actions Mirage T|操作 Mirage T/ }));
    fireEvent.click(screen.getByRole("button", { name: /Share|分享/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("player 2 full-quality POV video is missing");
  });

  it("lets the user opt into deleting only the tactic's local POV batch", async () => {
    API.get.mockResolvedValue({ data: { folders: [], tactics: [{
      id: "delete-me", name: "Mirage T", map_name: "de_mirage", side: "T", round_number: 3, metadata: {},
    }] } });
    API.delete.mockResolvedValue({ data: { ok: true, pov_media: { status: "deleted", files: 12 } } });
    showLibrary();
    fireEvent.click(await screen.findByRole("button", { name: /Actions Mirage T|操作 Mirage T/ }));
    fireEvent.click(screen.getByRole("button", { name: /Delete|删除/ }));
    const cleanupOption = screen.getByLabelText(/full-quality POV videos|五人 POV 原视频/);
    expect(cleanupOption.checked).toBe(false);
    fireEvent.click(cleanupOption);
    fireEvent.click(screen.getByRole("button", { name: /Confirm|确认/ }));
    await waitFor(() => expect(API.delete).toHaveBeenCalledWith(
      "/tactical/tactics/delete-me", { data: { delete_pov_videos: true } },
    ));
    expect((await screen.findByRole("status")).textContent).toMatch(/12 local POV files|12 个本地 POV 文件/);
  });

  it("uploads a .cstactic package as multipart data while retaining JSON import", async () => {
    showLibrary();
    const picker = document.querySelector('input[type="file"]');
    const packageFile = new File(["archive bytes"], "team-tactic.cstactic", { type: "application/vnd.cs2-tactic+zip" });
    fireEvent.change(picker, { target: { files: [packageFile] } });
    await waitFor(() => expect(API.post).toHaveBeenCalledWith(
      "/tactical/import-package", expect.any(FormData),
    ));
    const body = API.post.mock.calls[0][1];
    expect(body.get("package").name).toBe("team-tactic.cstactic");

    API.post.mockClear();
    const legacy = new File([JSON.stringify({ format: "cs2-tactic-v1", tactic: {} })], "legacy.json", { type: "application/json" });
    Object.defineProperty(legacy, "text", { value: async () => JSON.stringify({ format: "cs2-tactic-v1", tactic: {} }) });
    fireEvent.change(picker, { target: { files: [legacy] } });
    await waitFor(() => expect(API.post).toHaveBeenCalledWith(
      "/tactical/import", { format: "cs2-tactic-v1", tactic: {} },
    ));
  });
});
