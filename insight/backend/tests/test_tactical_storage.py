import asyncio

import pytest

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


def test_folder_cycle_rejected(tmp_path):
    asyncio.run(_folder_cycle_rejected(tmp_path))


async def _folder_cycle_rejected(tmp_path):
    store = TacticalStore(tmp_path / "playbook.db")
    parent = await store.create_folder("Parent")
    child = await store.create_folder("Child", parent["id"])
    with pytest.raises(ValueError, match="descendant"):
        await store.move_folder(parent["id"], child["id"])
