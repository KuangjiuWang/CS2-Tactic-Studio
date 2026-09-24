"""A completed recording becomes watchable before the next player finishes."""

import asyncio

from app.features.tactical_playbook import api


def test_first_pov_is_ready_while_queue_records_next(tmp_path, monkeypatch):
    asyncio.run(_first_pov_is_ready_while_queue_records_next(tmp_path, monkeypatch))


async def _first_pov_is_ready_while_queue_records_next(tmp_path, monkeypatch):
    batch_id = "a" * 32
    source = tmp_path / "capture.mp4"
    source.write_bytes(b"recorded-by-OBS")
    monkeypatch.setattr(api, "get_data_dir", lambda: tmp_path)
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
