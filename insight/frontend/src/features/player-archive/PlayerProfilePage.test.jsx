import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import API from "../../api/api";
import PlayerProfilePage, { aggregateMatches } from "./PlayerProfilePage.jsx";

vi.mock("../../api/api", () => ({ default: { get: vi.fn(), put: vi.fn() } }));
vi.mock("../demo-analysis/replay/Demo2DReplayPreview.jsx", () => ({
  default: ({ initialRound, externalSeekTick, externalSeekRequestId }) => <div data-testid="profile-replay" data-round={initialRound ?? ""} data-tick={externalSeekTick ?? ""} data-request={externalSeekRequestId ?? 0} />,
}));
vi.mock("../demo-analysis/replay/DemoHeatmapView.jsx", () => ({ default: () => <div data-testid="profile-heatmap" /> }));

const playerKey = "steamid:76561198000000001";
const match = {
  demo_id: 1,
  title: "Mirage Scrim",
  filename: "private-demo.dem",
  map_name: "de_mirage",
  match_date: "2026-09-01",
  total_rounds: 10,
  kills: 12,
  deaths: 8,
  assists: 3,
  available: true,
  metrics: {
    kills: 12, deaths: 8, assists: 3, damage: 800, adr: 80, kast: 70,
    headshots: 6, first_kills: 4, first_deaths: 2, trade_kills: 2, trade_deaths: 1,
    clutch_attempts: 2, clutch_wins: 1, utility_damage: 60, total_rounds: 10,
    rounds_won: 6, rating_approx: 1.1, match_result: "W", team_score: 13, opponent_score: 7,
    one_kill_rounds: 2, two_kill_rounds: 2, three_kill_rounds: 1,
    four_kill_rounds: 0, five_kill_rounds: 0,
    side_breakdown: {
      T: { rounds: 6, wins: 4, kills: 8, deaths: 3, assists: 2, headshots: 4, damage: 500, damage_samples: 6, utility_damage: 35, first_kills: 3, first_deaths: 1, trade_kills: 2, trade_deaths: 0, clutch_attempts: 1, clutch_wins: 1, kast_rounds: 5, survived_rounds: 4 },
      CT: { rounds: 4, wins: 2, kills: 4, deaths: 5, assists: 1, headshots: 2, damage: 300, damage_samples: 4, utility_damage: 25, first_kills: 1, first_deaths: 1, trade_kills: 0, trade_deaths: 1, clutch_attempts: 1, clutch_wins: 0, kast_rounds: 2, survived_rounds: 1 },
    },
    weapon_breakdown: { ak47: { kills: 2, headshots: 1, damage: 180, shots_fired: 15 } },
    side_weapon_breakdown: {
      T: { ak47: { kills: 2, headshots: 1, damage: 150, shots_fired: 9 } },
      CT: { m4a1: { kills: 1, headshots: 1, damage: 120, shots_fired: 6 } },
    },
    economy_breakdown: { full: { rounds: 6, wins: 4, kills: 8, deaths: 3, damage: 500, damage_samples: 6 } },
    side_economy_breakdown: {
      T: { full: { rounds: 4, wins: 3, kills: 6, deaths: 2, damage: 330, damage_samples: 4 } },
      CT: { pistol: { rounds: 2, wins: 1, kills: 2, deaths: 1, damage: 140, damage_samples: 2 } },
    },
    utility_breakdown: { smoke: { throws: 3 } },
    side_utility_breakdown: { T: { smoke: { throws: 2 } }, CT: { flash: { throws: 1 } } },
    clutch_breakdown: { "1v2": { attempts: 2, wins: 1 } },
    side_clutch_breakdown: { T: { "1v2": { attempts: 1, wins: 1 } }, CT: { "1v1": { attempts: 1, wins: 0 } } },
  },
};

const profile = {
  player_key: playerKey,
  steam_id64: "76561198000000001",
  identity_quality: "steamid64",
  display_name: "Anchor",
  aliases: ["Anchor", "Old Anchor"],
  groups: [],
  maps: [{ map_name: "de_mirage", demo_count: 1 }],
  matches: [match],
  analysis_matches: [match],
  analysis_summary: { economy_sources: ["player_loadout"] },
};

