import asyncio

import pytest
import sqlite3

from app.features.tactical_playbook.storage import TacticalStore


def test_tactic_steps_survive_reopen(tmp_path):
    asyncio.run(_tactic_steps_survive_reopen(tmp_path))


async def _tactic_steps_survive_reopen(tmp_path):
    path = tmp_path / "playbook.db"
    store = TacticalStore(path)
    folder = await store.create_folder("Mirage")
    tactic = await store.create_tactic(
        name="A split", map_name="de_mirage", side="T", demo_path="match.dem",
        round_number=13, round_start_tick=100, freeze_end_tick=200,
        round_end_tick=900, folder_id=folder["id"],
    )
    await store.add_step(tactic["id"], 250, "Setup", annotations=[{"kind": "arrow"}])
    reopened = await TacticalStore(path).get_tactic(tactic["id"])
    assert reopened["side"] == "T"
    assert reopened["steps"][0]["tick"] == 250
    assert reopened["steps"][0]["annotations"] == [{"kind": "arrow"}]
    step_id = reopened["steps"][0]["id"]
    await store.update_step(tactic["id"], step_id, title="Execute", note="Flash first", annotations=[])
    assert (await TacticalStore(path).get_tactic(tactic["id"]))["steps"][0]["note"] == "Flash first"
    await store.delete_step(tactic["id"], step_id)
    assert (await TacticalStore(path).get_tactic(tactic["id"]))["steps"] == []


def test_folder_cycle_rejected(tmp_path):
    asyncio.run(_folder_cycle_rejected(tmp_path))


async def _folder_cycle_rejected(tmp_path):
    store = TacticalStore(tmp_path / "playbook.db")
    parent = await store.create_folder("Parent")
    child = await store.create_folder("Child", parent["id"])
    with pytest.raises(ValueError, match="descendant"):
        await store.move_folder(parent["id"], child["id"])


def test_tactic_can_move_between_folders(tmp_path):
    asyncio.run(_tactic_can_move_between_folders(tmp_path))


def test_tactic_source_demo_can_be_relinked(tmp_path):
    async def scenario():
        store = TacticalStore(tmp_path / "relink.db")
        tactic = await store.create_tactic(
            name="B split", map_name="de_mirage", side="T", demo_path="old.dem",
            round_number=1, round_start_tick=1, freeze_end_tick=10, round_end_tick=100,
            source_demo_hash="old-hash",
        )
        await store.relink_source_demo(tactic["id"], "new.dem", "new-hash")
        reopened = await TacticalStore(store.path).get_tactic(tactic["id"])
        assert reopened["source_demo_path"] == "new.dem"
        assert reopened["source_demo_hash"] == "new-hash"

    asyncio.run(scenario())


def test_tactic_classification_persists_without_replacing_recording_metadata(tmp_path):
    async def scenario():
        store = TacticalStore(tmp_path / "classification.db")
        tactic = await store.create_tactic(
            name="B execute", map_name="de_mirage", side="T", demo_path="match.dem",
            round_number=4, round_start_tick=100, freeze_end_tick=200, round_end_tick=900,
            metadata={"pov_batch_id": "local-batch", "source_match": "Alpha vs Bravo"},
        )
        updated = await store.update_classification(tactic["id"], {
            "category": "execute", "site": "B", "utility": ["smoke", "flash", "smoke"],
            "result": "win", "tags": ["  fast  ", "FAST", "late flash"],
        })
        assert updated["metadata"]["pov_batch_id"] == "local-batch"
        assert updated["metadata"]["source_match"] == "Alpha vs Bravo"
        assert updated["metadata"]["classification"] == {
            "category": "execute", "site": "B", "utility": ["smoke", "flash"],
            "result": "win", "tags": ["fast", "late flash"],
        }
        with pytest.raises(ValueError, match="tactic does not exist"):
            await store.update_classification("missing", {"category": None, "site": None, "utility": [], "result": None, "tags": []})

    asyncio.run(scenario())


