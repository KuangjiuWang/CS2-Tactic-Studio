"""Five real CS2 POVs through the existing Insight OBS recording queue."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import AsyncExitStack
from fractions import Fraction
import subprocess
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ...env_utils import get_data_dir
from ...env_utils import load_config
from ...file_hash import file_sha256_hex
from ...recording.api import QueueRecordingRequest, execute_recording_queue, recording_result_observer
from ...recording.models import RecordingRequestDTO
from ...recording.progress import recording_progress_observer, require_verified_pov
from ...runtime_session import runtime_session
from ...obs_bootstrap import bootstrap_obs_environment, ObsBootstrapRequest
from ...video_composer import MontageComposerError, resolve_ffmpeg_binary, resolve_ffprobe_binary
from .rounds import TacticalRoundError, build_five_pov_jobs, select_round
from .hlae_capture import HLAECaptureError, run_hlae_capture, validate_hlae_installation
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
    recording_mode: Literal["obs", "hlae"] = "obs"
    tactic_id: str | None = None


def _canonical_demo_path(path: str) -> str:
    return os.path.normcase(str(Path(path).expanduser().resolve()))


def _jobs(selection: RoundSelection) -> list[dict]:
    try:
        return build_five_pov_jobs(
            selection.demo_path, selection.analysis_workspace,
            selection.round_number, selection.side,
        )
    except (TacticalRoundError, OSError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc


def _validate_hlae_ready() -> None:
    config = load_config()
    try:
        ffmpeg = resolve_ffmpeg_binary(config.ffmpeg_path)
        validate_hlae_installation(config.hlae_path, config.cs2_path, str(ffmpeg))
        resolve_ffprobe_binary(ffmpeg)
    except (HLAECaptureError, MontageComposerError, OSError) as exc:
        raise HTTPException(422, {"code": "HLAE_NOT_READY", "message": str(exc)}) from exc


@router.post("/pov-plan")
async def pov_plan(selection: RoundSelection):
    return {"jobs": _jobs(selection)}


def _probe_real_video(path: Path, expected_seconds: float, require_audio: bool = True) -> dict:
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
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    if require_audio and not has_audio:
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
    return {"duration": duration, "fps": fps, "has_audio": has_audio, "height": int(video.get("height") or 0), "video_path": str(path)}


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


def _mux_hlae_capture(video: Path, audio: Path, destination: Path, fps: int = 60) -> None:
    """Mux HLAE's real screen render and its separately captured game WAV."""
    try:
        ffmpeg = resolve_ffmpeg_binary(load_config().ffmpeg_path)
    except MontageComposerError as exc:
        raise ValueError(f"FFmpeg is required to mux the HLAE POV and game audio: {exc}") from exc
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.stem + ".partial.mp4")
    proc = subprocess.run(
        [str(ffmpeg), "-nostdin", "-y", "-i", str(video), "-i", str(audio),
         "-map", "0:v:0", "-map", "1:a:0", "-vf",
         f"scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps={fps},setsar=1",
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-g", str(fps * 2),
         "-keyint_min", str(fps * 2), "-sc_threshold", "0", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
         "-shortest", "-movflags", "+faststart", str(temporary)],
        capture_output=True, text=True, timeout=7200,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if proc.returncode or not temporary.is_file() or temporary.stat().st_size == 0:
        temporary.unlink(missing_ok=True)
        raise ValueError(f"FFmpeg could not mux the HLAE POV/audio: {proc.stderr[-600:]}")
    temporary.replace(destination)


async def _run_hlae_batch(
    batch_id: str,
    jobs: list[dict],
    tick_rate: float,
    player_indices: list[int] | None = None,
) -> None:
    state = _batches[batch_id]
    player_indices = player_indices or list(range(len(jobs)))
    config = load_config()
    hlae_ffmpeg = resolve_ffmpeg_binary(config.ffmpeg_path)
    files = validate_hlae_installation(config.hlae_path, config.cs2_path, str(hlae_ffmpeg))
    loop = asyncio.get_running_loop()
    base_dir = get_data_dir() / "tactical-povs" / batch_id
    base_dir.mkdir(parents=True, exist_ok=True)

    for job_index, job in enumerate(jobs):
        player_index = player_indices[job_index]
        item = state["players"][player_index]
        attempt = max(1, int(item.get("attempt") or 1))
        capture_dir = base_dir / "hlae" / f"player{player_index + 1}" / f"attempt-{attempt}"
        output = base_dir / f"player{player_index + 1}.mp4"
        proxy = base_dir / f"player{player_index + 1}-proxy.mp4"

        def report(status: str, message: str, player: dict = item) -> None:
            def apply_update() -> None:
                if player.get("status") in {"Failed", "Complete"}:
                    return
                state["status"] = status
                player["status"] = status
                player["message"] = message
                try:
                    _persist_batch(state)
                except OSError:
                    logger.exception("Could not persist HLAE POV progress for %s", batch_id)
            loop.call_soon_threadsafe(apply_update)

        try:
            result = await asyncio.to_thread(
                run_hlae_capture,
                files=files,
                demo_path=job["request"]["demo"]["demo_path"],
                steam_id64=str(job["steam_id64"]),
                start_tick=int(job["coverage_start_tick"]),
                end_tick=int(job["coverage_end_tick"]),
                tick_rate=tick_rate,
                output_dir=capture_dir,
                fps=60,
                report=report,
            )
            item["status"] = "Encoding"
            item["message"] = "Muxing actual HLAE video with its game WAV"
            state["status"] = "Encoding"
            _persist_batch(state)
            await asyncio.to_thread(_mux_hlae_capture, result["video_path"], result["audio_path"], output)
            expected = (int(result["end_tick"]) - int(result["start_tick"])) / tick_rate
            metadata = await asyncio.to_thread(_probe_real_video, output, expected)
            if abs(float(metadata["duration"]) - expected) > max(1.0, expected * 0.1):
                raise ValueError(
                    f"HLAE video duration {metadata['duration']:.2f}s differs from the demo interval {expected:.2f}s."
                )
            item["status"] = "Verifying"
            item["message"] = "Checking decode, audio stream, duration, and proxy"
            _persist_batch(state)
            await asyncio.to_thread(_make_proxy, output, proxy)
            proxy_metadata = await asyncio.to_thread(_probe_real_video, proxy, expected, False)
            if proxy_metadata["height"] != 360 or abs(float(proxy_metadata["fps"]) - 15) > 0.75:
                raise ValueError("HLAE preview proxy must be 360p / 15fps.")
            item.update(
                status="Complete",
                duration=metadata["duration"],
                fps=metadata["fps"],
                video_path=str(output),
                proxy_path=str(proxy),
                start_tick=int(result["start_tick"]),
                end_tick=int(result["end_tick"]),
                tick_rate=tick_rate,
                source="HLAE",
                stream_url=f"/api/tactical/povs/{batch_id}/{player_index + 1}/video",
                proxy_url=f"/api/tactical/povs/{batch_id}/{player_index + 1}/proxy",
                render_log_path=str(result["render_log_path"]),
                error=None,
            )
            item.pop("message", None)
        except Exception as exc:
            logger.exception("HLAE POV %s failed in batch %s", player_index + 1, batch_id)
            item.update(status="Failed", error=str(exc))
        _persist_batch(state)


async def _run_batch(
    batch_id: str,
    jobs: list[dict],
    tick_rate: float,
    player_indices: list[int] | None = None,
) -> None:
    global _active_batch
    state = _batches[batch_id]
    player_indices = player_indices or list(range(len(jobs)))
    state.pop("error", None)
    finalizers: dict[str, asyncio.Task] = {}
    session = AsyncExitStack()

    def persist_state() -> None:
        _persist_batch(state)

    async def finalize(job_index: int, result: dict) -> None:
        player_index = player_indices[job_index]
        job = jobs[job_index]
        item = state["players"][player_index]
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
            dest = get_data_dir() / "tactical-povs" / batch_id / f"player{player_index + 1}.mp4"
            dest.parent.mkdir(parents=True, exist_ok=True)
            item["status"] = "Encoding"
            await asyncio.to_thread(_normalize_pov, source, dest)
            metadata = await asyncio.to_thread(_probe_real_video, dest, expected)
            proxy = dest.with_name(f"player{player_index + 1}-proxy.mp4")
            await asyncio.to_thread(_make_proxy, dest, proxy)
            metadata.update({
                "video_path": str(dest), "proxy_path": str(proxy),
                "start_tick": job["coverage_start_tick"],
                "end_tick": job["coverage_end_tick"], "tick_rate": tick_rate,
                "stream_url": f"/api/tactical/povs/{batch_id}/{player_index + 1}/video",
                "proxy_url": f"/api/tactical/povs/{batch_id}/{player_index + 1}/proxy",
            })
            item.update(status="Complete", **metadata)
        except (OSError, ValueError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            item.update(status="Failed", error=str(exc))
        persist_state()

    try:
        await session.enter_async_context(runtime_session("/api/tactical/prepare-povs"))
        if state.get("recording_mode") == "hlae":
            state["status"] = "Preparing HLAE"
            persist_state()
            await _run_hlae_batch(batch_id, jobs, tick_rate, player_indices)
            state["status"] = "Complete" if all(p["status"] == "Complete" for p in state["players"]) else "Failed"
            if state["status"] == "Failed":
                state["error"] = "HLAE did not complete all five real POV renders. See each player's render status/log."
            else:
                state.pop("error", None)
            return
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
                state["players"][player_indices[by_id[request_id]]]["status"] = status
            persist_state()
        def on_result(result: dict) -> None:
            request_id = result.get("request_id")
            job_index = by_id.get(request_id)
            if job_index is not None and request_id not in finalizers:
                player_index = player_indices[job_index]
                state["players"][player_index]["status"] = "Verifying" if result.get("success") else "Failed"
                finalizers[request_id] = asyncio.create_task(finalize(job_index, result))
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
        for request_id, job_index in by_id.items():
            if request_id not in finalizers:
                finalizers[request_id] = asyncio.create_task(finalize(job_index, by_request.get(request_id) or {}))
        if finalizers:
            state["status"] = "Encoding"
            persist_state()
            await asyncio.gather(*finalizers.values())
        state["status"] = "Complete" if all(p["status"] == "Complete" for p in state["players"]) else "Failed"
        if state["status"] == "Complete":
            state.pop("error", None)
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
    if selection.recording_mode == "hlae":
        _validate_hlae_ready()
    tactic = None
    if selection.tactic_id:
        tactic = await TacticalStore().get_tactic(selection.tactic_id)
        if tactic is None:
            raise HTTPException(404, "tactic not found")
        if (
            _canonical_demo_path(selection.demo_path) != _canonical_demo_path(tactic["source_demo_path"])
            or int(tactic["round_number"]) != int(selection.round_number)
            or str(tactic["side"]).upper() != str(selection.side).upper()
            or str(tactic["map_name"]) != str(selection.analysis_workspace.get("map_name") or "")
        ):
            raise HTTPException(409, "recording selection does not match the saved tactic")
    batch_id = uuid4().hex
    _batches[batch_id] = {
        "id": batch_id, "status": "Waiting", "round_number": selection.round_number,
        "demo_path": selection.demo_path,
        "side": selection.side.upper(), "tick_rate": selection.analysis_workspace["tick_rate"],
        "recording_mode": selection.recording_mode,
        "tactic_id": selection.tactic_id,
        "players": [{
            "player_id": j["player_id"], "player_name": j["player_name"], "steam_id64": j["steam_id64"],
            "coverage_start_tick": j["coverage_start_tick"],
            "coverage_end_tick": j["coverage_end_tick"],
            "status": "Waiting", "video_path": None, "attempt": 1,
        } for j in jobs],
    }
    _persist_batch(_batches[batch_id])
    if tactic is not None:
        try:
            await TacticalStore().update_recording(tactic["id"], batch_id)
        except ValueError as exc:
            _batches.pop(batch_id, None)
            _batch_state_path(batch_id).unlink(missing_ok=True)
            raise HTTPException(404, str(exc)) from exc
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


@router.post("/prepare-povs/{batch_id}/retry", status_code=202)
async def retry_failed_povs(batch_id: str, selection: RoundSelection):
    """Retry only unfinished players while keeping successful POV files in place."""
    global _active_batch
    if _active_batch is not None:
        raise HTTPException(409, "another five-POV batch is running")
    state = _get_batch(batch_id)
    if state is None:
        raise HTTPException(404, "unknown batch")
    if state.get("status") not in {"Complete", "Failed"}:
        raise HTTPException(409, "POV batch is still running")
    if selection.demo_path != state.get("demo_path"):
        raise HTTPException(409, "retry must use the original demo")
    if int(selection.round_number) != int(state.get("round_number") or 0) or selection.side.upper() != str(state.get("side") or "").upper():
        raise HTTPException(409, "retry must use the original round and side")
    try:
        selection_tick_rate = float(selection.analysis_workspace.get("tick_rate") or 0)
        batch_tick_rate = float(state.get("tick_rate") or 0)
    except (TypeError, ValueError) as exc:
        raise HTTPException(409, "retry demo analysis does not match the original POV batch") from exc
    if selection_tick_rate != batch_tick_rate:
        raise HTTPException(409, "retry demo analysis does not match the original POV batch")

    retry_selection = selection.model_copy(update={"recording_mode": state.get("recording_mode") or "obs"})
    rebuilt_jobs = _jobs(retry_selection)
    players = state.get("players") or []
    jobs_by_steam_id = {str(job.get("steam_id64") or ""): job for job in rebuilt_jobs}
    if len(players) != 5 or len(rebuilt_jobs) != 5 or len(jobs_by_steam_id) != 5:
        raise HTTPException(409, "retry batch no longer matches its original five-player roster")
    player_steam_ids = [str(player.get("steam_id64") or "") for player in players]
    if len(set(player_steam_ids)) != 5 or any(not steam_id for steam_id in player_steam_ids):
        raise HTTPException(409, "retry batch no longer has a valid five-player roster")
    if any(str(player.get("steam_id64") or "") not in jobs_by_steam_id for player in players):
        raise HTTPException(409, "retry players do not match the original POV batch")
    for player in players:
        job = jobs_by_steam_id[str(player["steam_id64"])]
        if (
            int(job.get("coverage_start_tick") or 0) != int(player.get("coverage_start_tick") or 0)
            or int(job.get("coverage_end_tick") or 0) != int(player.get("coverage_end_tick") or 0)
        ):
            raise HTTPException(409, "retry coverage does not match the original POV batch")

    retry_indices = [index for index, player in enumerate(players) if player.get("status") != "Complete"]
    if not retry_indices:
        raise HTTPException(409, "all five POVs are already complete")
    if retry_selection.recording_mode == "hlae":
        _validate_hlae_ready()

    jobs = [jobs_by_steam_id[str(players[index]["steam_id64"])] for index in retry_indices]
    for index in retry_indices:
        player = players[index]
        player.update(status="Waiting", attempt=max(1, int(player.get("attempt") or 1)) + 1)
        for key in (
            "error", "message", "video_path", "proxy_path", "stream_url", "proxy_url",
            "duration", "fps", "source", "start_tick", "end_tick", "tick_rate", "render_log_path",
        ):
            player.pop(key, None)
    state.update(status="Waiting")
    state.pop("error", None)
    _persist_batch(state)
    _active_batch = batch_id
    task = asyncio.create_task(_run_batch(
        batch_id, jobs, float(retry_selection.analysis_workspace["tick_rate"]), retry_indices,
    ))
    _batch_tasks.add(task)
    task.add_done_callback(_batch_tasks.discard)
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
    tree = await TacticalStore().list_tree()
    for tactic in tree["tactics"]:
        batch_id = tactic["metadata"].get("pov_batch_id")
        try:
            batch = _get_batch(batch_id) if batch_id else None
        except (HTTPException, ValueError, OSError):
            batch = None
        players = (batch or {}).get("players", [])
        count = sum(p.get("status") == "Complete" for p in players)
        status = (batch or {}).get("status")
        tactic["pov_count"] = count
        tactic["pov_status"] = ("ready" if count == 5 else "generating" if batch and status not in {"Complete", "Failed"}
                                else "partial" if count else "failed" if status == "Failed" else "none")
    return tree


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
        demo_hash = None
        demo_file = Path(body.selection.demo_path).expanduser()
        if demo_file.is_file() and demo_file.suffix.lower() == ".dem":
            try:
                demo_hash = await asyncio.to_thread(file_sha256_hex, demo_file, chunk_size=1024 * 1024)
            except OSError as exc:
                raise HTTPException(422, f"could not fingerprint source demo: {exc}") from exc
        return await TacticalStore().create_tactic(
            name=body.name, map_name=str(body.selection.analysis_workspace.get("map_name") or ""),
            side=body.selection.side.upper(), demo_path=body.selection.demo_path,
            round_number=body.selection.round_number,
            round_start_tick=int(row["start_tick"]),
            freeze_end_tick=int(row["freeze_end_tick"]),
            round_end_tick=int(row["round_end_tick"]),
            folder_id=body.folder_id,
            source_demo_hash=demo_hash,
            metadata={"team_key": team_key, "pov_batch_id": body.pov_batch_id,
                      "analysis_workspace": body.selection.analysis_workspace,
                      "source_match": " vs ".join(str(body.selection.analysis_workspace.get(k) or "") for k in ("team_a_name", "team_b_name")),
                      "source_team": body.selection.analysis_workspace.get(f"team_{team_key}_name", "")},
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/tactics/{tactic_id}")
async def get_tactic(tactic_id: str):
    tactic = await TacticalStore().get_tactic(tactic_id)
    if tactic is None:
        raise HTTPException(404, "tactic not found")
    tactic["source_demo_available"] = Path(tactic["source_demo_path"]).is_file()
    return tactic


class RelinkSourceDemo(BaseModel):
    demo_path: str
    allow_unverified: bool = False


@router.patch("/tactics/{tactic_id}/source-demo")
async def relink_source_demo(tactic_id: str, body: RelinkSourceDemo):
    store = TacticalStore()
    tactic = await store.get_tactic(tactic_id)
    if tactic is None:
        raise HTTPException(404, "tactic not found")
    candidate = Path(body.demo_path).expanduser()
    if candidate.suffix.lower() != ".dem":
        raise HTTPException(422, "source file must be a .dem file")
    if not candidate.is_file():
        raise HTTPException(404, "selected demo file does not exist")
    candidate = candidate.resolve()
    try:
        candidate_hash = await asyncio.to_thread(file_sha256_hex, candidate, chunk_size=1024 * 1024)
    except OSError as exc:
        raise HTTPException(422, f"could not read selected demo: {exc}") from exc

    expected_hash = tactic.get("source_demo_hash")
    if expected_hash:
        if candidate_hash != expected_hash:
            raise HTTPException(409, "selected demo does not match the tactic's original source")
    else:
        original = Path(tactic["source_demo_path"]).expanduser()
        if original.is_file():
            try:
                original_hash = await asyncio.to_thread(file_sha256_hex, original, chunk_size=1024 * 1024)
            except OSError as exc:
                raise HTTPException(422, f"could not verify the original demo: {exc}") from exc
            if candidate_hash != original_hash:
                raise HTTPException(409, "selected demo does not match the tactic's original source")
        elif not body.allow_unverified:
            raise HTTPException(409, {
                "code": "DEMO_UNVERIFIED",
                "message": "This older tactic has no saved source fingerprint. Confirm that the selected demo is the same match.",
            })

    old_path = tactic["source_demo_path"]
    try:
        await store.relink_source_demo(tactic_id, str(candidate), candidate_hash)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    batch_id = (tactic.get("metadata") or {}).get("pov_batch_id")
    batch = _get_batch(batch_id) if batch_id else None
    if batch and _canonical_demo_path(str(batch.get("demo_path") or "")) == _canonical_demo_path(old_path):
        batch["demo_path"] = str(candidate)
        _persist_batch(batch)
    updated = await store.get_tactic(tactic_id)
    updated["source_demo_available"] = True
    return updated


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


class FolderMemberships(BaseModel):
    folder_ids: list[str]


class RenameItem(BaseModel):
    name: str


class RecordingLink(BaseModel):
    batch_id: str


@router.put("/tactics/{tactic_id}/recording")
async def link_recording(tactic_id: str, body: RecordingLink):
    batch = _get_batch(body.batch_id)
    tactic = await TacticalStore().get_tactic(tactic_id)
    if not tactic or not batch:
        raise HTTPException(404, "tactic or recording not found")
    if (batch.get("demo_path") != tactic["source_demo_path"] or
            batch.get("round_number") != tactic["round_number"] or batch.get("side") != tactic["side"]):
        raise HTTPException(422, "recording does not match the tactic")
    await TacticalStore().update_recording(tactic_id, body.batch_id)
    return {"ok": True}


@router.put("/tactics/{tactic_id}/folders")
async def set_tactic_folders(tactic_id: str, body: FolderMemberships):
    try:
        await TacticalStore().set_folders(tactic_id, body.folder_ids)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.patch("/{kind}/{item_id}/name")
async def rename_item(kind: str, item_id: str, body: RenameItem):
    try:
        await TacticalStore().rename(kind, item_id, body.name)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.delete("/folders/{folder_id}")
async def delete_folder(folder_id: str):
    try:
        await TacticalStore().delete_folder(folder_id)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.delete("/tactics/{tactic_id}")
async def delete_tactic(tactic_id: str):
    try:
        await TacticalStore().delete_tactic(tactic_id)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


class ImportTactic(BaseModel):
    format: Literal["cs2-tactic-v1"]
    tactic: dict


@router.post("/import")
async def import_tactic(body: ImportTactic):
    try:
        return await TacticalStore().import_tactic(body.tactic)
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(422, "Invalid tactic file: " + str(exc)) from exc
