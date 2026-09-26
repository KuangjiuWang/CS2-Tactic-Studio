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


def test_retry_endpoint_schedules_only_incomplete_players(tmp_path, monkeypatch):
    async def run():
        batch_id = "d" * 32
        demo_path = str(tmp_path / "match.dem")
        monkeypatch.setattr(api, "get_data_dir", lambda: tmp_path)
        monkeypatch.setattr(api, "_active_batch", None)
        state = {
            "id": batch_id, "status": "Failed", "demo_path": demo_path,
            "round_number": 7, "side": "T", "tick_rate": 64,
            "recording_mode": "obs", "players": [
                {
                    "steam_id64": f"steam-{index}", "status": status, "attempt": 1,
                    "coverage_start_tick": 100, "coverage_end_tick": 200,
                }
                for index, status in enumerate(("Complete", "Failed", "Complete", "Failed", "Complete"))
            ],
        }
        api._batches[batch_id] = state
        rebuilt_jobs = [
            {
                "steam_id64": f"steam-{index}", "request": {"request_id": f"retry-{index}"},
                "coverage_start_tick": 100, "coverage_end_tick": 200,
            }
            for index in range(5)
        ]
        monkeypatch.setattr(api, "_jobs", lambda _selection: rebuilt_jobs)
        scheduled = asyncio.Event()
        captured = {}

        async def capture_retry(actual_batch_id, jobs, tick_rate, player_indices):
            captured.update(batch_id=actual_batch_id, jobs=jobs, tick_rate=tick_rate, player_indices=player_indices)
            api._active_batch = None
            scheduled.set()

        monkeypatch.setattr(api, "_run_batch", capture_retry)
        selection = api.RoundSelection(
            demo_path=demo_path,
            analysis_workspace={"tick_rate": 64},
            round_number=7,
            side="T",
        )
        try:
            response = await api.retry_failed_povs(batch_id, selection)
            assert response["status"] == "Waiting"
            assert [player["status"] for player in state["players"]] == [
                "Complete", "Waiting", "Complete", "Waiting", "Complete",
            ]
            assert [player["attempt"] for player in state["players"]] == [1, 2, 1, 2, 1]
            await asyncio.wait_for(scheduled.wait(), 2)
            assert captured["batch_id"] == batch_id
            assert captured["player_indices"] == [1, 3]
            assert [job["steam_id64"] for job in captured["jobs"]] == ["steam-1", "steam-3"]
            assert captured["tick_rate"] == 64
        finally:
            api._active_batch = None
            api._batches.pop(batch_id, None)
    asyncio.run(run())


def test_retry_batch_maps_subset_job_to_original_player_slot(tmp_path, monkeypatch):
    async def run():
        batch_id = "e" * 32
        source = tmp_path / "capture.mp4"
        source.write_bytes(b"recorded-by-OBS")
        monkeypatch.setattr(api, "get_data_dir", lambda: tmp_path)
        monkeypatch.setattr(api, "_active_batch", batch_id)
        monkeypatch.setattr(api, "_prepare_obs", lambda: asyncio.sleep(0))
        monkeypatch.setattr(api.RecordingRequestDTO, "model_validate", lambda payload: payload)
        monkeypatch.setattr(api, "QueueRecordingRequest", lambda **kwargs: kwargs)
        monkeypatch.setattr(api, "_probe_real_video", lambda _source, _expected: {"duration": 10.0, "fps": 60.0})
        monkeypatch.setattr(api, "_normalize_pov", lambda _source, dest: dest.write_bytes(b"normalized"))
        monkeypatch.setattr(api, "_make_proxy", lambda _source, dest: dest.write_bytes(b"proxy"))
        job = {
            "request": {"request_id": "retry-player-two"},
            "coverage_start_tick": 100,
            "coverage_end_tick": 740,
        }

        async def retry_queue(request, _unused):
            assert len(request["requests"]) == 1
            result = {"request_id": "retry-player-two", "success": True, "output_path": str(source)}
            api.recording_result_observer.get()(result)
            return [result]

        monkeypatch.setattr(api, "execute_recording_queue", retry_queue)
        state = {
            "id": batch_id, "status": "Waiting", "recording_mode": "obs",
            "players": [{"status": "Complete", "video_path": f"saved-{index}.mp4"} for index in range(5)],
        }
        state["players"][1] = {"status": "Waiting", "steam_id64": "steam-1"}
        api._batches[batch_id] = state
        try:
            await api._run_batch(batch_id, [job], 64.0, [1])
            retried = state["players"][1]
            assert state["status"] == "Complete"
            assert retried["status"] == "Complete"
            assert retried["video_path"].endswith("player2.mp4")
            assert retried["proxy_path"].endswith("player2-proxy.mp4")
            assert retried["stream_url"].endswith("/2/video")
            assert state["players"][0]["video_path"] == "saved-0.mp4"
            assert (tmp_path / "tactical-povs" / batch_id / "player2-proxy.mp4").is_file()
        finally:
            api._active_batch = None
            api._batches.pop(batch_id, None)
    asyncio.run(run())
