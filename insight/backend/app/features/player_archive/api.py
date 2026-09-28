"""API for the local, cross-demo player archive."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ...databases import demo_db
from .storage import (
    PLAYER_GROUPS,
    get_player_profile,
    get_player_match_workspace,
    initialize_player_archive,
    list_maps,
    list_player_profiles,
    set_player_blocked,
    set_player_groups,
    set_player_imported,
    set_player_pinned,
)

router = APIRouter(tags=["player-archive"])
PlayerGroup = Literal["professional", "amateur", "squad"]


class PlayerMembershipBody(BaseModel):
    player_key: str = Field(min_length=1, max_length=300)
    group_ids: list[PlayerGroup] = Field(default_factory=list, max_length=3)


class PlayerImportBody(BaseModel):
    player_key: str = Field(min_length=1, max_length=300)
    imported: bool = True


class PlayerBlockedBody(BaseModel):
    player_key: str = Field(min_length=1, max_length=300)
    blocked: bool = True


class PlayerPinBody(BaseModel):
    player_key: str = Field(min_length=1, max_length=300)
    pinned: bool


async def initialize_player_archive_db() -> None:
    await initialize_player_archive(demo_db.db_path)


@router.get("/api/player-archive")
async def list_player_archive(
    group: Literal["all", "professional", "amateur", "squad"] = "all",
    view: Literal["archive", "candidates", "blocked"] = "archive",
    q: str = Query(default="", max_length=100),
    map_name: str = Query(default="", max_length=100),
):
    if group not in ("all", *PLAYER_GROUPS):
        raise HTTPException(422, "Unknown player group")
    return await list_player_profiles(
        demo_db.db_path,
        group_id=group,
        view=view,
        query=q,
        map_name=map_name,
    )


@router.get("/api/player-archive/maps")
async def list_player_archive_maps():
    return {"maps": await list_maps(demo_db.db_path)}


@router.get("/api/player-archive/matches/{demo_id}/analysis")
async def get_player_archive_match_analysis(
    demo_id: int,
    player_key: str = Query(..., min_length=1, max_length=300),
):
    analysis = await get_player_match_workspace(demo_db.db_path, player_key, demo_id)
    if analysis is None:
        raise HTTPException(404, "Player or Demo match not found")
    return analysis


@router.get("/api/player-archive/players/{player_key:path}")
async def get_player_archive_profile(player_key: str):
    profile = await get_player_profile(demo_db.db_path, player_key)
    if profile is None:
        raise HTTPException(404, "Player profile not found")
    return profile


@router.put("/api/player-archive/membership")
async def update_player_archive_membership(body: PlayerMembershipBody):
    found = await set_player_groups(
        demo_db.db_path,
        body.player_key,
        list(dict.fromkeys(body.group_ids)),
    )
    if not found:
        raise HTTPException(404, "Player profile not found")
    profile = await get_player_profile(demo_db.db_path, body.player_key)
    return {"player_key": body.player_key, "groups": profile["groups"] if profile else []}


@router.put("/api/player-archive/import")
async def update_player_archive_import(body: PlayerImportBody):
    found = await set_player_imported(demo_db.db_path, body.player_key, body.imported)
    if not found:
        raise HTTPException(404, "Player profile not found")
    return {"player_key": body.player_key, "imported": body.imported}


@router.put("/api/player-archive/blocked")
async def update_player_archive_blocked(body: PlayerBlockedBody):
    found = await set_player_blocked(demo_db.db_path, body.player_key, body.blocked)
    if not found:
        raise HTTPException(404, "Player profile not found")
    return {"player_key": body.player_key, "blocked": body.blocked}


@router.put("/api/player-archive/pin")
async def update_player_archive_pin(body: PlayerPinBody):
    found = await set_player_pinned(demo_db.db_path, body.player_key, body.pinned)
    if not found:
        raise HTTPException(404, "Imported player profile not found")
    return {"player_key": body.player_key, "pinned": body.pinned}