async def _tactic_can_move_between_folders(tmp_path):
    store = TacticalStore(tmp_path / "playbook.db")
    folder = await store.create_folder("T side")
    tactic = await store.create_tactic(
        name="B split", map_name="de_mirage", side="T", demo_path="match.dem",
        round_number=1, round_start_tick=1, freeze_end_tick=10, round_end_tick=100,
    )
    await store.move_tactic(tactic["id"], folder["id"])
    assert (await TacticalStore(store.path).get_tactic(tactic["id"]))["folder_id"] == folder["id"]


def test_collections_migration_removal_and_recursive_delete(tmp_path):
    async def scenario():
        store = TacticalStore(tmp_path / "legacy.db")
        parent = await store.create_folder("Training")
        child = await store.create_folder("Mirage", parent["id"])
        other = await store.create_folder("Anti-Strat")
        tactic = await store.create_tactic(name="Spirit A Split", map_name="de_mirage", side="T", demo_path="match.dem",
            round_number=17, round_start_tick=100, freeze_end_tick=200, round_end_tick=900, folder_id=child["id"])
        # Reconstruct pre-migration schema/data, preserving the legacy folder_id.
        with sqlite3.connect(store.path) as db:
            db.execute("DROP TABLE tactical_folder_tactics")
            db.execute("DROP TABLE tactical_migrations")
        reopened = TacticalStore(store.path)
        assert (await reopened.get_tactic(tactic["id"]))["folder_ids"] == [child["id"]]
        await reopened.set_folders(tactic["id"], [child["id"], other["id"], child["id"]])
        assert len((await reopened.list_tree())["tactics"]) == 1
        assert len((await reopened.get_tactic(tactic["id"]))["folder_ids"]) == 2
        with pytest.raises(ValueError, match="folder does not exist"):
            await reopened.set_folders(tactic["id"], ["missing"])
        assert len((await reopened.get_tactic(tactic["id"]))["folder_ids"]) == 2
        await reopened.set_folders(tactic["id"], [other["id"]])
        assert (await TacticalStore(store.path).get_tactic(tactic["id"]))["folder_ids"] == [other["id"]]
        await reopened.set_folders(tactic["id"], [child["id"], other["id"]])
        await reopened.delete_folder(parent["id"])
        tree = await TacticalStore(store.path).list_tree()
        assert len(tree["tactics"]) == 1
        assert [f["id"] for f in tree["folders"]] == [other["id"]]
        assert tree["tactics"][0]["folder_ids"] == [other["id"]]
        await reopened.rename("tactics", tactic["id"], "Updated")
        assert (await reopened.get_tactic(tactic["id"]))["name"] == "Updated"
        await reopened.delete_tactic(tactic["id"])
        assert (await reopened.list_tree())["memberships"] == []
    asyncio.run(scenario())


def test_portable_import_validates_before_writing_and_preserves_steps(tmp_path):
    async def scenario():
        store = TacticalStore(tmp_path / "import.db")
        data = dict(name="A", map_name="de_mirage", side="T", source_demo_path="match.dem",
                    round_number=1, round_start_tick=100, freeze_end_tick=200, round_end_tick=900,
                    metadata={"pov_batch_id": "local-only"}, steps=[dict(tick=1000)])
        with pytest.raises(ValueError):
            await store.import_tactic(data)
        assert (await store.list_tree())["tactics"] == []
        data["steps"] = [dict(tick=300, title="Execute", annotations=[{"type": "arrow"}])]
        tactic = await store.import_tactic(data)
        assert tactic["steps"][0]["title"] == "Execute"
        assert tactic["metadata"].get("pov_batch_id") is None
        copy = await store.import_tactic(tactic)
        assert copy["id"] != tactic["id"]
        assert copy["steps"][0]["id"] != tactic["steps"][0]["id"]
    asyncio.run(scenario())
