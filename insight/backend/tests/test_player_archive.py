from __future__ import annotations

import asyncio

import aiosqlite
import pytest

from app.demo_db import DemoDB
from app.features.player_archive.storage import (
    _analysis_metrics,
    _summarize_analysis,
    get_player_match_workspace,
    get_player_profile,
    initialize_player_archive,
    list_player_profiles,
    set_player_groups,
)


async def _add_demo(db: DemoDB, demo_id: int, *, map_name: str, content_md5: str, players: list[dict]) -> None:
    path = f"C:/demos/match-{demo_id}.dem"
    async with aiosqlite.connect(db.db_path) as conn:
        await conn.execute(
            """
            INSERT INTO demo_files(
                id, path, filename, display_name, map_name, total_rounds, match_date,
                status, added_at, content_md5
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?, ?)
            """,
            (demo_id, path, f"match-{demo_id}.dem", f"Match {demo_id}", map_name, 24,
             f"2026-09-{demo_id:02d}", f"2026-09-{demo_id:02d}", content_md5),
        )
        await conn.commit()
    await db.replace_demo_player_stats(demo_id, path, players)


def test_archive_merges_steam_id_aliases_and_deduplicates_demo_content(tmp_path):
    async def scenario():
        db = DemoDB(tmp_path / "player-archive.db")
        await db.init_db()
        await initialize_player_archive(db.db_path)
        await _add_demo(db, 1, map_name="de_mirage", content_md5="same-content", players=[
            {"name": "OldNick", "steam_id64": "76561198000000001", "kills": 12, "deaths": 7, "assists": 3},
        ])
        await _add_demo(db, 2, map_name="de_mirage", content_md5="same-content", players=[
            {"name": "OldNick", "steam_id64": "76561198000000001", "kills": 12, "deaths": 7, "assists": 3},
        ])
        await _add_demo(db, 3, map_name="de_ancient", content_md5="different-content", players=[
            {"name": "NewNick", "steam_id64": "76561198000000001", "kills": 9, "deaths": 5, "assists": 1},
        ])

        result = await list_player_profiles(db.db_path)

        assert result["total"] == 1
        player = result["players"][0]
        assert player["player_key"] == "steamid:76561198000000001"
        assert player["display_name"] == "NewNick"
        assert player["aliases"] == ["NewNick", "OldNick"]
        assert player["demo_count"] == 2
        assert player["map_count"] == 2
        assert (player["kills"], player["deaths"], player["assists"]) == (21, 12, 4)

        mirage = await list_player_profiles(db.db_path, map_name="de_mirage")
        assert mirage["players"][0]["demo_count"] == 1
        assert mirage["players"][0]["kills"] == 12

    asyncio.run(scenario())


def test_name_only_players_stay_match_local_and_memberships_can_overlap(tmp_path):
    async def scenario():
        db = DemoDB(tmp_path / "player-archive-groups.db")
        await db.init_db()
        await initialize_player_archive(db.db_path)
        for demo_id in (1, 2):
            await _add_demo(db, demo_id, map_name="de_nuke", content_md5=f"content-{demo_id}", players=[
                {"name": "SameNick", "user_id": "17", "kills": demo_id, "deaths": 1},
            ])
        await _add_demo(db, 3, map_name="de_nuke", content_md5="stable-player", players=[
            {"name": "Anchor", "steam_id64": "76561198000000002", "kills": 15, "deaths": 8},
        ])

        all_players = await list_player_profiles(db.db_path)
        assert len(all_players["players"]) == 3
        local_keys = [row["player_key"] for row in all_players["players"] if row["identity_quality"] == "demo_local"]
        assert len(set(local_keys)) == 2

        key = "steamid:76561198000000002"
        assert await set_player_groups(db.db_path, key, ["professional", "squad"])
        assert await set_player_groups(db.db_path, key, ["professional", "squad"])
        professional = await list_player_profiles(db.db_path, group_id="professional")
        squad = await list_player_profiles(db.db_path, group_id="squad")
        assert [row["player_key"] for row in professional["players"]] == [key]
        assert [row["player_key"] for row in squad["players"]] == [key]
        assert professional["group_counts"]["professional"] == 1

        profile = await get_player_profile(db.db_path, key)
        assert profile is not None
        assert profile["groups"] == ["professional", "squad"]
        assert not await set_player_groups(db.db_path, "steamid:76561198000000003", ["squad"])

    asyncio.run(scenario())


def test_group_membership_rejects_unknown_group(tmp_path):
    async def scenario():
        db = DemoDB(tmp_path / "player-archive-invalid-group.db")
        await db.init_db()
        await initialize_player_archive(db.db_path)
        await _add_demo(db, 1, map_name="de_mirage", content_md5="content", players=[
            {"name": "Player", "steam_id64": "76561198000000003", "kills": 1},
        ])

        with pytest.raises(ValueError, match="Unknown player archive group"):
            await set_player_groups(db.db_path, "steamid:76561198000000003", ["unknown"])

    asyncio.run(scenario())


