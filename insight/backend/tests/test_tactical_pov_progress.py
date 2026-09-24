"""A completed recording becomes watchable before the next player finishes."""

import asyncio
import json
from fastapi import HTTPException
from app.runtime_session import runtime_session_state

from app.features.tactical_playbook import api


def test_first_pov_is_ready_while_queue_records_next(tmp_path, monkeypatch):
    asyncio.run(_first_pov_is_ready_while_queue_records_next(tmp_path, monkeypatch))


async def _first_pov_is_ready_while_queue_records_next(tmp_path, monkeypatch):
    batch_id = "a" * 32
    source = tmp_path / "capture.mp4"
    source.write_bytes(b"recorded-by-OBS")
    monkeypatch.setattr(api, "get_data_dir", lambda: tmp_path)
    async def ready_obs():
        pass
    monkeypatch.setattr(api, "_prepare_obs", ready_obs)
    monkeypatch.setattr(api.RecordingRequestDTO, "model_validate", lambda payload: payload)
    monkeypatch.setattr(api, "QueueRecordingRequest", lambda **kwargs: kwargs)
    monkeypatch.setattr(api, "_probe_real_video", lambda _source, _expected: {
        "duration": 10.0, "fps": 60.0,
    })
    monkeypatch.setattr(api, "_normalize_pov", lambda _source, dest: dest.write_bytes(b"normalized"))
    monkeypatch.setattr(api, "_make_proxy", lambda _source, dest: dest.write_bytes(b"proxy"))
    release_second = asyncio.Event()
    first_emitted = asyncio.Event()

    async def fake_queue(_request, _unused):
        assert runtime_session_state()["busy"]
        observer = api.recording_result_observer.get()
        first = {"request_id": "p1", "success": True, "output_path": str(source)}
        observer(first)
        first_emitted.set()
        await release_second.wait()
        second = {"request_id": "p2", "success": True, "output_path": str(source)}
        observer(second)
        return [first, second]

    monkeypatch.setattr(api, "execute_recording_queue", fake_queue)
    jobs = [
        {"request": {"request_id": request_id}, "coverage_start_tick": 0, "coverage_end_tick": 640}
        for request_id in ("p1", "p2")
    ]
    api._batches[batch_id] = {"id": batch_id, "status": "Waiting", "players": [
        {"status": "Waiting"}, {"status": "Waiting"},
    ]}
    api._active_batch = batch_id
    task = asyncio.create_task(api._run_batch(batch_id, jobs, 64.0))
    try:
        await asyncio.wait_for(first_emitted.wait(), 2)
        async def first_ready():
            while api._batches[batch_id]["players"][0]["status"] != "Complete":
                await asyncio.sleep(0.01)
        await asyncio.wait_for(first_ready(), 3)
        assert not task.done()
        assert api._batches[batch_id]["players"][1]["status"] == "Waiting"
        assert (tmp_path / "tactical-povs" / batch_id / "player1-proxy.mp4").is_file()
        assert api._get_batch(batch_id)["players"][0]["status"] == "Complete"
    finally:
        release_second.set()
        await asyncio.wait_for(task, 3)
        api._batches.pop(batch_id, None)
    assert task.result() is None
    assert not runtime_session_state()["busy"]


def test_failed_preflight_persists_actionable_error(tmp_path, monkeypatch):
    async def run():
        batch_id = "b" * 32
        monkeypatch.setattr(api, "get_data_dir", lambda: tmp_path)
        async def fail():
            raise HTTPException(409, {"code": "TEST", "message": "CS2 is already running"})
        monkeypatch.setattr(api, "_prepare_obs", fail)
        api._batches[batch_id] = {"id": batch_id, "status": "Waiting", "players": [{"status": "Waiting"} for _ in range(5)]}
        api._active_batch = batch_id
        await api._run_batch(batch_id, [], 64)
        state = api._batches.pop(batch_id)
        assert state["status"] == "Failed"
        assert state["error"] == "CS2 is already running"
        assert all(p["status"] == "Failed" for p in state["players"])
        assert json.loads(api._batch_state_path(batch_id).read_text())["status"] == "Failed"
        assert api._active_batch is None
        assert not runtime_session_state()["busy"]
    asyncio.run(run())


def test_interrupted_batch_is_not_forever_recording(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_data_dir", lambda: tmp_path)
    batch_id = "c" * 32
    api._persist_batch({"id": batch_id, "status": "Recording", "players": [{"status": "Waiting"}, {"status": "Complete"}]})
    try:
        state = api._get_batch(batch_id)
        assert state["status"] == "Failed"
        assert state["players"][0]["status"] == "Failed"
        assert state["players"][1]["status"] == "Complete"
    finally:
        api._batches.pop(batch_id, None)


def test_tactical_name_fallback_requires_positive_steamid_verification(monkeypatch):
    from app.recording.executor import recording_executor as executor
    from app.recording.progress import require_verified_pov
    async def run():
        async def select(_name):
            pass
        async def inconclusive(_steamid):
            return None
        monkeypatch.setattr(executor, "spec_player", select)
        monkeypatch.setattr(executor, "verify_spec_target", inconclusive)
        token = require_verified_pov.set(True)
        try:
            warnings = []
            result = await executor._spec_by_slot_with_retry(None, "donk", "76561198386265483", warnings, 0)
            assert result is False
            assert warnings
        finally:
            require_verified_pov.reset(token)
    asyncio.run(run())
