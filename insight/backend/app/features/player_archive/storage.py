"""Local player identity index and category memberships.

The archive is deliberately derived from the existing Demo Library roster
table. A SteamID/account ID is the cross-demo identity; name-only roster rows
stay scoped to their source demo so unrelated players are never merged.
"""

from __future__ import annotations

import aiosqlite
import json
import math
from pathlib import Path
from typing import Any


PLAYER_GROUPS = ("professional", "amateur", "squad")


def _identity_sql(alias: str = "ps") -> str:
    steam = f"NULLIF(TRIM(COALESCE({alias}.steam_id64, '')), '')"
    account = f"NULLIF(TRIM(COALESCE({alias}.account_id, '')), '')"
    user_id = f"NULLIF(TRIM(COALESCE({alias}.user_id, '')), '')"
    name = f"LOWER(TRIM(COALESCE({alias}.normalized_name, {alias}.player_name, 'unknown')))"
    return (
        f"CASE WHEN {steam} IS NOT NULL THEN 'steamid:' || {steam} "
        f"WHEN {account} IS NOT NULL THEN 'account:' || {account} "
        f"WHEN {user_id} IS NOT NULL THEN 'demo:' || {alias}.demo_id || ':user:' || {user_id} "
        f"ELSE 'demo:' || {alias}.demo_id || ':name:' || {name} END"
    )


async def initialize_player_archive(db_path: Path) -> None:
    """Create the archive's additive schema in the existing local SQLite DB."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(db_path) as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS player_archive_memberships (
                player_key TEXT NOT NULL,
                group_id TEXT NOT NULL CHECK(group_id IN ('professional', 'amateur', 'squad')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(player_key, group_id)
            )
            """
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_player_archive_memberships_group "
            "ON player_archive_memberships(group_id, player_key)"
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS player_archive_settings (
                player_key TEXT PRIMARY KEY,
                imported INTEGER NOT NULL DEFAULT 0 CHECK(imported IN (0, 1)),
                blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0, 1)),
                pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        # A category assignment was an explicit user action in the old archive,
        # so preserve those profiles as imported during the behavior change.
        await conn.execute(
            """
            INSERT OR IGNORE INTO player_archive_settings(player_key, imported)
            SELECT DISTINCT player_key, 1 FROM player_archive_memberships
            """
        )
        await conn.commit()


def _row_key(row: dict[str, Any]) -> str:
    steam_id = str(row.get("steam_id64") or "").strip()
    if steam_id:
        return f"steamid:{steam_id}"
    account_id = str(row.get("account_id") or "").strip()
    if account_id:
        return f"account:{account_id}"
    demo_id = int(row.get("demo_id") or 0)
    user_id = str(row.get("user_id") or "").strip()
    if user_id:
        return f"demo:{demo_id}:user:{user_id}"
    name = str(row.get("normalized_name") or row.get("player_name") or "unknown").strip().casefold()
    return f"demo:{demo_id}:name:{name or 'unknown'}"