def test_profile_breakdowns_are_split_by_side_and_personal_economy():
    player = {
        "name": "Anchor",
        "display_name": "Anchor",
        "team_key": "a",
        "kills": 1,
        "deaths": 1,
        "assists": 0,
        "headshots": 1,
        "adr": 60,
        "kast": 50,
        "first_kills": 1,
        "first_deaths": 1,
        "clutch_attempts": 2,
        "clutch_wins": 1,
        "round_damage": [
            {"round_number": 1, "damage": 100, "utility_damage": 20},
            {"round_number": 2, "damage": 50, "utility_damage": 0},
        ],
        "economy_rounds": [
            {"round_number": 1, "type": "full"},
            {"round_number": 2, "type": "force"},
        ],
        "weapon_damage_rounds": [
            {"round_number": 1, "weapon": "ak47", "damage": 100},
            {"round_number": 2, "weapon": "m4a1", "damage": 50},
        ],
    }
    workspace = {
        "tick_rate": 64,
        "players": [player, {"name": "Mate", "team_key": "a"}],
        "rounds": [
            {
                "round_number": 1,
                "team_a_side": "T",
                "team_b_side": "CT",
                "winner_team_key": "a",
                "events": [
                    {"type": "kill", "tick": 100, "actor": "Anchor", "target": "Rival", "weapon": "ak47", "headshot": True},
                    {"type": "grenade", "tick": 110, "actor": "Anchor", "kind": "smoke"},
                ],
                "shots": [{"actor": "Anchor", "weapon": "ak47"}],
                "special_events": [{"type": "clutch", "player": "Anchor", "opponents": 2, "won": True}],
            },
            {
                "round_number": 2,
                "team_a_side": "CT",
                "team_b_side": "T",
                "winner_team_key": "b",
                "events": [
                    {"type": "kill", "tick": 200, "actor": "Rival", "target": "Anchor", "weapon": "ak47", "headshot": False},
                    {"type": "grenade", "tick": 210, "actor": "Anchor", "kind": "flash"},
                ],
                "shots": [{"actor": "Anchor", "weapon": "m4a1"}],
                "special_events": [{"type": "clutch", "player": "Anchor", "opponents": 1, "won": False}],
            },
        ],
    }

    metrics = _analysis_metrics(player, 2, workspace)

    assert metrics["side_breakdown"]["T"]["kills"] == 1
    assert metrics["side_breakdown"]["T"]["wins"] == 1
    assert metrics["side_breakdown"]["CT"]["deaths"] == 1
    assert metrics["side_economy_breakdown"]["T"]["full"]["rounds"] == 1
    assert metrics["side_economy_breakdown"]["CT"]["force"]["deaths"] == 1
    assert metrics["side_weapon_breakdown"]["T"]["ak47"] == {
        "kills": 1, "headshots": 1, "damage": 100, "shots_fired": 1,
    }
    assert metrics["side_weapon_breakdown"]["CT"]["m4a1"]["damage"] == 50
    assert metrics["side_utility_breakdown"]["T"]["smoke"]["throws"] == 1
    assert metrics["side_utility_breakdown"]["CT"]["flash"]["throws"] == 1
    assert metrics["side_clutch_breakdown"]["T"]["1v2"] == {"attempts": 1, "wins": 1}

    summary = _summarize_analysis([{"available": True, "metrics": metrics}])
    assert summary["side_weapon_breakdown"]["CT"]["m4a1"]["damage"] == 50
    assert summary["side_economy_breakdown"]["T"]["full"]["wins"] == 1


def test_round_wins_use_consistent_scoreboard_when_a_round_has_no_side_label():
    player = {"name": "Anchor", "display_name": "Anchor", "team_key": "a"}
    workspace = {
        "team_a_score": 2,
        "team_b_score": 0,
        "rounds": [
            {"round_number": 1, "team_a_side": "T", "winner_team_key": "a", "events": []},
            {"round_number": 2, "winner_team_key": "a", "events": []},
        ],
    }

    metrics = _analysis_metrics(player, 2, workspace)

    assert metrics["side_breakdown"]["T"]["wins"] == 1
    assert metrics["rounds_won"] == 2


