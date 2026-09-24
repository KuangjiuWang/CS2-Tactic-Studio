from pathlib import Path

import pytest

from app.features.tactical_playbook.rounds import (
    TacticalRoundError,
    build_five_pov_jobs,
    select_round,
)


def workspace():
    return {
        "tick_rate": 64,
        "match_start_tick": 1,
        "demo_end_tick": 9000,
        "map_name": "de_mirage",
        "players": [
            {"name": f"A{i}", "steam_id64": str(76561197960265728 + i), "team_key": "a"}
            for i in range(5)
        ] + [
            {"name": f"B{i}", "steam_id64": str(76561197960265828 + i), "team_key": "b"}
            for i in range(5)
        ],
        "rounds": [
            {"round_number": 1, "start_tick": 100, "freeze_end_tick": 1100,
             "round_end_tick": 4000, "end_tick": 4499,
             "team_a_side": "T", "team_b_side": "CT",
             "events": [{"type": "kill", "target": "A0", "tick": 2400}]},
            {"round_number": 13, "start_tick": 5000, "freeze_end_tick": 6000,
             "round_end_tick": 8000, "end_tick": 8199,
             "team_a_side": "CT", "team_b_side": "T", "events": []},
        ],
    }


def test_halftime_side_uses_round_mapping():
    _, key, players = select_round(workspace(), 13, "T")
    assert key == "b"
    assert [p["name"] for p in players] == [f"B{i}" for i in range(5)]


def test_five_jobs_expose_real_death_coverage(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.recording.normalizer.read_demo_end_tick", lambda _path: 9000)
    demo = tmp_path / "match.dem"
    demo.touch()
    jobs = build_five_pov_jobs(str(demo), workspace(), 1, "T")
    assert len(jobs) == 5
    assert jobs[0]["death_tick"] == 2400
    assert jobs[0]["coverage_end_tick"] == 2400 + 128
    assert jobs[1]["coverage_end_tick"] > jobs[0]["coverage_end_tick"]
    assert all(job["request"]["target_player"]["steamid64"] for job in jobs)


def test_out_of_order_next_round_boundary_cannot_truncate_round(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.recording.normalizer.read_demo_end_tick", lambda _path: 9000)
    demo = tmp_path / "match.dem"
    demo.touch()
    parsed = workspace()
    parsed["rounds"][1]["start_tick"] = 3500  # earlier than round 1's end at 4000
    parsed["rounds"][0]["events"] = []  # all five players survive
    jobs = build_five_pov_jobs(str(demo), parsed, 1, "T")
    assert len(jobs) == 5
    assert all(job["coverage_end_tick"] >= 4000 for job in jobs)


def test_missing_player_identity_fails_closed():
    data = workspace()
    data["players"][0]["steam_id64"] = None
    with pytest.raises(TacticalRoundError, match="five distinct"):
        select_round(data, 1, "T")
