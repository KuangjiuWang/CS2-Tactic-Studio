"""Five real CS2 POVs through the existing Insight OBS recording queue."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import AsyncExitStack
from fractions import Fraction
import subprocess
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ...env_utils import get_data_dir
from ...env_utils import load_config
from ...recording.api import QueueRecordingRequest, execute_recording_queue, recording_result_observer
from ...recording.models import RecordingRequestDTO
from ...recording.progress import recording_progress_observer, require_verified_pov
from ...runtime_session import runtime_session
from ...obs_bootstrap import bootstrap_obs_environment, ObsBootstrapRequest
from ...video_composer import MontageComposerError, resolve_ffmpeg_binary, resolve_ffprobe_binary
from .rounds import TacticalRoundError, build_five_pov_jobs, select_round
from .storage import TacticalStore

router = APIRouter(prefix="/api/tactical", tags=["tactical-playbook"])
_batches: dict[str, dict] = {}
_active_batch: str | None = None
_batch_tasks: set[asyncio.Task] = set()
logger = logging.getLogger(__name__)


def _persist_batch(state: dict) -> None:
    path = _batch_state_path(state["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"metadata-{uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


async def _prepare_obs() -> None:
    result = await asyncio.to_thread(bootstrap_obs_environment, load_config(), ObsBootstrapRequest())
    if not result.get("ok"):
        messages = [event["message"] for event in result.get("events", [])
                    if event.get("status") in {"blocked", "failed"} and event.get("message")]
        raise ValueError("OBS 自动连接失败：" + ("；".join(messages) or result.get("status", "unknown")))


def _batch_state_path(batch_id: str) -> Path:
    if len(batch_id) != 32 or any(ch not in "0123456789abcdef" for ch in batch_id):
        raise HTTPException(404, "unknown batch")
    return get_data_dir() / "tactical-povs" / batch_id / "metadata.json"


def _get_batch(batch_id: str) -> dict | None:
    state = _batches.get(batch_id)
    if state is not None:
        return state
    path = _batch_state_path(batch_id)
    if not path.is_file():
        return None
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("status") not in {"Complete", "Failed"} and batch_id != _active_batch:
        state.update(status="Failed", error="上次录制被中断，请重新生成 POV。")
        for item in state.get("players", []):
            if item.get("status") not in {"Complete", "Failed"}:
                item.update(status="Failed", error=state["error"])
        _persist_batch(state)
    _batches[batch_id] = state
    return state


class RoundSelection(BaseModel):
    demo_path: str
    analysis_workspace: dict
    round_number: int
    side: str


def _jobs(selection: RoundSelection) -> list[dict]:
    try:
        return build_five_pov_jobs(
            selection.demo_path, selection.analysis_workspace,
            selection.round_number, selection.side,
        )
    except (TacticalRoundError, OSError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/pov-plan")
async def pov_plan(selection: RoundSelection):
    return {"jobs": _jobs(selection)}


def _probe_real_video(path: Path, expected_seconds: float) -> dict:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError("recorded video is missing or empty")
    try:
        probe = resolve_ffprobe_binary(resolve_ffmpeg_binary(load_config().ffmpeg_path))
    except MontageComposerError as exc:
        raise ValueError(f"a matching ffmpeg/ffprobe toolkit is required: {exc}") from exc
    proc = subprocess.run(
        [probe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, text=True, timeout=60,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if proc.returncode:
        raise ValueError(f"ffprobe could not decode recorded POV: {proc.stderr[:300]}")
    data = json.loads(proc.stdout)
    streams = data.get("streams") or []
    if not any(s.get("codec_type") == "video" for s in streams):
        raise ValueError("recorded POV has no decodable video stream")
    if not any(s.get("codec_type") == "audio" for s in streams):
        raise ValueError("recorded POV has no audio stream")
    duration = float((data.get("format") or {}).get("duration") or 0)
    if duration <= 0:
        raise ValueError("recorded POV has zero duration")
    # CS2/OBS wall-clock control is approximate; large discrepancies are failures.
    if abs(duration - expected_seconds) > max(5.0, expected_seconds * 0.2):
        raise ValueError(f"POV duration {duration:.1f}s differs from expected {expected_seconds:.1f}s")
    video = next(s for s in streams if s.get("codec_type") == "video")
    raw_rate = str(video.get("avg_frame_rate") or "0")
    try:
        fps = float(Fraction(raw_rate))
    except (ValueError, ZeroDivisionError):
        fps = 0.0
    return {"duration": duration, "fps": fps, "video_path": str(path)}


def _make_proxy(source: Path, destination: Path) -> None:
    try:
        ffmpeg = resolve_ffmpeg_binary(load_config().ffmpeg_path)
    except MontageComposerError as exc:
        raise ValueError(f"ffmpeg is required for tactical POV proxies: {exc}") from exc
    proc = subprocess.run(
        [ffmpeg, "-nostdin", "-y", "-i", str(source), "-an",
         "-vf", "scale=-2:360,fps=15", "-c:v", "libx264", "-preset", "veryfast",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(destination)],
        capture_output=True, text=True, timeout=1800,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if proc.returncode or not destination.is_file():
        raise ValueError(f"ffmpeg could not encode the POV proxy: {proc.stderr[-500:]}")


def _normalize_pov(source: Path, destination: Path) -> None:
    """Produce a seekable, WebView-compatible 720p60 source with real sound."""
    try:
        ffmpeg = resolve_ffmpeg_binary(load_config().ffmpeg_path)
    except MontageComposerError as exc:
        raise ValueError(f"ffmpeg is required for tactical POV normalization: {exc}") from exc
    proc = subprocess.run(
        [ffmpeg, "-nostdin", "-y", "-i", str(source), "-map", "0:v:0", "-map", "0:a:0",
         "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,"
                "pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=60,setsar=1",
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-g", "120",
         "-keyint_min", "120", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
         "-movflags", "+faststart", str(destination)],
        capture_output=True, text=True, timeout=7200,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if proc.returncode or not destination.is_file():
        raise ValueError(f"ffmpeg could not normalize the POV: {proc.stderr[-500:]}")


async def _run_batch(batch_id: str, jobs: list[dict], tick_rate: float) -> None:
    global _active_batch
    state = _batches[batch_id]
    finalizers: dict[str, asyncio.Task] = {}
    session = AsyncExitStack()

    def persist_state() -> None:
        _persist_batch(state)

    async def finalize(index: int, result: dict) -> None:
        job = jobs[index]
        item = state["players"][index]
        if not result.get("success"):
            item.update(status="Failed", error=str(result.get("error") or "OBS recording failed"))
            persist_state()
            return
        try:
            item["status"] = "Verifying"
            source = Path(str(result.get("output_path") or ""))
            expected = (job["coverage_end_tick"] - job["coverage_start_tick"]) / tick_rate
            metadata = await asyncio.to_thread(_probe_real_video, source, expected)
            # Keep the upstream recording; tactics own a normalized MP4.
            dest = get_data_dir() / "tactical-povs" / batch_id / f"player{index + 1}.mp4"
            dest.parent.mkdir(parents=True, exist_ok=True)
            item["status"] = "Encoding"
            await asyncio.to_thread(_normalize_pov, source, dest)
            metadata = await asyncio.to_thread(_probe_real_video, dest, expected)
            proxy = dest.with_name(f"player{index + 1}-proxy.mp4")
            await asyncio.to_thread(_make_proxy, dest, proxy)
            metadata.update({
                "video_path": str(dest), "proxy_path": str(proxy),
                "start_tick": job["coverage_start_tick"],
                "end_tick": job["coverage_end_tick"], "tick_rate": tick_rate,
                "stream_url": f"/api/tactical/povs/{batch_id}/{index + 1}/video",
                "proxy_url": f"/api/tactical/povs/{batch_id}/{index + 1}/proxy",
            })
            item.update(status="Complete", **metadata)
        except (OSError, ValueError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            item.update(status="Failed", error=str(exc))
        persist_state()

    try:
        await session.enter_async_context(runtime_session("/api/tactical/prepare-povs"))
        state["status"] = "Connecting OBS"
        persist_state()
        await _prepare_obs()
        state["status"] = "Recording"
        persist_state()
        requests = [RecordingRequestDTO.model_validate(j["request"]) for j in jobs]
        by_id = {j["request"]["request_id"]: index for index, j in enumerate(jobs)}
        def on_progress(status: str, request_id: str | None) -> None:
            state["status"] = status
            if request_id in by_id:
                state["players"][by_id[request_id]]["status"] = status
            persist_state()
        def on_result(result: dict) -> None:
            request_id = result.get("request_id")
            index = by_id.get(request_id)
            if index is not None and request_id not in finalizers:
                state["players"][index]["status"] = "Verifying" if result.get("success") else "Failed"
                finalizers[request_id] = asyncio.create_task(finalize(index, result))
        observer_token = recording_result_observer.set(on_result)
        progress_token = recording_progress_observer.set(on_progress)
        verify_token = require_verified_pov.set(True)
        try:
            results = await execute_recording_queue(QueueRecordingRequest(requests=requests), None)
        finally:
            recording_result_observer.reset(observer_token)
            recording_progress_observer.reset(progress_token)
            require_verified_pov.reset(verify_token)
        by_request = {r.get("request_id"): r for r in results if isinstance(r, dict)}
        for request_id, index in by_id.items():
            if request_id not in finalizers:
                finalizers[request_id] = asyncio.create_task(finalize(index, by_request.get(request_id) or {}))
        if finalizers:
            state["status"] = "Encoding"
            persist_state()
            await asyncio.gather(*finalizers.values())
        state["status"] = "Complete" if all(p["status"] == "Complete" for p in state["players"]) else "Failed"
    except Exception as exc:  # surface real CS2/OBS failures, never synthesize videos
        logger.exception("Five-POV batch %s failed", batch_id)
        if finalizers:
            await asyncio.gather(*finalizers.values(), return_exceptions=True)
        state["status"] = "Failed"
        detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
        state["error"] = (detail.get("message") or json.dumps(detail, ensure_ascii=False)) if isinstance(detail, dict) else str(detail)
        for item in state["players"]:
            if item["status"] not in {"Complete", "Failed"}:
                item.update(status="Failed", error=state["error"])
    except asyncio.CancelledError:
        state.update(status="Failed", error="录制被中断，请重新生成 POV。")
        for item in state["players"]:
            if item["status"] not in {"Complete", "Failed"}:
                item.update(status="Failed", error=state["error"])
        raise
    finally:
        await session.aclose()
        _active_batch = None
        try:
            persist_state()
        except OSError:
            pass


@router.post("/prepare-povs", status_code=202)
async def prepare_povs(selection: RoundSelection):
    global _active_batch
    if _active_batch is not None:
        raise HTTPException(409, "another five-POV batch is running")
    jobs = _jobs(selection)
    batch_id = uuid4().hex
    _batches[batch_id] = {
        "id": batch_id, "status": "Waiting", "round_number": selection.round_number,
        "side": selection.side.upper(), "tick_rate": selection.analysis_workspace["tick_rate"],
        "players": [{
            "player_id": j["player_id"], "player_name": j["player_name"], "steam_id64": j["steam_id64"],
            "coverage_start_tick": j["coverage_start_tick"],
            "coverage_end_tick": j["coverage_end_tick"],
            "status": "Waiting", "video_path": None,
        } for j in jobs],
    }
    _persist_batch(_batches[batch_id])
    _active_batch = batch_id
    task = asyncio.create_task(_run_batch(batch_id, jobs, float(selection.analysis_workspace["tick_rate"])))
    _batch_tasks.add(task)
    task.add_done_callback(_batch_tasks.discard)
    return _batches[batch_id]


@router.get("/prepare-povs/{batch_id}")
async def prepare_povs_status(batch_id: str):
    state = _get_batch(batch_id)
    if state is None:
        raise HTTPException(404, "unknown batch")
    return state


@router.get("/povs/{batch_id}/{player_number}/{variant}")
async def pov_stream(batch_id: str, player_number: int, variant: str):
    batch = _get_batch(batch_id)
    if not batch or player_number < 1 or player_number > 5 or variant not in {"video", "proxy"}:
        raise HTTPException(404, "POV not found")
    item = batch["players"][player_number - 1]
    if item["status"] != "Complete":
        raise HTTPException(404, "POV is not ready")
    path = Path(item["video_path"] if variant == "video" else item["proxy_path"])
    if not path.is_file():
        raise HTTPException(404, "POV file is missing")
    return FileResponse(path, media_type="video/mp4" if path.suffix.lower() == ".mp4" else "video/x-matroska")


class SaveTactic(BaseModel):
    selection: RoundSelection
    name: str
    folder_id: str | None = None
    pov_batch_id: str | None = None


class AddStep(BaseModel):
    tick: int
    title: str = ""
    note: str = ""
    annotations: list = []


class CreateFolder(BaseModel):
    name: str
    parent_id: str | None = None


class MoveFolder(BaseModel):
    parent_id: str | None = None


class MoveTactic(BaseModel):
    folder_id: str | None = None


class EditStep(BaseModel):
    title: str = ""
    note: str = ""
    annotations: list = []


@router.get("/playbooks")
async def list_playbooks():
    return await TacticalStore().list_tree()


@router.post("/folders")
async def create_folder(body: CreateFolder):
    try:
        return await TacticalStore().create_folder(body.name, body.parent_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.patch("/folders/{folder_id}/parent")
async def move_folder(folder_id: str, body: MoveFolder):
    try:
        await TacticalStore().move_folder(folder_id, body.parent_id)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/tactics")
async def save_tactic(body: SaveTactic):
    try:
        row, team_key, _ = select_round(
            body.selection.analysis_workspace, body.selection.round_number, body.selection.side,
        )
        return await TacticalStore().create_tactic(
            name=body.name, map_name=str(body.selection.analysis_workspace.get("map_name") or ""),
            side=body.selection.side.upper(), demo_path=body.selection.demo_path,
            round_number=body.selection.round_number,
            round_start_tick=int(row["start_tick"]),
            freeze_end_tick=int(row["freeze_end_tick"]),
            round_end_tick=int(row["round_end_tick"]),
            folder_id=body.folder_id,
            metadata={"team_key": team_key, "pov_batch_id": body.pov_batch_id},
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/tactics/{tactic_id}")
async def get_tactic(tactic_id: str):
    tactic = await TacticalStore().get_tactic(tactic_id)
    if tactic is None:
        raise HTTPException(404, "tactic not found")
    return tactic


@router.post("/tactics/{tactic_id}/steps")
async def add_step(tactic_id: str, body: AddStep):
    store = TacticalStore()
    tactic = await store.get_tactic(tactic_id)
    if tactic is None:
        raise HTTPException(404, "tactic not found")
    if not tactic["round_start_tick"] <= body.tick <= tactic["round_end_tick"]:
        raise HTTPException(422, "step tick is outside the source round")
    return await store.add_step(tactic_id, body.tick, body.title, body.note, body.annotations)


@router.put("/tactics/{tactic_id}/steps/{step_id}")
async def edit_step(tactic_id: str, step_id: str, body: EditStep):
    try:
        return await TacticalStore().update_step(tactic_id, step_id, title=body.title,
                                                  note=body.note, annotations=body.annotations)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.delete("/tactics/{tactic_id}/steps/{step_id}")
async def delete_step(tactic_id: str, step_id: str):
    try:
        await TacticalStore().delete_step(tactic_id, step_id)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.patch("/tactics/{tactic_id}/folder")
async def move_tactic(tactic_id: str, body: MoveTactic):
    try:
        await TacticalStore().move_tactic(tactic_id, body.folder_id)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