def test_advanced_metrics_use_saved_analysis_and_workspace_is_match_scoped(tmp_path):
    async def scenario():
        db = DemoDB(tmp_path / "player-archive-analysis.db")
        await db.init_db()
        await initialize_player_archive(db.db_path)
        player_key = "steamid:76561198000000004"
        path = "C:/demos/match-1.dem"
        await _add_demo(db, 1, map_name="de_mirage", content_md5="analyzed", players=[
            {"name": "Anchor", "steam_id64": "76561198000000004", "kills": 18, "deaths": 12, "assists": 4},
        ])
        await _add_demo(db, 2, map_name="de_mirage", content_md5="not-analyzed", players=[
            {"name": "Anchor", "steam_id64": "76561198000000004", "kills": 10, "deaths": 14, "assists": 2},
        ])
        await db.save_result(path, {
            "analysis_workspace": {
                "version": 1,
                "map_name": "de_mirage",
                "tick_rate": 64,
                "team_a_name": "Alpha",
                "team_b_name": "Bravo",
                "map_transform": {"pos_x": 0, "pos_y": 1024, "scale": 5},
                "players": [{
                    "name": "Anchor",
                    "display_name": "Anchor",
                    "player_key": player_key,
                    "team_key": "a",
                    "steam_id64": "76561198000000004",
                    "kills": 18,
                    "deaths": 12,
                    "assists": 4,
                    "adr": 82.5,
                    "kast": 70.0,
                    "headshots": 9,
                    "hs_percent": 50.0,
                    "first_kills": 3,
                    "first_deaths": 1,
                    "trade_kills": 4,
                    "trade_deaths": 2,
                    "clutch_attempts": 2,
                    "clutch_wins": 1,
                    "utility_damage": 120,
                    "utility_damage_per_round": 5.0,
                }],
                "rounds": [{
                    "round_number": 1,
                    "team_a_side": "T",
                    "team_b_side": "CT",
                    "events": [
                        {"type": "kill", "tick": 100, "actor": "Anchor", "target": "Rival", "weapon": "ak47", "headshot": True,
                         "actor_x": 10, "actor_y": 20, "target_x": 13, "target_y": 24},
                        {"type": "kill", "tick": 200, "actor": "Rival", "target": "Anchor", "weapon": "m4a1", "headshot": False,
                         "actor_x": 13, "actor_y": 24, "target_x": 10, "target_y": 20},
                        {"type": "grenade", "tick": "bad-tick", "actor": "Anchor", "kind": "smoke",
                         "trajectory": [{"tick": 50, "x": 0, "y": 0}, {"tick": 64, "x": 3, "y": 4}, {"x": "invalid", "y": 1}]},
                    ],
                    "special_events": [{"type": "clutch", "player": "Anchor", "opponents": 2, "won": False}],
                }] + [{"round_number": round_number, "events": []} for round_number in range(2, 25)],
            },
        })

        profile = await get_player_profile(db.db_path, player_key)
        assert profile is not None
        assert profile["analysis_summary"]["matches_analyzed"] == 1
        assert profile["analysis_summary"]["total_rounds"] == 24
        assert profile["analysis_summary"]["opening_duels"] == 4
        assert profile["analysis_summary"]["opening_duel_win_rate"] == 75.0
        assert profile["analysis_summary"]["clutch_win_rate"] == 50.0
        assert profile["analysis_summary"]["utility_damage_per_round"] == 5.0
        assert sum(1 for match in profile["analysis_matches"] if match["available"]) == 1

        spatial = await get_player_match_workspace(db.db_path, player_key, 1)
        assert spatial is not None
        assert spatial["available"] is True
        assert spatial["player_key"] == player_key
        assert spatial["selected_player_key"] == player_key
        assert spatial["demo_path"] == path
        assert len(spatial["workspace"]["rounds"]) == 24
        evidence = spatial["evidence"]
        assert evidence["duel_win_rate_available"] is False
        assert len(evidence["eliminations"]) == 2
        opening_kill = next(row for row in evidence["eliminations"] if row["type"] == "kill")
        assert opening_kill["is_opening"] is True
        assert opening_kill["side"] == "T"
        assert opening_kill["opponent_position"] == {"x": 13.0, "y": 24.0}
        assert opening_kill["distance"] == 5.0
        assert evidence["opponents"][0]["opponent"] == "Rival"
        assert evidence["opponents"][0]["kills"] == 1
        assert evidence["opponents"][0]["deaths"] == 1
        assert evidence["opponents"][0]["average_elimination_distance"] == 5.0
        assert evidence["opponents"][0]["sides"]["T"]["kills"] == 1
        assert evidence["opponents"][0]["sides"]["T"]["opening_kills"] == 1
        assert evidence["opponents"][0]["sides"]["T"]["average_elimination_distance"] == 5.0
        assert evidence["clutches"] == [{"round_number": 1, "opponents": 2, "won": False, "side": "T"}]
        assert evidence["utilities"][0]["kind"] == "smoke"
        assert evidence["utilities"][0]["path_length"] == 5.0
        assert len(evidence["utilities"][0]["trajectory"]) == 2

        assert await get_player_match_workspace(db.db_path, player_key, 999) is None

    asyncio.run(scenario())
