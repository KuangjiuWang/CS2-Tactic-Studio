import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import API from "../../api/api";
import PlayerArchivePage from "./PlayerArchivePage.jsx";

vi.mock("../../api/api", () => ({ default: { get: vi.fn() } }));

const playerKey = "steamid:76561198000000001";
const directory = {
  players: [{
    player_key: playerKey,
    steam_id64: "76561198000000001",
    identity_quality: "steamid64",
    display_name: "Anchor",
    groups: [],
    demo_count: 2,
    map_count: 2,
    kills: 36,
    deaths: 26,
    kd: 1.38,
  }],
  groups: ["professional", "amateur", "squad"],
  group_counts: { all: 1, professional: 0, amateur: 0, squad: 0 },
  maps: ["de_mirage", "de_ancient"],
  total: 1,
};

const rivalKey = "steamid:76561198000000002";

function comparisonProfile(key, displayName, mirageMetrics) {
  return {
    player_key: key,
    display_name: displayName,
    matches: [
      { demo_id: 11, map_name: "de_mirage" },
      { demo_id: 12, map_name: "de_ancient" },
    ],
    analysis_matches: [
      { demo_id: 11, map_name: "de_mirage", available: true, metrics: mirageMetrics },
      { demo_id: 12, map_name: "de_ancient", available: true, metrics: {
        total_rounds: 20, kills: 99, deaths: 1, assists: 99, damage: 9999,
        adr: 499.95, kast: 100, headshots: 99, first_kills: 99,
        first_deaths: 0, trade_kills: 99, trade_deaths: 0,
        clutch_attempts: 99, clutch_wins: 99, utility_damage: 999,
      } },
    ],
  };
}

function ProfileRoute() {
  const { playerKey: routeKey } = useParams();
  const location = useLocation();
  return <div role="region" aria-label="player-profile-route">{routeKey}|{location.search}</div>;
}

function renderDirectory() {
  return render(<MemoryRouter initialEntries={["/players"]}>
    <Routes>
      <Route path="/players" element={<PlayerArchivePage />} />
      <Route path="/players/:playerKey" element={<ProfileRoute />} />
    </Routes>
  </MemoryRouter>);
}

describe("PlayerArchivePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    API.get.mockResolvedValue({ data: directory });
  });

  test("opens a player as a dedicated route and carries the selected map filter", async () => {
    renderDirectory();
    const mapFilter = await screen.findByRole("combobox", { name: "All Maps" });
    await screen.findByRole("option", { name: "de_mirage" });
    fireEvent.change(mapFilter, { target: { value: "de_mirage" } });
    const playerButton = await screen.findByRole("button", { name: /Anchor.*SteamID64/ });
    fireEvent.click(playerButton);

    const route = await screen.findByRole("region", { name: "player-profile-route" });
    expect(route.textContent).toBe(`${playerKey}|?map=de_mirage`);
    expect(API.get).toHaveBeenCalledWith("/player-archive", expect.objectContaining({
      params: expect.objectContaining({ map_name: "de_mirage" }),
    }));
  });

  test("keeps the searchable player directory and comparison controls available", async () => {
    renderDirectory();
    expect(await screen.findByText("Professional")).toBeTruthy();
    expect(screen.getByText("Amateur High-Level")).toBeTruthy();
    expect(screen.getByText("Team Members")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search name or SteamID" })).toBeTruthy();
    await screen.findByRole("button", { name: /Anchor.*SteamID64/ });
    expect(screen.getByRole("button", { name: "Add to comparison: Anchor" })).toBeTruthy();
  });

  test("compares all requested metrics on the same selected map with sample counts", async () => {
    const rival = { ...directory.players[0], player_key: rivalKey, steam_id64: "76561198000000002", display_name: "Rival" };
    const scopedDirectory = { ...directory, players: [directory.players[0], rival], total: 2 };
    const profiles = {
      [playerKey]: comparisonProfile(playerKey, "Anchor", {
        total_rounds: 10, kills: 10, deaths: 5, assists: 4, damage: 850, adr: 85,
        kast: 80, headshots: 6, first_kills: 2, first_deaths: 1,
        trade_kills: 3, trade_deaths: 2, clutch_attempts: 2, clutch_wins: 1,
        utility_damage: 90, rating_approx: 1.2,
      }),
      [rivalKey]: comparisonProfile(rivalKey, "Rival", {
        total_rounds: 10, kills: 7, deaths: 5, assists: 2, damage: 700, adr: 70,
        kast: 60, headshots: 3, first_kills: 1, first_deaths: 3,
        trade_kills: 2, trade_deaths: 4, clutch_attempts: 1, clutch_wins: 0,
        utility_damage: 30, rating_approx: 0.9,
      }),
    };
    API.get.mockImplementation((url) => {
      if (url === "/player-archive") return Promise.resolve({ data: scopedDirectory });
      const key = decodeURIComponent(String(url).split("/").at(-1));
      return Promise.resolve({ data: profiles[key] });
    });

    renderDirectory();
    fireEvent.change(await screen.findByRole("combobox", { name: "All Maps" }), { target: { value: "de_mirage" } });
    fireEvent.click(await screen.findByRole("button", { name: "Add to comparison: Anchor" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to comparison: Rival" }));

    const comparison = await screen.findByRole("region", { name: "Player Comparison" });
    expect(comparison.textContent).toContain("Map scope: de_mirage");
    expect(comparison.textContent).toContain("Analyzed 1/1 matches");
    expect(comparison.textContent).toContain("10 / 4 / 5");
    expect(comparison.textContent).toContain("85.0 (10/10 rounds)");
    expect(comparison.textContent).toContain("80.0% (8/10)");
    expect(comparison.textContent).toContain("60.0% (6/10)");
    expect(comparison.textContent).toContain("First kills 2 · first deaths 1 · 3 duels");
    expect(comparison.textContent).toContain("Won 1 / 2 attempts");
    expect(comparison.textContent).toContain("3 / 2");
    expect(comparison.textContent).toContain("9.0 (90 / 10 rounds)");
    expect(comparison.textContent).not.toContain("99 / 1 / 99");
  });

  test("shows a retry action when comparison profile requests fail", async () => {
    API.get.mockImplementation((url) => url === "/player-archive"
      ? Promise.resolve({ data: directory })
      : Promise.reject(new Error("offline")));

    renderDirectory();
    fireEvent.click(await screen.findByRole("button", { name: "Add to comparison: Anchor" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load comparison profiles");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    API.get.mockImplementation((url) => url === "/player-archive"
      ? Promise.resolve({ data: directory })
      : Promise.resolve({ data: comparisonProfile(playerKey, "Anchor", { total_rounds: 10, kills: 10, deaths: 5 }) }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("article")).toBeTruthy();
  });
});