function renderProfile() {
  return render(<MemoryRouter initialEntries={[`/players/${encodeURIComponent(playerKey)}`]}>
    <Routes><Route path="/players/:playerKey" element={<PlayerProfilePage />} /><Route path="/players" element={<DirectoryReturn />} /></Routes>
  </MemoryRouter>);
}

function DirectoryReturn() {
  const location = useLocation();
  return <div data-testid="directory-return">{location.search}</div>;
}

function renderProfileWithSearch(search) {
  return render(<MemoryRouter initialEntries={[`/players/${encodeURIComponent(playerKey)}${search}`]}>
    <Routes><Route path="/players/:playerKey" element={<PlayerProfilePage />} /><Route path="/players" element={<DirectoryReturn />} /></Routes>
  </MemoryRouter>);
}

describe("PlayerProfilePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    API.get.mockResolvedValue({ data: profile });
    API.put.mockResolvedValue({ data: { groups: [] } });
  });

  test("aggregates side-specific rates and multi-kill rounds with round weighting", () => {
    const stats = aggregateMatches([match], "T");
    expect(stats.rounds).toBe(6);
    expect(stats.kills).toBe(8);
    expect(stats.deaths).toBe(3);
    expect(stats.kd).toBeCloseTo(8 / 3);
    expect(stats.adr).toBeCloseTo(500 / 6);
    expect(stats.kast).toBeCloseTo(5 / 6 * 100);
    expect(stats.openingRate).toBe(75);
    expect(stats.clutchRate).toBe(100);
    expect(stats.utilityDamage).toBe(35);
    expect(stats.utilityDamagePerRound).toBeCloseTo(35 / 6);
    expect(stats.oneKillRounds).toBe(2);
    expect(stats.multiKillRounds).toBe(3);
    expect(stats.ratingApprox).toBeGreaterThan(0);
  });

  test("uses exact all-side KAST rounds instead of reconstructing a decimal count from a rounded rate", () => {
    const legacyRate = {
      available: true,
      metrics: {
        total_rounds: 16,
        kast: 81.2,
        side_breakdown: { T: { kast_rounds: 9 }, CT: { kast_rounds: 4 } },
      },
    };
    const stats = aggregateMatches([legacyRate]);
    expect(stats.kastRounds).toBe(13);
    expect(stats.kast).toBeCloseTo(81.25);
  });

  test("uses saved ADR when opening an older analysis without damage totals", () => {
    const legacy = { available: true, metrics: { total_rounds: 20, kills: 10, deaths: 8, assists: 1, adr: 75 } };
    expect(aggregateMatches([legacy]).adr).toBe(75);
  });

  test("renders a dedicated scouting page with extended performance sections", async () => {
    renderProfile();
    expect(await screen.findByRole("heading", { name: "Anchor" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Maps & Sides" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Weapons & Economy" }));
    expect(await screen.findByText("ak47")).toBeTruthy();
    expect(screen.getByText("Classified by the player's per-round equipment")).toBeTruthy();
    expect(screen.getByText("smoke")).toBeTruthy();
  });

  test("shows opponent records and exact saved coordinates, then seeks the replay", async () => {
    API.get.mockImplementation((url) => Promise.resolve({ data: url.includes("/matches/") ? {
      available: true,
      demo_id: 1,
      player_key: playerKey,
      workspace: { players: [], rounds: [] },
      evidence: {
        eliminations: [{ type: "kill", round_number: 8, tick: 1400, opponent: "Rival", weapon: "ak47", is_opening: true, side: "T", distance: 5, player_position: { x: 10, y: 20 }, opponent_position: { x: 13, y: 24 } }],
        clutches: [],
        utilities: [],
        opponents: [{ opponent: "Rival", kills: 1, deaths: 0, opening_kills: 1, opening_deaths: 0, average_elimination_distance: 5, distance_samples: 1, sides: { T: { kills: 1, deaths: 0, opening_kills: 1, opening_deaths: 0, average_elimination_distance: 5, distance_samples: 1 } } }],
      },
    } : profile }));
    renderProfile();
    await screen.findByRole("heading", { name: "Anchor" });
    expect(API.get.mock.calls.some(([url]) => String(url).includes("/matches/"))).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Spatial Review" }));

    expect(await screen.findByText("Opponent summaries")).toBeTruthy();
    expect(API.get.mock.calls.some(([url]) => String(url).includes("/matches/1/analysis"))).toBe(true);
    const openingEvent = screen.getByRole("button", { name: /Opening elimination.*Rival/ });
    expect(openingEvent.textContent).toContain("Player: 10, 20");
    expect(openingEvent.textContent).toContain("Opponent: 13, 24");
    fireEvent.click(screen.getByRole("button", { name: "Movement Heatmap" }));
    expect(await screen.findByTestId("profile-heatmap")).toBeTruthy();
    fireEvent.click(openingEvent);
    const replay = await screen.findByTestId("profile-replay");
    expect(replay.getAttribute("data-round")).toBe("8");
    expect(replay.getAttribute("data-tick")).toBe("1400");
    expect(replay.getAttribute("data-request")).toBe("1");
    fireEvent.click(openingEvent);
    expect(screen.getByTestId("profile-replay").getAttribute("data-request")).toBe("2");
  });

  test("exports a versioned, filtered scouting report without local paths or raw workspaces", async () => {
    const unsafeProfile = JSON.parse(JSON.stringify(profile));
    unsafeProfile.matches[0].demo_path = "C:\\private\\match.dem";
    unsafeProfile.matches[0].video_path = "C:\\private\\pov.mp4";
    unsafeProfile.analysis_matches[0].metrics.private_demo_path = "C:\\private\\match.dem";
    unsafeProfile.analysis_matches[0].metrics.raw_workspace = { path: "C:\\private\\workspace.json" };
    API.get.mockResolvedValue({ data: unsafeProfile });
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    const createObjectURL = vi.fn().mockReturnValue("blob:scouting-report");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revokeObjectURL });
    HTMLAnchorElement.prototype.click = vi.fn();

    try {
      renderProfile();
      await screen.findByRole("heading", { name: "Anchor" });
      fireEvent.click(screen.getByRole("button", { name: "Export local player data as JSON" }));

      const blob = createObjectURL.mock.calls[0][0];
      const text = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsText(blob);
      });
      const payload = JSON.parse(text);
      expect(payload.version).toBe(3);
      expect(payload.summary.kills).toBe(12);
      expect(payload.matches[0].stats).toMatchObject({ kills: 12, deaths: 8, assists: 3 });
      expect(payload.matches[0]).not.toHaveProperty("analysis");
      expect(JSON.stringify(payload)).not.toContain("C:\\\\private");
      expect(JSON.stringify(payload)).not.toContain("raw_workspace");
      expect(JSON.stringify(payload)).not.toContain("private-demo.dem");
    } finally {
      if (originalCreate) Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: originalCreate });
      else delete URL.createObjectURL;
      if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: originalRevoke });
      else delete URL.revokeObjectURL;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
    }
  });

  test("preserves directory group, search, map, and comparison filters on return", async () => {
    const comparedPlayer = "steamid:76561198000000002";
    renderProfileWithSearch(`?group=professional&q=donk&map=de_ancient&compare=${encodeURIComponent(comparedPlayer)}`);
    await screen.findByRole("heading", { name: "Anchor" });
    fireEvent.click(screen.getByRole("link", { name: "Back to players" }));

    const returned = await screen.findByTestId("directory-return");
    const params = new URLSearchParams(returned.textContent);
    expect(params.get("group")).toBe("professional");
    expect(params.get("q")).toBe("donk");
    expect(params.get("map")).toBe("de_ancient");
    expect(params.getAll("compare")).toEqual([comparedPlayer]);
  });
});