def _deduplicate_matches(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep one copy of a player's row for identical demo content."""
    best: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        player_key = str(row.get("player_key") or _row_key(row))
        content_md5 = str(row.get("content_md5") or "").strip().lower()
        match_key = content_md5 or f"demo-id:{row.get('demo_id')}"
        key = (player_key, match_key)
        previous = best.get(key)
        row_rank = (0 if row.get("status") == "done" else 1, -int(row.get("demo_id") or 0))
        previous_rank = (
            0 if previous and previous.get("status") == "done" else 1,
            -int(previous.get("demo_id") or 0) if previous else 0,
        )
        if previous is None or row_rank < previous_rank:
            best[key] = row
    return list(best.values())


def _aggregate(rows: list[dict[str, Any]], memberships: dict[str, list[str]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(str(row["player_key"]), []).append(row)

    players: list[dict[str, Any]] = []
    for player_key, matches in groups.items():
        ordered = sorted(
            matches,
            key=lambda row: (str(row.get("match_date") or row.get("added_at") or ""), int(row.get("demo_id") or 0)),
            reverse=True,
        )
        names = list(dict.fromkeys(
            str(row.get("player_name") or "").strip()
            for row in ordered
            if str(row.get("player_name") or "").strip()
        ))
        steam_id = next((str(row.get("steam_id64")) for row in ordered if row.get("steam_id64")), None)
        account_id = next((str(row.get("account_id")) for row in ordered if row.get("account_id")), None)
        maps: dict[str, int] = {}
        kills = deaths = assists = 0
        match_rows: list[dict[str, Any]] = []
        for row in ordered:
            map_name = str(row.get("map_name") or "未知地图").strip() or "未知地图"
            maps[map_name] = maps.get(map_name, 0) + 1
            kills += max(0, int(row.get("kills") or 0))
            deaths += max(0, int(row.get("deaths") or 0))
            assists += max(0, int(row.get("assists") or 0))
            match_rows.append({
                "demo_id": int(row["demo_id"]),
                "title": str(row.get("display_name") or row.get("filename") or "Demo"),
                "filename": str(row.get("filename") or ""),
                "map_name": map_name,
                "match_date": row.get("match_date") or row.get("added_at"),
                "total_rounds": int(row.get("total_rounds") or 0),
                "team_a_score": row.get("team_a_score"),
                "team_b_score": row.get("team_b_score"),
                "team_name": row.get("team_name"),
                "kills": max(0, int(row.get("kills") or 0)),
                "deaths": max(0, int(row.get("deaths") or 0)),
                "assists": max(0, int(row.get("assists") or 0)),
                "status": str(row.get("status") or ""),
            })
        players.append({
            "player_key": player_key,
            "steam_id64": steam_id,
            "account_id": account_id,
            "identity_quality": "steamid64" if steam_id else "account_id" if account_id else "demo_local",
            "display_name": names[0] if names else "未知选手",
            "aliases": names,
            "groups": memberships.get(player_key, []),
            "demo_count": len(match_rows),
            "map_count": len(maps),
            "maps": [{"map_name": name, "demo_count": count} for name, count in sorted(maps.items())],
            "kills": kills,
            "deaths": deaths,
            "assists": assists,
            "kd": round(kills / deaths, 2) if deaths else float(kills),
            "last_seen_at": ordered[0].get("match_date") or ordered[0].get("added_at"),
            "matches": match_rows,
        })
    players.sort(key=lambda player: (-player["demo_count"], str(player["display_name"]).casefold(), player["player_key"]))
    return players


_ANALYSIS_FIELDS = (
    "kills", "deaths", "assists", "damage", "adr", "kast", "headshots", "hs_percent",
    "gun_hit_events",
    "first_kills", "first_deaths", "trade_kills", "trade_deaths",
    "clutch_attempts", "clutch_wins", "utility_damage", "utility_damage_per_round",
    "kpr", "dpr", "survival_rate", "trade_kill_rate", "one_kill_rounds",
    "two_kill_rounds", "three_kill_rounds", "four_kill_rounds", "five_kill_rounds",
    "awp_kills", "average_equipment_value",
)


def _workspace_player_for_roster(
    workspace_players: list[dict[str, Any]],
    roster_row: dict[str, Any],
) -> dict[str, Any] | None:
    """Match the archive identity to a player's identity in one analyzed Demo."""
    steam_id = str(roster_row.get("steam_id64") or "").strip()
    if steam_id:
        exact = next((
            player for player in workspace_players
            if str(player.get("steam_id64") or player.get("steamid64") or "").strip() == steam_id
            or str(player.get("player_key") or "").strip() == f"steamid:{steam_id}"
        ), None)
        if exact:
            return exact

    account_id = str(roster_row.get("account_id") or "").strip()
    if account_id:
        exact = next((
            player for player in workspace_players
            if str(player.get("account_id") or "").strip() == account_id
        ), None)
        if exact:
            return exact

    user_id = str(roster_row.get("user_id") or "").strip()
    if user_id:
        exact = next((
            player for player in workspace_players
            if str(player.get("user_id") or "").strip() == user_id
            or str(player.get("player_key") or "").strip() == f"userid:{user_id}"
        ), None)
        if exact:
            return exact

    name = str(roster_row.get("normalized_name") or roster_row.get("player_name") or "").strip().casefold()
    matches = [
        player for player in workspace_players
        if str(player.get("name") or player.get("display_name") or "").strip().casefold() == name
    ]
    return matches[0] if len(matches) == 1 else None


def _detail_breakdowns(
    workspace: dict[str, Any],
    player: dict[str, Any],
) -> dict[str, Any]:
    """Derive profile splits from stored round evidence without reparsing a Demo."""
    names = {
        str(value).strip().casefold()
        for value in (player.get("name"), player.get("display_name"))
        if str(value or "").strip()
    }
    team_key = str(player.get("team_key") or "")
    teammate_names = {
        str(value).strip().casefold()
        for teammate in (workspace.get("players") or [])
        if isinstance(teammate, dict) and str(teammate.get("team_key") or "") == team_key
        for value in (teammate.get("name"), teammate.get("display_name"))
        if str(value or "").strip()
    }
    if team_key not in {"a", "b"}:
        teammate_names.clear()
    else:
        teammate_names.difference_update(names)
    player_economy = {
        _safe_int(row.get("round_number")): row
        for row in (player.get("economy_rounds") or [])
        if isinstance(row, dict) and _safe_int(row.get("round_number")) > 0
    }
    round_damage = {
        _safe_int(row.get("round_number")): row
        for row in (player.get("round_damage") or [])
        if isinstance(row, dict) and _safe_int(row.get("round_number")) > 0
    }
    gun_hits_by_round = {
        _safe_int(row.get("round_number")): max(0, _safe_int(row.get("count")))
        for row in (player.get("gun_hit_events_by_round") or [])
        if isinstance(row, dict) and _safe_int(row.get("round_number")) > 0
    }
    side_breakdown: dict[str, dict[str, int]] = {}
    economy_breakdown: dict[str, dict[str, int]] = {}
    weapon_breakdown: dict[str, dict[str, int]] = {}
    utility_breakdown: dict[str, dict[str, int]] = {}
    clutch_breakdown: dict[str, dict[str, int]] = {}
    side_economy_breakdown: dict[str, dict[str, dict[str, int]]] = {}
    side_weapon_breakdown: dict[str, dict[str, dict[str, int]]] = {}
    side_utility_breakdown: dict[str, dict[str, dict[str, int]]] = {}
    side_clutch_breakdown: dict[str, dict[str, dict[str, int]]] = {}
    economy_sources: set[str] = set()
    side_by_round: dict[int, str] = {}

    def bucket(target: dict[str, dict[str, int]], label: str) -> dict[str, int]:
        return target.setdefault(label, {
            "rounds": 0, "wins": 0, "kills": 0, "deaths": 0, "assists": 0,
            "headshots": 0, "damage": 0, "utility_damage": 0, "damage_samples": 0,
            "awp_kills": 0, "gun_hit_events": 0, "shots_fired": 0,
            "first_kills": 0, "first_deaths": 0, "trade_kills": 0, "trade_deaths": 0,
            "clutch_attempts": 0, "clutch_wins": 0, "kast_rounds": 0, "survived_rounds": 0,
        })

    def nested_bucket(
        target: dict[str, dict[str, dict[str, int]]], side_label: str, label: str,
        defaults: dict[str, int],
    ) -> dict[str, int]:
        return target.setdefault(side_label, {}).setdefault(label, dict(defaults))

    def matches_player(value: Any) -> bool:
        return str(value or "").strip().casefold() in names

    for round_row in workspace.get("rounds") or []:
        if not isinstance(round_row, dict):
            continue
        round_number = _safe_int(round_row.get("round_number"))
        if round_number <= 0:
            continue
        side = round_row.get("team_a_side") if team_key == "a" else round_row.get("team_b_side") if team_key == "b" else None
        side_label = str(side).upper() if side else ""
        if side_label:
            side_by_round[round_number] = side_label
        won = str(round_row.get("winner_team_key") or "") == team_key and team_key in {"a", "b"}
        damage_row = round_damage.get(round_number) or {}
        individual_economy = player_economy.get(round_number)
        if individual_economy:
            economy_label = str(individual_economy.get("type") or "unknown").casefold()
            economy_sources.add("player_loadout")
        else:
            economy_label = str(
                round_row.get("team_a_economy") if team_key == "a"
                else round_row.get("team_b_economy") if team_key == "b"
                else ""
            ).casefold()
            economy_sources.add("team_context") if economy_label else None

        active_buckets: list[dict[str, int]] = []
        if side:
            side_bucket = bucket(side_breakdown, str(side).upper())
            side_bucket["rounds"] += 1
            side_bucket["wins"] += int(won)
            side_bucket["damage"] += max(0, _safe_int(damage_row.get("damage")))
            side_bucket["utility_damage"] += max(0, _safe_int(damage_row.get("utility_damage")))
            side_bucket["damage_samples"] += int(round_number in round_damage)
            active_buckets.append(side_bucket)
        if economy_label:
            economy_bucket = bucket(economy_breakdown, economy_label)
            economy_bucket["rounds"] += 1
            economy_bucket["wins"] += int(won)
            economy_bucket["damage"] += max(0, _safe_int(damage_row.get("damage")))
            economy_bucket["utility_damage"] += max(0, _safe_int(damage_row.get("utility_damage")))
            economy_bucket["damage_samples"] += int(round_number in round_damage)
            active_buckets.append(economy_bucket)
            if side_label:
                side_economy_bucket = nested_bucket(
                    side_economy_breakdown, side_label, economy_label,
                    {"rounds": 0, "wins": 0, "kills": 0, "deaths": 0, "assists": 0,
                     "headshots": 0, "damage": 0, "utility_damage": 0, "damage_samples": 0,
                     "awp_kills": 0, "gun_hit_events": 0, "shots_fired": 0,
                     "first_kills": 0, "first_deaths": 0, "trade_kills": 0, "trade_deaths": 0,
                     "clutch_attempts": 0, "clutch_wins": 0, "kast_rounds": 0, "survived_rounds": 0},
                )
                side_economy_bucket["rounds"] += 1
                side_economy_bucket["wins"] += int(won)
                side_economy_bucket["damage"] += max(0, _safe_int(damage_row.get("damage")))
                side_economy_bucket["utility_damage"] += max(0, _safe_int(damage_row.get("utility_damage")))
                side_economy_bucket["damage_samples"] += int(round_number in round_damage)
                active_buckets.append(side_economy_bucket)

        for active in active_buckets:
            active["gun_hit_events"] += gun_hits_by_round.get(round_number, 0)

        events = [event for event in (round_row.get("events") or []) if isinstance(event, dict)]
        kills = sorted(
            (event for event in events if event.get("type") == "kill"),
            key=lambda event: _safe_int(event.get("tick")),
        )
        valid_kills = [
            event for event in kills
            if str(event.get("actor") or "").strip().casefold() not in {"", "world"}
            and str(event.get("target") or "").strip()
            and str(event.get("actor") or "").strip().casefold()
            != str(event.get("target") or "").strip().casefold()
        ]
        first_kill = valid_kills[0] if valid_kills else None
        killed_this_round = False
        died_this_round = False
        assisted_this_round = False
        death_tick: int | None = None
        death_killer = ""
        for event in valid_kills:
            actor_is_player = matches_player(event.get("actor"))
            target_is_player = matches_player(event.get("target"))
            assister_is_player = matches_player(event.get("assister"))
            killed_this_round = killed_this_round or actor_is_player
            assisted_this_round = assisted_this_round or assister_is_player
            if target_is_player and not died_this_round:
                died_this_round = True
                death_tick = _safe_int(event.get("tick"))
                death_killer = str(event.get("actor") or "").strip().casefold()
            for active in active_buckets:
                if actor_is_player:
                    active["kills"] += 1
                    active["headshots"] += int(bool(event.get("headshot")))
                    active["awp_kills"] += int(str(event.get("weapon") or "").strip().casefold() == "awp")
                if target_is_player:
                    active["deaths"] += 1
                if assister_is_player:
                    active["assists"] += 1
                if event is first_kill:
                    active["first_kills"] += int(actor_is_player)
                    active["first_deaths"] += int(target_is_player)

            if actor_is_player:
                weapon = str(event.get("weapon") or "unknown").strip().casefold() or "unknown"
                weapon_bucket = weapon_breakdown.setdefault(weapon, {"kills": 0, "headshots": 0, "damage": 0, "shots_fired": 0})
                weapon_bucket["kills"] += 1
                weapon_bucket["headshots"] += int(bool(event.get("headshot")))
                if side_label:
                    scoped_weapon = nested_bucket(
                        side_weapon_breakdown, side_label, weapon,
                        {"kills": 0, "headshots": 0, "damage": 0, "shots_fired": 0},
                    )
                    scoped_weapon["kills"] += 1
                    scoped_weapon["headshots"] += int(bool(event.get("headshot")))

        was_traded = False
        trade_window = max(1, round(_safe_float(workspace.get("tick_rate"), 64.0) * 5))
        if died_this_round and death_tick is not None and death_killer:
            was_traded = any(
                str(event.get("actor") or "").strip().casefold() in teammate_names
                and str(event.get("target") or "").strip().casefold() == death_killer
                and 0 <= _safe_int(event.get("tick")) - death_tick <= trade_window
                for event in valid_kills
            )
        teammate_deaths = [
            (_safe_int(event.get("tick")), str(event.get("actor") or "").strip().casefold())
            for event in valid_kills
            if str(event.get("target") or "").strip().casefold() in teammate_names
            and str(event.get("actor") or "").strip().casefold() not in teammate_names
        ]
        traded_kill = any(
            actor_is_player
            and any(
                teammate_killer == str(event.get("target") or "").strip().casefold()
                and 0 <= _safe_int(event.get("tick")) - teammate_death_tick <= trade_window
                for teammate_death_tick, teammate_killer in teammate_deaths
            )
            for event in valid_kills
            for actor_is_player in [matches_player(event.get("actor"))]
        )
        kast_this_round = killed_this_round or assisted_this_round or not died_this_round or was_traded
        for active in active_buckets:
            active["kast_rounds"] += int(kast_this_round)
            active["survived_rounds"] += int(not died_this_round)
            active["trade_kills"] += int(traded_kill)
            active["trade_deaths"] += int(was_traded)

        for event in events:
            if event.get("type") == "grenade" and matches_player(event.get("actor")):
                kind = str(event.get("kind") or "unknown").strip() or "unknown"
                utility_breakdown.setdefault(kind, {"throws": 0})["throws"] += 1
                if side_label:
                    nested_bucket(side_utility_breakdown, side_label, kind, {"throws": 0})["throws"] += 1

        for shot in round_row.get("shots") or []:
            if not isinstance(shot, dict) or not matches_player(shot.get("actor")):
                continue
            weapon = str(shot.get("weapon") or "unknown").strip().casefold() or "unknown"
            weapon_breakdown.setdefault(weapon, {"kills": 0, "headshots": 0, "damage": 0, "shots_fired": 0})["shots_fired"] += 1
            for active in active_buckets:
                active["shots_fired"] += 1
            if side_label:
                nested_bucket(
                    side_weapon_breakdown, side_label, weapon,
                    {"kills": 0, "headshots": 0, "damage": 0, "shots_fired": 0},
                )["shots_fired"] += 1

        for event in round_row.get("special_events") or []:
            if not isinstance(event, dict) or event.get("type") != "clutch" or not matches_player(event.get("player")):
                continue
            opponents = max(0, _safe_int(event.get("opponents")))
            label = f"1v{opponents}" if opponents else "unknown"
            clutch_bucket = clutch_breakdown.setdefault(label, {"attempts": 0, "wins": 0})
            clutch_bucket["attempts"] += 1
            clutch_bucket["wins"] += int(bool(event.get("won")))
            if side_label:
                side_clutch_bucket = nested_bucket(side_clutch_breakdown, side_label, label, {"attempts": 0, "wins": 0})
                side_clutch_bucket["attempts"] += 1
                side_clutch_bucket["wins"] += int(bool(event.get("won")))
            for active in active_buckets:
                active["clutch_attempts"] += 1
                active["clutch_wins"] += int(bool(event.get("won")))

    weapon_damage_rounds = player.get("weapon_damage_rounds")
    if isinstance(weapon_damage_rounds, list):
        for row in weapon_damage_rounds:
            if not isinstance(row, dict):
                continue
            weapon_key = str(row.get("weapon") or "unknown").casefold()
            amount = max(0, _safe_int(row.get("damage")))
            weapon_breakdown.setdefault(weapon_key, {"kills": 0, "headshots": 0, "damage": 0, "shots_fired": 0})["damage"] += amount
            scoped_side = side_by_round.get(_safe_int(row.get("round_number")))
            if scoped_side:
                nested_bucket(
                    side_weapon_breakdown, scoped_side, weapon_key,
                    {"kills": 0, "headshots": 0, "damage": 0, "shots_fired": 0},
                )["damage"] += amount
    else:
        weapon_damage = player.get("weapon_damage") or {}
        if isinstance(weapon_damage, dict):
            for weapon, amount in weapon_damage.items():
                weapon_key = str(weapon or "unknown").casefold()
                weapon_breakdown.setdefault(weapon_key, {"kills": 0, "headshots": 0, "damage": 0, "shots_fired": 0})["damage"] += max(0, _safe_int(amount))

    return {
        "gun_hit_events": sum(gun_hits_by_round.values()),
        "shots_fired": sum(
            max(0, _safe_int(row.get("shots_fired")))
            for row in weapon_breakdown.values()
        ),
        "side_breakdown": side_breakdown,
        "economy_breakdown": economy_breakdown,
        "economy_source": "player_loadout" if "player_loadout" in economy_sources and "team_context" not in economy_sources
        else "mixed" if len(economy_sources) > 1
        else next(iter(economy_sources), "unavailable"),
        "weapon_breakdown": weapon_breakdown,
        "utility_breakdown": utility_breakdown,
        "clutch_breakdown": clutch_breakdown,
        "side_economy_breakdown": side_economy_breakdown,
        "side_weapon_breakdown": side_weapon_breakdown,
        "side_utility_breakdown": side_utility_breakdown,
        "side_clutch_breakdown": side_clutch_breakdown,
    }


def _analysis_metrics(
    player: dict[str, Any],
    total_rounds: int,
    workspace: dict[str, Any] | None = None,
) -> dict[str, Any]:
    count_fields = {
        "kills", "deaths", "assists", "damage", "headshots", "first_kills", "first_deaths",
        "gun_hit_events",
        "trade_kills", "trade_deaths", "clutch_attempts", "clutch_wins", "utility_damage",
        "one_kill_rounds", "two_kill_rounds", "three_kill_rounds", "four_kill_rounds",
        "five_kill_rounds", "awp_kills",
    }
    metrics: dict[str, Any] = {}
    for field in _ANALYSIS_FIELDS:
        try:
            value = float(player.get(field) or 0)
            metrics[field] = max(0, int(value)) if field in count_fields else value
        except (TypeError, ValueError, OverflowError):
            metrics[field] = 0 if field in count_fields else None
    metrics["total_rounds"] = max(0, int(total_rounds))
    metrics["opening_duels"] = max(0, int(player.get("first_kills") or 0)) + max(
        0, int(player.get("first_deaths") or 0)
    )
    metrics["opening_duel_win_rate"] = round(
        metrics["first_kills"] / metrics["opening_duels"] * 100, 1
    ) if metrics["opening_duels"] else None
    metrics["clutch_win_rate"] = round(
        metrics["clutch_wins"] / metrics["clutch_attempts"] * 100, 1
    ) if metrics["clutch_attempts"] else None
    rounds = metrics["total_rounds"]
    metrics["damage"] = metrics["damage"] or round(float(metrics.get("adr") or 0) * rounds)
    metrics["kpr"] = round(metrics["kills"] / rounds, 2) if rounds else None
    metrics["dpr"] = round(metrics["deaths"] / rounds, 2) if rounds else None
    metrics["survival_rate"] = round(_safe_float(player.get("survival_rate")), 1) if player.get("survival_rate") is not None else None
    metrics["trade_kill_rate"] = round(_safe_float(player.get("trade_kill_rate")), 1) if player.get("trade_kill_rate") is not None else None
    metrics["average_equipment_value"] = max(0, _safe_int(player.get("average_equipment_value")))
    metrics["damage_available"] = isinstance(player.get("round_damage"), list)
    metrics["team_key"] = str(player.get("team_key") or "")
    metrics["rating_approx"] = round(
        0.3591 * (metrics["kills"] / rounds)
        - 0.5329 * (metrics["deaths"] / rounds)
        + 0.2372 * (2.13 * (metrics["kills"] / rounds) + 0.42 * (metrics["assists"] / rounds) - 0.41)
        + 0.0032 * (float(metrics.get("adr") or 0))
        + 0.1587,
        2,
    ) if rounds else None
    team_key = metrics["team_key"]
    team_a_score = _safe_int((workspace or {}).get("team_a_score"))
    team_b_score = _safe_int((workspace or {}).get("team_b_score"))
    if team_key in {"a", "b"}:
        metrics["team_score"] = team_a_score if team_key == "a" else team_b_score
        metrics["opponent_score"] = team_b_score if team_key == "a" else team_a_score
        metrics["match_result"] = "W" if metrics["team_score"] > metrics["opponent_score"] else "L" if metrics["team_score"] < metrics["opponent_score"] else "D"
        metrics["team_name"] = str((workspace or {}).get("team_a_name" if team_key == "a" else "team_b_name") or "")
        metrics["opponent_name"] = str((workspace or {}).get("team_b_name" if team_key == "a" else "team_a_name") or "")
    metrics["data_version"] = 2
    metrics.update(_detail_breakdowns(workspace or {}, player))
    metrics["gun_hit_events_available"] = bool(
        player.get("gun_hit_events_available", (workspace or {}).get("gun_hit_data_available"))
    )
    metrics["shot_data_available"] = bool((workspace or {}).get("shot_data_available"))
    side_round_wins = sum(
        _safe_int(bucket.get("wins")) for bucket in metrics["side_breakdown"].values()
    )
    scoreboard_total = _safe_int(metrics.get("team_score")) + _safe_int(metrics.get("opponent_score"))
    if team_key in {"a", "b"} and scoreboard_total == rounds:
        # A round with a missing side label cannot enter side_breakdown, even
        # when the final scoreboard and completed-round count are authoritative.
        metrics["rounds_won"] = _safe_int(metrics.get("team_score"))
    else:
        metrics["rounds_won"] = side_round_wins
    return metrics


def _summarize_analysis(matches: list[dict[str, Any]]) -> dict[str, Any]:
    available = [row["metrics"] for row in matches if row.get("available") and row.get("metrics")]
    totals = {
        field: sum(max(0, int(metrics.get(field) or 0)) for metrics in available)
        for field in (
            "kills", "deaths", "assists", "damage", "headshots", "first_kills", "first_deaths",
            "trade_kills", "trade_deaths", "clutch_attempts", "clutch_wins", "utility_damage",
            "one_kill_rounds", "two_kill_rounds", "three_kill_rounds", "four_kill_rounds",
            "five_kill_rounds", "awp_kills",
        )
    }
    total_rounds = sum(max(0, int(metrics.get("total_rounds") or 0)) for metrics in available)
    opening_duels = totals["first_kills"] + totals["first_deaths"]
    analyzed = len(available)
    kast_rounds = sum(
        (float(metrics.get("kast") or 0) * int(metrics.get("total_rounds") or 0)) / 100
        for metrics in available
    )
    adr_damage = sum(
        float(metrics.get("damage") or 0)
        for metrics in available
    )
    weighted = lambda field: sum(
        float(metrics.get(field) or 0) * int(metrics.get("total_rounds") or 0)
        for metrics in available
    )
    def merge_breakdown(field: str) -> dict[str, dict[str, int]]:
        merged: dict[str, dict[str, int]] = {}
        for metrics in available:
            for label, values in (metrics.get(field) or {}).items():
                bucket = merged.setdefault(str(label), {})
                for key, value in values.items():
                    if isinstance(value, (int, float)):
                        bucket[key] = bucket.get(key, 0) + int(value)
        return merged

    side_breakdown = merge_breakdown("side_breakdown")
    economy_breakdown = merge_breakdown("economy_breakdown")
    weapon_breakdown = merge_breakdown("weapon_breakdown")
    utility_breakdown = merge_breakdown("utility_breakdown")
    clutch_breakdown = merge_breakdown("clutch_breakdown")

    def merge_side_breakdown(field: str) -> dict[str, dict[str, dict[str, int]]]:
        merged: dict[str, dict[str, dict[str, int]]] = {}
        for metrics in available:
            for side, rows in (metrics.get(field) or {}).items():
                side_rows = merged.setdefault(str(side), {})
                for label, values in rows.items():
                    bucket = side_rows.setdefault(str(label), {})
                    for key, value in values.items():
                        if isinstance(value, (int, float)):
                            bucket[key] = bucket.get(key, 0) + int(value)
        return merged

    side_economy_breakdown = merge_side_breakdown("side_economy_breakdown")
    side_weapon_breakdown = merge_side_breakdown("side_weapon_breakdown")
    side_utility_breakdown = merge_side_breakdown("side_utility_breakdown")
    side_clutch_breakdown = merge_side_breakdown("side_clutch_breakdown")
    rounds_won = sum(
        int(bucket.get("wins") or 0)
        for bucket in side_breakdown.values()
    )
    matches_won = sum(1 for metrics in available if metrics.get("match_result") == "W")
    matches_lost = sum(1 for metrics in available if metrics.get("match_result") == "L")
    economy_sources = sorted({str(metrics.get("economy_source") or "unavailable") for metrics in available})
    return {
        **totals,
        "matches_analyzed": analyzed,
        "total_rounds": total_rounds,
        "matches_won": matches_won,
        "matches_lost": matches_lost,
        "rounds_won": rounds_won,
        "round_win_rate": round(rounds_won / total_rounds * 100, 1) if total_rounds else None,
        "kd": round(totals["kills"] / totals["deaths"], 2) if totals["deaths"] else float(totals["kills"]),
        "adr": round(adr_damage / total_rounds, 1) if total_rounds else None,
        "kpr": round(totals["kills"] / total_rounds, 2) if total_rounds else None,
        "dpr": round(totals["deaths"] / total_rounds, 2) if total_rounds else None,
        "kast": round(kast_rounds / total_rounds * 100, 1) if total_rounds else None,
        "survival_rate": round(weighted("survival_rate") / total_rounds, 1) if total_rounds else None,
        "rating_approx": round(weighted("rating_approx") / total_rounds, 2) if total_rounds else None,
        "hs_percent": round(totals["headshots"] / totals["kills"] * 100, 1) if totals["kills"] else None,
        "opening_duels": opening_duels,
        "opening_duel_win_rate": round(totals["first_kills"] / opening_duels * 100, 1) if opening_duels else None,
        "clutch_win_rate": round(totals["clutch_wins"] / totals["clutch_attempts"] * 100, 1) if totals["clutch_attempts"] else None,
        "utility_damage_per_round": round(totals["utility_damage"] / total_rounds, 1) if total_rounds else None,
        "multi_kill_rounds": sum(totals[field] for field in ("two_kill_rounds", "three_kill_rounds", "four_kill_rounds", "five_kill_rounds")),
        "trade_kill_rate": round(weighted("trade_kill_rate") / total_rounds, 1) if total_rounds else None,
        "average_equipment_value": round(weighted("average_equipment_value") / total_rounds) if total_rounds else None,
        "side_breakdown": side_breakdown,
        "economy_breakdown": economy_breakdown,
        "economy_sources": economy_sources,
        "weapon_breakdown": weapon_breakdown,
        "utility_breakdown": utility_breakdown,
        "clutch_breakdown": clutch_breakdown,
        "side_economy_breakdown": side_economy_breakdown,
        "side_weapon_breakdown": side_weapon_breakdown,
        "side_utility_breakdown": side_utility_breakdown,
        "side_clutch_breakdown": side_clutch_breakdown,
    }


def _event_position(event: dict[str, Any], role: str) -> dict[str, float] | None:
    prefixes = ("actor", "attacker") if role == "actor" else ("target", "victim")
    for prefix in prefixes:
        try:
            x = float(event.get(f"{prefix}_x"))
            y = float(event.get(f"{prefix}_y"))
        except (TypeError, ValueError, OverflowError):
            continue
        if math.isfinite(x) and math.isfinite(y):
            point = {"x": x, "y": y}
            try:
                z = float(event.get(f"{prefix}_z"))
            except (TypeError, ValueError, OverflowError):
                z = None
            if z is not None and math.isfinite(z):
                point["z"] = z
            return point
    return None


def _position_area(value: object) -> str:
    text = " ".join(str(value or "").split())
    if not text or text.casefold() in {"nan", "nat", "none", "null", "undefined"}:
        return "未知区域"
    return text


def _player_tactical_metrics(
    workspace: dict[str, Any],
    match_player: dict[str, Any],
    roster_row: dict[str, Any],
) -> dict[str, Any]:
    player_names = {
        str(value).strip().casefold()
        for value in (
            match_player.get("name"), match_player.get("display_name"),
            roster_row.get("player_name"), roster_row.get("normalized_name"),
        )
        if str(value or "").strip()
    }
    player_steam_id = str(
        match_player.get("steam_id64") or match_player.get("steamid64")
        or roster_row.get("steam_id64") or ""
    ).strip()

    def is_player(name: object, steam_id: object = None) -> bool:
        candidate_id = str(steam_id or "").strip()
        if player_steam_id and candidate_id:
            return candidate_id == player_steam_id
        return str(name or "").strip().casefold() in player_names

    empty = {
        "available": False,
        "duel_cells": [],
        "duel_wins": 0,
        "duel_losses": 0,
        "site_break_first_kills": 0,
        "site_hold_first_kills": 0,
        "site_break_2k": 0,
        "site_break_3k": 0,
        "site_hold_2k": 0,
        "site_hold_3k": 0,
        "site_break_kills": 0,
        "site_hold_kills": 0,
        "site_area_kills": 0,
        "flash_assisted_kills": 0,
        "flash_assisted_kills_by_side": {},
        "duel_kill_time_by_side": {},
        "position_kill_cells": [],
        "site_breakdown": [],
    }
    if int(workspace.get("tactical_metrics_version") or 0) < 4:
        return empty

    cells: dict[tuple[str, str, str], dict[str, Any]] = {}
    duel_wins = 0
    duel_losses = 0
    kill_time_by_side: dict[str, dict[str, float]] = {}
    flash_assisted_kills_by_side: dict[str, int] = {}
    tick_rate = max(1.0, _safe_float(workspace.get("tick_rate"), 64.0))
    flash_assisted_kills = 0
    for row in workspace.get("duel_engagements") or []:
        if not isinstance(row, dict) or not is_player(row.get("player"), row.get("player_steam_id64")):
            continue
        side = str(row.get("side") or "unknown").upper()
        if row.get("result") == "win":
            elapsed_ticks = _safe_int(row.get("end_tick")) - _safe_int(row.get("tick"))
            if elapsed_ticks >= 0 and side in {"T", "CT"}:
                bucket = kill_time_by_side.setdefault(side, {"total_ms": 0.0, "samples": 0.0})
                bucket["total_ms"] += elapsed_ticks / tick_rate * 1000.0
                bucket["samples"] += 1
        own_area = _position_area(row.get("own_area"))
        enemy_area = _position_area(row.get("enemy_area"))
        cell_key = (side, own_area.casefold(), enemy_area.casefold())
        cell = cells.setdefault(cell_key, {
            "side": side,
            "own_area": own_area,
            "enemy_area": enemy_area,
            "wins": 0,
            "losses": 0,
            "sample": None,
        })
        if cell["sample"] is None:
            own_position = row.get("own_position")
            enemy_position = row.get("enemy_position")
            if own_position or enemy_position:
                cell["sample"] = {
                    "own_position": own_position,
                    "enemy_position": enemy_position,
                }
        if row.get("result") == "win":
            cell["wins"] += 1
            duel_wins += 1
        elif row.get("result") == "loss":
            cell["losses"] += 1
            duel_losses += 1

    kills_by_site: dict[tuple[int, str, str, str], list[dict[str, Any]]] = {}
    first_kills: dict[tuple[int, str, str], dict[str, Any]] = {}
    position_kills: dict[tuple[str, str, str], dict[str, Any]] = {}
    for round_row in workspace.get("rounds") or []:
        if not isinstance(round_row, dict):
            continue
        round_number = _safe_int(round_row.get("round_number"))
        for event in round_row.get("events") or []:
            if not isinstance(event, dict) or event.get("type") != "kill":
                continue
            if event.get("assistedflash") and is_player(event.get("assister")):
                flash_assisted_kills += 1
                assist_side = str(event.get("actor_side") or "").upper()
                if assist_side in {"T", "CT"}:
                    flash_assisted_kills_by_side[assist_side] = flash_assisted_kills_by_side.get(assist_side, 0) + 1
            if is_player(event.get("actor"), event.get("actor_steamid")):
                side = str(event.get("actor_side") or "unknown").upper()
                own_area = _position_area(event.get("actor_place"))
                enemy_area = _position_area(event.get("target_place"))
                cell_key = (side, own_area.casefold(), enemy_area.casefold())
                cell = position_kills.setdefault(cell_key, {
                    "side": side,
                    "own_area": own_area,
                    "enemy_area": enemy_area,
                    "kills": 0,
                    "rounds": set(),
                    "sample": None,
                })
                cell["kills"] += 1
                cell["rounds"].add(round_number)
                if cell["sample"] is None:
                    own_position = _event_position(event, "actor")
                    enemy_position = _event_position(event, "target")
                    if own_position or enemy_position:
                        cell["sample"] = {
                            "own_position": own_position,
                            "enemy_position": enemy_position,
                        }
            site = str(event.get("tactical_site") or "").upper()
            role = str(event.get("tactical_role") or "").lower()
            if site not in {"A", "B"} or role not in {"break", "hold"}:
                continue
            site_key = (round_number, site, role)
            if site_key not in first_kills or _safe_int(event.get("tick")) < _safe_int(first_kills[site_key].get("tick")):
                first_kills[site_key] = event
            if is_player(event.get("actor"), event.get("actor_steamid")):
                kills_by_site.setdefault((*site_key, str(event.get("actor") or "").casefold()), []).append(event)

    counters = dict(empty)
    counters["available"] = True
    counters["duel_wins"] = duel_wins
    counters["duel_losses"] = duel_losses
    counters["duel_kill_time_by_side"] = kill_time_by_side
    counters["flash_assisted_kills"] = flash_assisted_kills
    counters["flash_assisted_kills_by_side"] = flash_assisted_kills_by_side
    counters["duel_cells"] = [
        {
            "side": values["side"],
            "own_area": values["own_area"],
            "enemy_area": values["enemy_area"],
            "wins": values["wins"],
            "losses": values["losses"],
            "sample": values["sample"],
        }
        for _, values in sorted(cells.items())
    ]
    counters["position_kill_cells"] = [
        {
            "side": values["side"],
            "own_area": values["own_area"],
            "enemy_area": values["enemy_area"],
            "kills": values["kills"],
            "rounds": len(values["rounds"]),
            "sample": values["sample"],
        }
        for _, values in sorted(position_kills.items())
    ]
    counters["map_transform"] = workspace.get("map_transform")
    site_breakdown: dict[str, dict[str, Any]] = {}

    def site_row(site: str) -> dict[str, Any]:
        return site_breakdown.setdefault(site, {
            "site": site,
            "break_first_kills": 0,
            "hold_first_kills": 0,
            "break_2k": 0,
            "break_3k": 0,
            "hold_2k": 0,
            "hold_3k": 0,
        })

    for (round_number, _site, role), event in first_kills.items():
        if is_player(event.get("actor"), event.get("actor_steamid")):
            field = "site_break_first_kills" if role == "break" else "site_hold_first_kills"
            counters[field] += 1
            site_row(_site)[f"{role}_first_kills"] += 1
    for (round_number, site, role, _player_name), events in kills_by_site.items():
        events.sort(key=lambda event: _safe_int(event.get("tick")))
        tick_rate = max(1.0, _safe_float(workspace.get("tick_rate"), 64.0))
        max_gap = int(round(tick_rate * 10.0))
        cluster: list[dict[str, Any]] = []
        for event in events:
            if cluster and _safe_int(event.get("tick")) - _safe_int(cluster[-1].get("tick")) > max_gap:
                if len(cluster) >= 2:
                    counters[f"site_{role}_2k"] += 1
                    site_row(site)[f"{role}_2k"] += 1
                if len(cluster) >= 3:
                    counters[f"site_{role}_3k"] += 1
                    site_row(site)[f"{role}_3k"] += 1
                cluster = []
            cluster.append(event)
        if len(cluster) >= 2:
            counters[f"site_{role}_2k"] += 1
            site_row(site)[f"{role}_2k"] += 1
        if len(cluster) >= 3:
            counters[f"site_{role}_3k"] += 1
            site_row(site)[f"{role}_3k"] += 1
    counters["site_break_kills"] = sum(
        len(events) for key, events in kills_by_site.items() if key[2] == "break"
    )
    counters["site_hold_kills"] = sum(
        len(events) for key, events in kills_by_site.items() if key[2] == "hold"
    )
    counters["site_area_kills"] = counters["site_break_kills"] + counters["site_hold_kills"]
    counters["site_breakdown"] = [site_breakdown[key] for key in sorted(site_breakdown)]
    return counters


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return result if math.isfinite(result) else default


def _player_event_evidence(
    workspace: dict[str, Any],
    match_player: dict[str, Any],
    roster_row: dict[str, Any],
) -> dict[str, Any]:
    """Build only observed elimination/utility evidence; do not call it all duels."""
    player_names = {
        str(value).strip().casefold()
        for value in (
            match_player.get("name"), match_player.get("display_name"),
            roster_row.get("player_name"), roster_row.get("normalized_name"),
        )
        if str(value or "").strip()
    }
    player_team = str(match_player.get("team_key") or "")
    eliminations: list[dict[str, Any]] = []
    clutches: list[dict[str, Any]] = []
    utilities: list[dict[str, Any]] = []
    opponent_map: dict[str, dict[str, Any]] = {}

    for round_row in workspace.get("rounds") or []:
        if not isinstance(round_row, dict):
            continue
        round_number = _safe_int(round_row.get("round_number"))
        events = [event for event in (round_row.get("events") or []) if isinstance(event, dict)]
        kills = sorted(
            (event for event in events if event.get("type") == "kill"),
            key=lambda event: _safe_int(event.get("tick")),
        )
        valid_kills = [
            event for event in kills
            if str(event.get("actor") or "").strip().casefold() not in {"", "world"}
            and str(event.get("target") or "").strip()
            and str(event.get("actor") or "").strip().casefold()
            != str(event.get("target") or "").strip().casefold()
        ]
        opening_event = valid_kills[0] if valid_kills else None
        side = round_row.get("team_a_side") if player_team == "a" else round_row.get("team_b_side") if player_team == "b" else None

        for event in valid_kills:
            actor = str(event.get("actor") or "").strip()
            target = str(event.get("target") or "").strip()
            actor_is_player = actor.casefold() in player_names
            target_is_player = target.casefold() in player_names
            if not actor_is_player and not target_is_player:
                continue
            if actor_is_player and target_is_player:
                continue
            role = "kill" if actor_is_player else "death"
            opponent = target if actor_is_player else actor
            actor_position = _event_position(event, "actor")
            target_position = _event_position(event, "target")
            player_position = actor_position if actor_is_player else target_position
            opponent_position = target_position if actor_is_player else actor_position
            distance = None
            if actor_position and target_position:
                distance = round(math.hypot(
                    actor_position["x"] - target_position["x"],
                    actor_position["y"] - target_position["y"],
                ), 1)
            is_opening = event is opening_event
            evidence = {
                "type": role,
                "round_number": round_number,
                "tick": _safe_int(event.get("tick")),
                "time_text": str(event.get("time_text") or ""),
                "opponent": opponent,
                "weapon": str(event.get("weapon") or ""),
                "headshot": bool(event.get("headshot")),
                "is_opening": is_opening,
                "side": side,
                "player_position": player_position,
                "opponent_position": opponent_position,
                "distance": distance,
            }
            eliminations.append(evidence)
            opponent_key = opponent.casefold()
            summary = opponent_map.setdefault(opponent_key, {
                "opponent": opponent,
                "kills": 0,
                "deaths": 0,
                "opening_kills": 0,
                "opening_deaths": 0,
                "distances": [],
                "sides": {},
            })
            summary["kills" if role == "kill" else "deaths"] += 1
            if is_opening:
                summary["opening_kills" if role == "kill" else "opening_deaths"] += 1
            if distance is not None:
                summary["distances"].append(distance)
            side_label = str(side).upper() if side else ""
            if side_label:
                side_summary = summary["sides"].setdefault(side_label, {
                    "kills": 0, "deaths": 0, "opening_kills": 0,
                    "opening_deaths": 0, "distances": [],
                })
                side_summary["kills" if role == "kill" else "deaths"] += 1
                if is_opening:
                    side_summary["opening_kills" if role == "kill" else "opening_deaths"] += 1
                if distance is not None:
                    side_summary["distances"].append(distance)

        for event in round_row.get("special_events") or []:
            if not isinstance(event, dict) or str(event.get("type") or "") != "clutch":
                continue
            if str(event.get("player") or "").strip().casefold() not in player_names:
                continue
            clutches.append({
                "round_number": round_number,
                "opponents": max(0, _safe_int(event.get("opponents"))),
                "won": bool(event.get("won")),
                "side": side,
            })

        for event in events:
            if str(event.get("type") or "") != "grenade":
                continue
            if str(event.get("actor") or "").strip().casefold() not in player_names:
                continue
            trajectory = []
            for point in event.get("trajectory") or []:
                if not isinstance(point, dict):
                    continue
                try:
                    x = float(point.get("x"))
                    y = float(point.get("y"))
                except (TypeError, ValueError, OverflowError):
                    continue
                if math.isfinite(x) and math.isfinite(y):
                    trajectory.append({"tick": _safe_int(point.get("tick")), "x": x, "y": y})
            length = sum(
                math.hypot(next_point["x"] - point["x"], next_point["y"] - point["y"])
                for point, next_point in zip(trajectory, trajectory[1:])
            )
            utilities.append({
                "round_number": round_number,
                "tick": _safe_int(event.get("tick")),
                "kind": str(event.get("kind") or "utility"),
                "throw_tick": _safe_int(event.get("throw_tick") or event.get("tick")),
                "trajectory": trajectory,
                "path_length": round(length, 1) if trajectory else None,
            })

    opponents = []
    for summary in opponent_map.values():
        distances = summary.pop("distances")
        summary["average_elimination_distance"] = round(sum(distances) / len(distances), 1) if distances else None
        summary["distance_samples"] = len(distances)
        for side_summary in summary["sides"].values():
            side_distances = side_summary.pop("distances")
            side_summary["average_elimination_distance"] = round(
                sum(side_distances) / len(side_distances), 1,
            ) if side_distances else None
            side_summary["distance_samples"] = len(side_distances)
        opponents.append(summary)
    opponents.sort(key=lambda row: (-(row["kills"] + row["deaths"]), str(row["opponent"]).casefold()))
    eliminations.sort(key=lambda row: (row["round_number"], row["tick"]), reverse=True)
    clutches.sort(key=lambda row: row["round_number"], reverse=True)
    utilities.sort(key=lambda row: (row["round_number"], row["tick"]), reverse=True)
    return {
        "eliminations": eliminations[:250],
        "clutches": clutches[:100],
        "utilities": utilities[:250],
        "opponents": opponents[:100],
        "duel_win_rate_available": False,
        "duel_metric_note": "Observed eliminations are not a complete 1v1 attempt sample.",
    }


async def _load_analysis_matches(
    db_path: Path,
    player_key: str,
    roster_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rows = _deduplicate_matches([row for row in roster_rows if str(row.get("player_key")) == player_key])
    if not rows:
        return []
    demo_ids = list(dict.fromkeys(int(row["demo_id"]) for row in rows))
    result_rows: list[dict[str, Any]] = []
    async with aiosqlite.connect(db_path) as conn:
        conn.row_factory = aiosqlite.Row
        for offset in range(0, len(demo_ids), 500):
            batch = demo_ids[offset:offset + 500]
            placeholders = ",".join("?" for _ in batch)
            cursor = await conn.execute(
                f"""
                SELECT d.id AS demo_id, d.path AS demo_path, d.status,
                       r.result_json
                FROM demo_files d
                LEFT JOIN match_results r ON r.id = (
                    SELECT MAX(latest.id) FROM match_results latest WHERE latest.demo_path = d.path
                )
                WHERE d.id IN ({placeholders})
                """,
                batch,
            )
            result_rows.extend(dict(row) for row in await cursor.fetchall())

    result_by_id = {int(row["demo_id"]): row for row in result_rows}
    source_by_id: dict[int, dict[str, Any]] = {}
    for row in rows:
        source_by_id.setdefault(int(row["demo_id"]), row)

    enriched: list[dict[str, Any]] = []
    for demo_id in demo_ids:
        stored = result_by_id.get(demo_id) or {}
        source = source_by_id.get(demo_id) or {}
        result_json = stored.get("result_json")
        workspace: dict[str, Any] = {}
        if result_json:
            try:
                decoded = json.loads(str(result_json))
                candidate = decoded.get("analysis_workspace") if isinstance(decoded, dict) else None
                if isinstance(candidate, dict):
                    workspace = candidate
            except (TypeError, ValueError, json.JSONDecodeError):
                workspace = {}
        workspace_players = [
            player for player in (workspace.get("players") or []) if isinstance(player, dict)
        ]
        match_player = _workspace_player_for_roster(workspace_players, source) if workspace else None
        total_rounds = len(workspace.get("rounds") or []) if workspace else 0
        required_metrics = {"adr", "kast", "first_kills", "first_deaths", "trade_kills", "clutch_attempts", "clutch_wins", "utility_damage"}
        metrics = (
            _analysis_metrics(match_player, total_rounds, workspace)
            if match_player and required_metrics.issubset(match_player)
            else None
        )
        enriched.append({
            "demo_id": demo_id,
            "available": bool(metrics),
            "player_name": str(source.get("player_name") or ""),
            "title": str(source.get("display_name") or source.get("filename") or "Demo"),
            "map_name": str(source.get("map_name") or "未知地图"),
            "match_date": source.get("match_date") or source.get("added_at"),
            "workspace_player_key": str((match_player or {}).get("player_key") or ""),
            "metrics": metrics,
            "tactical_metrics": (
                _player_tactical_metrics(workspace, match_player, source)
                if match_player and workspace else {"available": False}
            ),
        })
    return enriched


async def _load_roster_rows(db_path: Path, group_id: str = "all", map_name: str = "") -> list[dict[str, Any]]:
    identity = _identity_sql("ps")
    where = ["TRIM(COALESCE(ps.player_name, '')) <> ''"]
    params: list[Any] = []
    if map_name:
        where.append("LOWER(TRIM(COALESCE(d.map_name, ''))) = LOWER(TRIM(?))")
        params.append(map_name)
    if group_id != "all":
        where.append(
            "EXISTS (SELECT 1 FROM player_archive_memberships m "
            f"WHERE m.player_key = ({identity}) AND m.group_id = ?)"
        )
        params.append(group_id)
    sql = f"""
        SELECT ps.demo_id, ps.steam_id64, ps.account_id, ps.user_id,
               ps.player_name, ps.normalized_name, ps.team_name, ps.kills, ps.deaths, ps.assists,
               d.filename, d.display_name, d.map_name, d.total_rounds,
               d.team_a_score, d.team_b_score, d.match_date, d.added_at, d.status, d.content_md5,
               ({identity}) AS player_key
        FROM demo_player_stats ps
        JOIN demo_files d ON d.id = ps.demo_id
        WHERE {' AND '.join(where)}
    """
    async with aiosqlite.connect(db_path) as conn:
        conn.row_factory = aiosqlite.Row
        cursor = await conn.execute(sql, params)
        return [dict(row) for row in await cursor.fetchall()]


async def _load_memberships(db_path: Path) -> dict[str, list[str]]:
    async with aiosqlite.connect(db_path) as conn:
        cursor = await conn.execute(
            "SELECT player_key, group_id FROM player_archive_memberships ORDER BY group_id"
        )
        result: dict[str, list[str]] = {}
        for player_key, group_id in await cursor.fetchall():
            result.setdefault(str(player_key), []).append(str(group_id))
        return result


async def _load_player_settings(db_path: Path) -> dict[str, dict[str, bool]]:
    async with aiosqlite.connect(db_path) as conn:
        cursor = await conn.execute(
            "SELECT player_key, imported, blocked, pinned FROM player_archive_settings"
        )
        return {
            str(player_key): {
                "imported": bool(imported),
                "blocked": bool(blocked),
                "pinned": bool(pinned),
            }
            for player_key, imported, blocked, pinned in await cursor.fetchall()
        }


async def _folder_counts(db_path: Path) -> dict[str, int]:
    players = await _load_roster_rows(db_path)
    keys = {str(row["player_key"]) for row in players}
    settings = await _load_player_settings(db_path)
    memberships = await _load_memberships(db_path)
    counts = {"all": 0, "candidates": 0, "blocked": 0, **{group: 0 for group in PLAYER_GROUPS}}
    for player_key in keys:
        state = settings.get(player_key, {})
        if state.get("blocked"):
            counts["blocked"] += 1
        elif state.get("imported"):
            counts["all"] += 1
            for group in memberships.get(player_key, []):
                counts[group] += 1
        else:
            counts["candidates"] += 1
    return counts


async def list_player_profiles(
    db_path: Path,
    *,
    group_id: str = "all",
    view: str = "all",
    query: str = "",
    map_name: str = "",
) -> dict[str, Any]:
    rows = _deduplicate_matches(await _load_roster_rows(db_path, map_name=map_name))
    memberships = await _load_memberships(db_path)
    settings = await _load_player_settings(db_path)
    players = _aggregate(rows, memberships)
    for player in players:
        state = settings.get(player["player_key"], {})
        player.update({
            "imported": state.get("imported", False),
            "blocked": state.get("blocked", False),
            "pinned": state.get("pinned", False),
        })
    if view == "archive":
        players = [player for player in players if player["imported"] and not player["blocked"]]
    elif view == "candidates":
        players = [player for player in players if not player["imported"] and not player["blocked"]]
    elif view == "blocked":
        players = [player for player in players if player["blocked"]]
    elif view != "all":
        raise ValueError("Unknown player archive view")
    if group_id != "all":
        players = [player for player in players if group_id in player["groups"]]
    search = query.strip().casefold()
    if search:
        players = [player for player in players if (
            search in player["display_name"].casefold()
            or search in str(player.get("steam_id64") or "").casefold()
            or any(search in alias.casefold() for alias in player["aliases"])
        )]
    players.sort(key=lambda player: (
        not bool(player.get("pinned")),
        -int(player.get("demo_count") or 0),
        str(player.get("display_name") or "").casefold(),
        player["player_key"],
    ))
    return {
        "players": [{key: value for key, value in player.items() if key != "matches"} for player in players],
        "groups": list(PLAYER_GROUPS),
        "group_counts": await _folder_counts(db_path),
        "maps": await list_maps(db_path),
        "total": len(players),
    }


async def get_player_profile(db_path: Path, player_key: str) -> dict[str, Any] | None:
    rows = _deduplicate_matches(await _load_roster_rows(db_path))
    selected = [row for row in rows if str(row.get("player_key")) == player_key]
    if not selected:
        return None
    memberships = await _load_memberships(db_path)
    settings = await _load_player_settings(db_path)
    players = _aggregate(selected, memberships)
    if not players:
        return None
    profile = players[0]
    profile.update(settings.get(player_key, {"imported": False, "blocked": False, "pinned": False}))
    analysis_matches = await _load_analysis_matches(db_path, player_key, selected)
    profile["analysis_matches"] = analysis_matches
    profile["analysis_summary"] = _summarize_analysis(analysis_matches)
    return profile


async def get_player_match_workspace(
    db_path: Path,
    player_key: str,
    demo_id: int,
) -> dict[str, Any] | None:
    """Load one already-saved analysis workspace for the selected player and Demo."""
    identity = _identity_sql("ps")
    async with aiosqlite.connect(db_path) as conn:
        conn.row_factory = aiosqlite.Row
        cursor = await conn.execute(
            f"""
            SELECT ps.steam_id64, ps.account_id, ps.user_id, ps.player_name,
                   ps.normalized_name, d.id AS demo_id, d.path AS demo_path,
                   d.status, r.result_json
            FROM demo_player_stats ps
            JOIN demo_files d ON d.id = ps.demo_id
            LEFT JOIN match_results r ON r.id = (
                SELECT MAX(latest.id) FROM match_results latest WHERE latest.demo_path = d.path
            )
            WHERE ps.demo_id = ? AND ({identity}) = ?
            ORDER BY ps.id
            LIMIT 1
            """,
            (int(demo_id), player_key),
        )
        row = await cursor.fetchone()
    if not row:
        return None

    data = dict(row)
    workspace: dict[str, Any] = {}
    if data.get("result_json"):
        try:
            result = json.loads(str(data["result_json"]))
            candidate = result.get("analysis_workspace") if isinstance(result, dict) else None
            if isinstance(candidate, dict):
                workspace = candidate
        except (TypeError, ValueError, json.JSONDecodeError):
            workspace = {}
    workspace_players = [
        player for player in (workspace.get("players") or []) if isinstance(player, dict)
    ]
    match_player = _workspace_player_for_roster(workspace_players, data) if workspace else None
    required_metrics = {"adr", "kast", "first_kills", "first_deaths", "trade_kills", "clutch_attempts", "clutch_wins", "utility_damage"}
    if not match_player or not required_metrics.issubset(match_player):
        return {
            "available": False,
            "demo_id": int(demo_id),
            "player_key": player_key,
            "status": str(data.get("status") or ""),
            "map_name": str(workspace.get("map_name") or ""),
        }
    selected_player_key = str(match_player.get("player_key") or "").strip()
    if not selected_player_key:
        selected_steam_id = str(match_player.get("steam_id64") or match_player.get("steamid64") or "").strip()
        selected_player_key = f"steamid:{selected_steam_id}" if selected_steam_id else str(match_player.get("name") or "").strip()
    return {
        "available": True,
        "demo_id": int(demo_id),
        "player_key": player_key,
        "demo_path": str(data.get("demo_path") or ""),
        "map_name": str(workspace.get("map_name") or ""),
        "selected_player_key": selected_player_key,
        "workspace": workspace,
        "metrics": _analysis_metrics(match_player, len(workspace.get("rounds") or []), workspace),
        "evidence": _player_event_evidence(workspace, match_player, data),
    }


async def list_maps(db_path: Path) -> list[str]:
    async with aiosqlite.connect(db_path) as conn:
        cursor = await conn.execute(
            """
            SELECT DISTINCT TRIM(d.map_name)
            FROM demo_files d JOIN demo_player_stats ps ON ps.demo_id = d.id
            WHERE d.map_name IS NOT NULL AND TRIM(d.map_name) <> ''
            ORDER BY LOWER(TRIM(d.map_name))
            """
        )
        return [str(row[0]) for row in await cursor.fetchall()]


async def set_player_groups(db_path: Path, player_key: str, group_ids: list[str]) -> bool:
    if any(group not in PLAYER_GROUPS for group in group_ids):
        raise ValueError("Unknown player archive group")
    identity = _identity_sql("ps")
    async with aiosqlite.connect(db_path) as conn:
        cursor = await conn.execute(
            f"""
            SELECT 1 FROM demo_player_stats ps JOIN demo_files d ON d.id = ps.demo_id
            WHERE ({identity}) = ? LIMIT 1
            """,
            (player_key,),
        )
        if not await cursor.fetchone():
            return False
        await conn.execute("DELETE FROM player_archive_memberships WHERE player_key = ?", (player_key,))
        if group_ids:
            await conn.executemany(
                "INSERT INTO player_archive_memberships(player_key, group_id) VALUES (?, ?)",
                [(player_key, group) for group in dict.fromkeys(group_ids)],
            )
        await conn.execute(
            """
            INSERT INTO player_archive_settings(player_key, imported, blocked)
            VALUES (?, 1, 0)
            ON CONFLICT(player_key) DO UPDATE SET imported = 1, blocked = 0,
                updated_at = CURRENT_TIMESTAMP
            """,
            (player_key,),
        )
        await conn.commit()
    return True


async def set_player_imported(db_path: Path, player_key: str, imported: bool) -> bool:
    identity = _identity_sql("ps")
    async with aiosqlite.connect(db_path) as conn:
        cursor = await conn.execute(
            f"""
            SELECT 1 FROM demo_player_stats ps JOIN demo_files d ON d.id = ps.demo_id
            WHERE ({identity}) = ? LIMIT 1
            """,
            (player_key,),
        )
        if not await cursor.fetchone():
            return False
        await conn.execute(
            """
            INSERT INTO player_archive_settings(player_key, imported, blocked)
            VALUES (?, ?, 0)
            ON CONFLICT(player_key) DO UPDATE SET imported = excluded.imported,
                blocked = CASE WHEN excluded.imported = 1 THEN 0 ELSE player_archive_settings.blocked END,
                updated_at = CURRENT_TIMESTAMP
            """,
            (player_key, int(imported)),
        )
        await conn.commit()
    return True


async def set_player_blocked(db_path: Path, player_key: str, blocked: bool) -> bool:
    identity = _identity_sql("ps")
    async with aiosqlite.connect(db_path) as conn:
        cursor = await conn.execute(
            f"""
            SELECT 1 FROM demo_player_stats ps JOIN demo_files d ON d.id = ps.demo_id
            WHERE ({identity}) = ? LIMIT 1
            """,
            (player_key,),
        )
        if not await cursor.fetchone():
            return False
        await conn.execute(
            """
            INSERT INTO player_archive_settings(player_key, imported, blocked)
            VALUES (?, 0, ?)
            ON CONFLICT(player_key) DO UPDATE SET
                imported = CASE WHEN excluded.blocked = 1 THEN 0 ELSE player_archive_settings.imported END,
                blocked = excluded.blocked,
                updated_at = CURRENT_TIMESTAMP
            """,
            (player_key, int(blocked)),
        )
        await conn.commit()
    return True


async def set_player_pinned(db_path: Path, player_key: str, pinned: bool) -> bool:
    async with aiosqlite.connect(db_path) as conn:
        cursor = await conn.execute(
            "SELECT imported, blocked FROM player_archive_settings WHERE player_key = ?",
            (player_key,),
        )
        state = await cursor.fetchone()
        if not state or not bool(state[0]) or bool(state[1]):
            return False
        await conn.execute(
            "UPDATE player_archive_settings SET pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE player_key = ?",
            (int(pinned), player_key),
        )
        await conn.commit()
    return True
