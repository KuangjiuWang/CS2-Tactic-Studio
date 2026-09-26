import asyncio
import hashlib

import pytest
from fastapi import HTTPException

from app.features.tactical_playbook import api
from app.features.tactical_playbook.storage import TacticalStore


def _create_tactic(store, demo_path, digest=None):
    return store.create_tactic(
        name="Mirage T", map_name="de_mirage", side="T", demo_path=str(demo_path),
        round_number=1, round_start_tick=100, freeze_end_tick=200, round_end_tick=900,
        source_demo_hash=digest,
        metadata={"analysis_workspace": {"map_name": "de_mirage", "rounds": []}},
    )


def test_relink_requires_the_same_hashed_demo(tmp_path, monkeypatch):
    async def scenario():
        store = TacticalStore(tmp_path / "tactics.db")
        original = tmp_path / "old.dem"
        moved = tmp_path / "new.dem"
        wrong = tmp_path / "other.dem"
        original.write_bytes(b"same demo bytes")
        moved.write_bytes(b"same demo bytes")
        wrong.write_bytes(b"different match")
        digest = hashlib.sha256(original.read_bytes()).hexdigest()
        tactic = await _create_tactic(store, original, digest)
        monkeypatch.setattr(api, "TacticalStore", lambda: store)

        result = await api.relink_source_demo(tactic["id"], api.RelinkSourceDemo(demo_path=str(moved)))
        assert result["source_demo_path"] == str(moved.resolve())
        assert result["source_demo_hash"] == digest
        assert result["source_demo_available"] is True
        with pytest.raises(HTTPException) as error:
            await api.relink_source_demo(tactic["id"], api.RelinkSourceDemo(demo_path=str(wrong)))
        assert error.value.status_code == 409

    asyncio.run(scenario())


def test_legacy_missing_demo_requires_explicit_confirmation(tmp_path, monkeypatch):
    async def scenario():
        store = TacticalStore(tmp_path / "legacy.db")
        missing = tmp_path / "missing.dem"
        selected = tmp_path / "selected.dem"
        selected.write_bytes(b"legacy source")
        tactic = await _create_tactic(store, missing)
        monkeypatch.setattr(api, "TacticalStore", lambda: store)

        with pytest.raises(HTTPException) as error:
            await api.relink_source_demo(tactic["id"], api.RelinkSourceDemo(demo_path=str(selected)))
        assert error.value.status_code == 409
        assert error.value.detail["code"] == "DEMO_UNVERIFIED"

        result = await api.relink_source_demo(
            tactic["id"], api.RelinkSourceDemo(demo_path=str(selected), allow_unverified=True),
        )
        assert result["source_demo_path"] == str(selected.resolve())
        assert result["source_demo_hash"] == hashlib.sha256(selected.read_bytes()).hexdigest()

    asyncio.run(scenario())


def test_recording_batch_is_linked_to_saved_draft_before_it_runs(tmp_path, monkeypatch):
    async def scenario():
        store = TacticalStore(tmp_path / "recovery.db")
        demo = tmp_path / "match.dem"
        demo.write_bytes(b"demo")
        tactic = await _create_tactic(store, demo)
        monkeypatch.setattr(api, "TacticalStore", lambda: store)
        monkeypatch.setattr(api, "_jobs", lambda _: [])
        monkeypatch.setattr(api, "_persist_batch", lambda _: None)
        monkeypatch.setattr(api, "_batches", {})
        monkeypatch.setattr(api, "_batch_tasks", set())
        monkeypatch.setattr(api, "_active_batch", None)

        async def finish_batch(*_args):
            return None

        monkeypatch.setattr(api, "_run_batch", finish_batch)
        selection = api.RoundSelection(
            demo_path=str(demo), analysis_workspace={"map_name": "de_mirage", "tick_rate": 64},
            round_number=1, side="T", tactic_id=tactic["id"],
        )
        batch = await api.prepare_povs(selection)
        saved = await store.get_tactic(tactic["id"])
        assert batch["tactic_id"] == tactic["id"]
        assert saved["metadata"]["pov_batch_id"] == batch["id"]
        await asyncio.gather(*list(api._batch_tasks))

    asyncio.run(scenario())
