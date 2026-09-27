import asyncio
import pytest
from fastapi import HTTPException

from app.features.tactical_playbook import api
from app.features.tactical_playbook.storage import TacticalStore


def _make_tactic(store: TacticalStore, *, batch_id: str):
    return store.create_tactic(
        name="Mirage split", map_name="de_mirage", side="T", demo_path="match.dem",
        round_number=1, round_start_tick=100, freeze_end_tick=200, round_end_tick=900,
        metadata={"pov_batch_id": batch_id},
    )


def test_delete_tactic_can_also_remove_its_local_pov_batch(tmp_path, monkeypatch):
    async def scenario():
        batch_id = "a" * 32
        data_dir = tmp_path / "data"
        source_demo = tmp_path / "match.dem"
        source_demo.write_bytes(b"keep demo")
        batch_dir = data_dir / "tactical-povs" / batch_id
        batch_dir.mkdir(parents=True)
        (batch_dir / "player1.mp4").write_bytes(b"full quality")
        (batch_dir / "player1-proxy.mp4").write_bytes(b"preview")
        (batch_dir / "metadata.json").write_text("{}", encoding="utf-8")

        store = TacticalStore(tmp_path / "tactical.db")
        tactic = await _make_tactic(store, batch_id=batch_id)
        monkeypatch.setattr(api, "TacticalStore", lambda: store)
        monkeypatch.setattr(api, "get_data_dir", lambda: data_dir)
        monkeypatch.setattr(api, "_active_batch", None)

        result = await api.delete_tactic(
            tactic["id"], api.DeleteTacticRequest(delete_pov_videos=True),
        )

        assert result["pov_media"] == {"status": "deleted", "files": 3, "bytes": 21}
        assert not batch_dir.exists()
        assert source_demo.read_bytes() == b"keep demo"
        assert await store.get_tactic(tactic["id"]) is None

    asyncio.run(scenario())


def test_delete_keeps_a_pov_batch_still_referenced_by_another_tactic(tmp_path, monkeypatch):
    async def scenario():
        batch_id = "b" * 32
        data_dir = tmp_path / "data"
        batch_dir = data_dir / "tactical-povs" / batch_id
        batch_dir.mkdir(parents=True)
        (batch_dir / "player1.mp4").write_bytes(b"shared pov")

        store = TacticalStore(tmp_path / "tactical.db")
        first = await _make_tactic(store, batch_id=batch_id)
        second = await _make_tactic(store, batch_id=batch_id)
        monkeypatch.setattr(api, "TacticalStore", lambda: store)
        monkeypatch.setattr(api, "get_data_dir", lambda: data_dir)
        monkeypatch.setattr(api, "_active_batch", None)

        result = await api.delete_tactic(
            first["id"], api.DeleteTacticRequest(delete_pov_videos=True),
        )

        assert result["pov_media"]["status"] == "in_use"
        assert batch_dir.exists()
        assert await store.get_tactic(first["id"]) is None
        assert await store.get_tactic(second["id"]) is not None

    asyncio.run(scenario())


def test_delete_will_not_remove_a_batch_while_it_is_recording(tmp_path, monkeypatch):
    async def scenario():
        batch_id = "c" * 32
        store = TacticalStore(tmp_path / "tactical.db")
        tactic = await _make_tactic(store, batch_id=batch_id)
        monkeypatch.setattr(api, "TacticalStore", lambda: store)
        monkeypatch.setattr(api, "_active_batch", batch_id)

        with pytest.raises(HTTPException) as exc:
            await api.delete_tactic(
                tactic["id"], api.DeleteTacticRequest(delete_pov_videos=True),
            )
        assert exc.value.status_code == 409
        assert await store.get_tactic(tactic["id"]) is not None

    asyncio.run(scenario())
