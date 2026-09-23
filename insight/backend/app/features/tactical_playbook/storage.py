"""SQLite-backed Demo → Round → Side → Tactic → Step records."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import aiosqlite

from ...env_utils import resolve_config_path


def database_path() -> Path:
    return resolve_config_path().parent / "cs2-insight.db"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TacticalStore:
    def __init__(self, path: Path | None = None):
        self.path = path or database_path()

    async def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA foreign_keys = ON")
            await db.executescript("""
                CREATE TABLE IF NOT EXISTS tactical_folders (
                    id TEXT PRIMARY KEY, parent_id TEXT REFERENCES tactical_folders(id),
                    name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tactical_tactics (
                    id TEXT PRIMARY KEY, folder_id TEXT REFERENCES tactical_folders(id),
                    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
                    map_name TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('T','CT')),
                    source_demo_path TEXT NOT NULL, source_demo_hash TEXT,
                    round_number INTEGER NOT NULL, round_start_tick INTEGER NOT NULL,
                    freeze_end_tick INTEGER NOT NULL, round_end_tick INTEGER NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tactical_steps (
                    id TEXT PRIMARY KEY, tactic_id TEXT NOT NULL REFERENCES tactical_tactics(id) ON DELETE CASCADE,
                    step_number INTEGER NOT NULL, tick INTEGER NOT NULL,
                    title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
                    annotations_json TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    UNIQUE(tactic_id, step_number)
                );
                CREATE TABLE IF NOT EXISTS tactical_povs (
                    id TEXT PRIMARY KEY, tactic_id TEXT NOT NULL REFERENCES tactical_tactics(id) ON DELETE CASCADE,
                    player_name TEXT NOT NULL, steam_id64 TEXT NOT NULL,
                    start_tick INTEGER NOT NULL, end_tick INTEGER NOT NULL,
                    video_path TEXT, proxy_path TEXT, status TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_tactical_tactics_folder ON tactical_tactics(folder_id);
            """)
            await db.commit()

    async def create_folder(self, name: str, parent_id: str | None = None) -> dict:
        await self.initialize()
        if not name.strip():
            raise ValueError("folder name is required")
        row = {"id": uuid4().hex, "parent_id": parent_id, "name": name.strip(), "sort_order": 0,
               "created_at": _now(), "updated_at": _now()}
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA foreign_keys = ON")
            await db.execute("INSERT INTO tactical_folders VALUES (:id,:parent_id,:name,:sort_order,:created_at,:updated_at)", row)
            await db.commit()
        return row

    async def move_folder(self, folder_id: str, parent_id: str | None) -> None:
        await self.initialize()
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA foreign_keys = ON")
            if parent_id == folder_id:
                raise ValueError("folder cannot be its own parent")
            current = parent_id
            while current:
                if current == folder_id:
                    raise ValueError("folder cannot move into its descendant")
                cursor = await db.execute("SELECT parent_id FROM tactical_folders WHERE id=?", (current,))
                row = await cursor.fetchone()
                if row is None:
                    raise ValueError("parent folder does not exist")
                current = row[0]
            result = await db.execute("UPDATE tactical_folders SET parent_id=?,updated_at=? WHERE id=?", (parent_id, _now(), folder_id))
            if result.rowcount != 1:
                raise ValueError("folder does not exist")
            await db.commit()

    async def create_tactic(self, *, name: str, map_name: str, side: str, demo_path: str,
                            round_number: int, round_start_tick: int, freeze_end_tick: int,
                            round_end_tick: int, folder_id: str | None = None,
                            metadata: dict | None = None) -> dict:
        await self.initialize()
        if not name.strip() or side not in {"T", "CT"}:
            raise ValueError("tactic name and T/CT side are required")
        row = {"id": uuid4().hex, "folder_id": folder_id, "name": name.strip(),
               "description": "", "map_name": map_name, "side": side,
               "source_demo_path": demo_path, "source_demo_hash": None,
               "round_number": round_number, "round_start_tick": round_start_tick,
               "freeze_end_tick": freeze_end_tick, "round_end_tick": round_end_tick,
               "metadata_json": json.dumps(metadata or {}, ensure_ascii=False),
               "created_at": _now(), "updated_at": _now()}
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA foreign_keys = ON")
            await db.execute("""INSERT INTO tactical_tactics VALUES
                (:id,:folder_id,:name,:description,:map_name,:side,:source_demo_path,:source_demo_hash,
                 :round_number,:round_start_tick,:freeze_end_tick,:round_end_tick,:metadata_json,:created_at,:updated_at)""", row)
            await db.commit()
        return {**row, "metadata": metadata or {}}

    async def add_step(self, tactic_id: str, tick: int, title: str = "", note: str = "",
                       annotations: list | None = None) -> dict:
        await self.initialize()
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA foreign_keys = ON")
            cur = await db.execute("SELECT COALESCE(MAX(step_number),0)+1 FROM tactical_steps WHERE tactic_id=?", (tactic_id,))
            number = int((await cur.fetchone())[0])
            row = {"id": uuid4().hex, "tactic_id": tactic_id, "step_number": number,
                   "tick": tick, "title": title, "note": note,
                   "annotations_json": json.dumps(annotations or [], ensure_ascii=False),
                   "created_at": _now(), "updated_at": _now()}
            await db.execute("""INSERT INTO tactical_steps VALUES
                (:id,:tactic_id,:step_number,:tick,:title,:note,:annotations_json,:created_at,:updated_at)""", row)
            await db.commit()
        return {**row, "annotations": annotations or []}

    async def update_step(self, tactic_id: str, step_id: str, *, title: str, note: str,
                          annotations: list) -> dict:
        await self.initialize()
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA foreign_keys = ON")
            cur = await db.execute("""UPDATE tactical_steps
                SET title=?,note=?,annotations_json=?,updated_at=?
                WHERE id=? AND tactic_id=?""",
                (title, note, json.dumps(annotations, ensure_ascii=False), _now(), step_id, tactic_id))
            if cur.rowcount != 1:
                raise ValueError("step does not belong to this tactic")
            await db.commit()
        tactic = await self.get_tactic(tactic_id)
        return next(step for step in tactic["steps"] if step["id"] == step_id)

    async def delete_step(self, tactic_id: str, step_id: str) -> None:
        await self.initialize()
        async with aiosqlite.connect(self.path) as db:
            cur = await db.execute("DELETE FROM tactical_steps WHERE id=? AND tactic_id=?", (step_id, tactic_id))
            if cur.rowcount != 1:
                raise ValueError("step does not belong to this tactic")
            await db.commit()

    async def move_tactic(self, tactic_id: str, folder_id: str | None) -> None:
        await self.initialize()
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA foreign_keys = ON")
            if folder_id is not None:
                cursor = await db.execute("SELECT 1 FROM tactical_folders WHERE id=?", (folder_id,))
                if await cursor.fetchone() is None:
                    raise ValueError("destination folder does not exist")
            cur = await db.execute("UPDATE tactical_tactics SET folder_id=?,updated_at=? WHERE id=?", (folder_id, _now(), tactic_id))
            if cur.rowcount != 1:
                raise ValueError("tactic does not exist")
            await db.commit()

    async def list_tree(self) -> dict:
        await self.initialize()
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            folders = [dict(row) async for row in await db.execute("SELECT * FROM tactical_folders ORDER BY sort_order,name")]
            tactics = [dict(row) async for row in await db.execute("SELECT * FROM tactical_tactics ORDER BY updated_at DESC")]
        for tactic in tactics:
            tactic["metadata"] = json.loads(tactic.pop("metadata_json"))
        return {"folders": folders, "tactics": tactics}

    async def get_tactic(self, tactic_id: str) -> dict | None:
        await self.initialize()
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM tactical_tactics WHERE id=?", (tactic_id,))
            row = await cur.fetchone()
            if row is None:
                return None
            tactic = dict(row)
            tactic["metadata"] = json.loads(tactic.pop("metadata_json"))
            tactic["steps"] = [dict(step) async for step in await db.execute(
                "SELECT * FROM tactical_steps WHERE tactic_id=? ORDER BY step_number", (tactic_id,))]
            for step in tactic["steps"]:
                step["annotations"] = json.loads(step.pop("annotations_json"))
            tactic["povs"] = [dict(pov) async for pov in await db.execute(
                "SELECT * FROM tactical_povs WHERE tactic_id=?", (tactic_id,))]
            return tactic
