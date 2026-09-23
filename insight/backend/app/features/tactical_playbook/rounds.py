"""Select a real five-player side and derive OBS recording jobs from demo facts."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from ...recording.models import (
    DemoContext,
    RecordingOptions,
    RecordingRequestDTO,
    RequestType,
    RoundInfo,
    SourceType,
    TargetPlayer,
)
from ...recording.plan_builder import build_plan


class TacticalRoundError(ValueError):
    pass


def _tick(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def select_round(workspace: dict, round_number: int, side: str) -> tuple[dict, str, list[dict]]:
    """Use the *round's* side mapping, never a fixed first-half roster."""
    side = side.upper()
    if side not in {"T", "CT"}:
        raise TacticalRoundError("side must be T or CT")
    round_row = next(
        (row for row in workspace.get("rounds", []) if _tick(row.get("round_number")) == round_number),
        None,
    )
    if not round_row:
        raise TacticalRoundError(f"round {round_number} is not in the parsed demo")
    keys = [key for key in ("a", "b") if round_row.get(f"team_{key}_side") == side]
    if len(keys) != 1:
        raise TacticalRoundError(f"round {round_number} has no unambiguous {side} side")
    team_key = keys[0]
    players = [p for p in workspace.get("players", []) if p.get("team_key") == team_key]
    steam_ids = [str(p.get("steam_id64") or "") for p in players]
    if len(players) != 5 or any(not sid for sid in steam_ids) or len(set(steam_ids)) != 5:
        raise TacticalRoundError("selected side must contain five distinct SteamID64 players")
    return round_row, team_key, players


def build_five_pov_jobs(demo_path: str, workspace: dict, round_number: int, side: str) -> list[dict]:
    """Build five jobs for the upstream real CS2/OBS recording queue.

    A dead player's real in-eye recording ends at death + 2 seconds.  The
    returned coverage is therefore per-player; it is never advertised as a
    full-round video if the engine cannot provide one.
    """
    path = Path(demo_path).resolve(strict=True)
    if not path.is_file() or path.suffix.lower() != ".dem":
        raise TacticalRoundError("demo_path must point to a real .dem file")
    tick_rate = float(workspace.get("tick_rate") or 0)
    if tick_rate <= 0:
        raise TacticalRoundError("parsed demo has no valid tick rate")
    row, team_key, players = select_round(workspace, round_number, side)
    rounds = workspace.get("rounds") or []
    next_row = next((r for r in rounds if _tick(r.get("round_number")) > round_number), None)
    first_tick = _tick(workspace.get("match_start_tick"))
    end_tick = _tick(workspace.get("demo_end_tick"))
    if end_tick <= _tick(row.get("freeze_end_tick")):
        raise TacticalRoundError("demo EOF must be after the selected round's freeze phase")
    final_round = max(_tick(r.get("round_number")) for r in rounds)
    demo = DemoContext(
        demo_path=str(path), demo_filename=path.name,
        map_name=str(workspace.get("map_name") or ""), tick_rate=tick_rate,
        first_tick=first_tick, demo_end_tick=end_tick,
        final_round=final_round,
        final_round_start_tick=_tick(rounds[-1].get("start_tick")),
        final_round_end_tick=_tick(rounds[-1].get("round_end_tick")),
        all_players=[{"name": p.get("name"), "steamid64": p.get("steam_id64")} for p in workspace.get("players", [])],
    )
    jobs = []
    for player in players:
        name = str(player.get("name") or "")
        death_tick = next(
            (_tick(e.get("tick")) for e in row.get("events", [])
             if e.get("type") == "kill" and str(e.get("target") or "").casefold() == name.casefold()),
            None,
        )
        request = RecordingRequestDTO(
            request_id=f"tactic-{uuid4().hex}",
            request_type=RequestType.round_compilation,
            source_type=SourceType.round,
            demo=demo,
            target_player=TargetPlayer(name=name, steamid64=str(player["steam_id64"])),
            rounds=[RoundInfo(
                round=round_number,
                round_start_tick=_tick(row.get("start_tick")),
                freeze_start_tick=_tick(row.get("start_tick")),
                freeze_end_tick=_tick(row.get("freeze_end_tick")),
                round_end_tick=_tick(row.get("round_end_tick")),
                next_round_start_tick=_tick(next_row.get("start_tick")) if next_row else None,
                target_death_tick=death_tick,
            )],
            options=RecordingOptions(round_freeze_preroll_sec=2.0, round_death_post_sec=2.0),
        )
        plan = build_plan(request)
        if len(plan.segments) != 1:
            raise TacticalRoundError(f"recording plan for {name} has no usable segment: {plan.warnings}")
        segment = plan.segments[0]
        jobs.append({
            "player_id": str(player.get("player_key") or player["steam_id64"]),
            "player_name": name,
            "steam_id64": player["steam_id64"],
            "team_key": team_key,
            "side": side.upper(),
            "coverage_start_tick": segment.start_tick,
            "coverage_end_tick": segment.end_tick,
            "death_tick": death_tick,
            "request": request.model_dump(mode="json"),
        })
    return jobs
