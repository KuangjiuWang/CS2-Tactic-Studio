from pathlib import Path

import pytest

from app.features.tactical_playbook.hlae_capture import (
    HLAECaptureError,
    _ConsoleLogMonitor,
    _install_hlae_ffmpeg_reference,
    _restore_hlae_ffmpeg_reference,
    _descendant_process_ids,
    _capture_files,
    _wait_for_capture,
    build_hlae_capture,
    validate_hlae_installation,
)


def test_hlae_console_monitor_parses_markers_across_log_chunks():
    monitor = _ConsoleLogMonitor()
    monitor.feed('noise\nTL_TARGET {"steamId":"76561197960265728","mode":')
    assert monitor.target is None

    monitor.feed('2}\nTL_RECORD_START {"tick":640,"takeFolder":"takes/one"}')
    assert monitor.target == {"steamId": "76561197960265728", "mode": 2}
    assert monitor.started == {"tick": 640, "takeFolder": "takes/one"}

    monitor.feed('\nTL_RECORD_END {"tick":1280}')
    assert monitor.ended == {"tick": 1280}


def test_hlae_console_monitor_detects_errors_and_bounds_saved_log_tail():
    monitor = _ConsoleLogMonitor(max_chars=24)
    monitor.feed("old diagnostics\nCould not find address for pattern stale\n")
    monitor.feed("TL_ERROR recording failed\n")

    assert monitor.warning == "Could not find address for pattern stale"
    assert monitor.failure == "TL_ERROR recording failed"
    assert len(monitor.excerpt()) <= 24
    assert monitor.excerpt().endswith("recording failed\n")


def install(tmp_path: Path) -> tuple[Path, Path, Path]:
    hlae = tmp_path / "HLAE" / "HLAE.exe"
    root = hlae.parent
    cs2 = tmp_path / "CS2" / "game" / "bin" / "win64" / "cs2.exe"
    for file in (
        hlae,
        root / "x64" / "AfxHookSource2.dll",
        root / "ffmpeg" / "bin" / "ffmpeg.exe",
        cs2,
        cs2.parents[2] / "csgo" / "cfg" / "placeholder.cfg",
    ):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.touch()
    (cs2.parents[2] / "csgo" / "cfg").mkdir(parents=True, exist_ok=True)
    demo = tmp_path / "match.dem"
    demo.touch()
    return hlae, cs2, demo


def test_hlae_generator_uses_source2_recording_and_exact_steamid(tmp_path: Path):
    hlae, cs2, demo = install(tmp_path)
    cfg, script, args = build_hlae_capture(
        hlae_path=str(hlae), cs2_path=str(cs2), demo_path=str(demo),
        output_prefix=str(tmp_path / "pov" / "capture"),
        steam_id64="76561197960265728", start_tick=640, end_tick=1280,
        tick_rate=64, config_name="tactical_0123456789abcdef", fps=60,
    )
    assert "mirv_streams record screen enabled 1" in cfg
    assert "mirv_streams record fps 60" in cfg
    assert "mirv_streams record startMovieWav 1" in cfg
    assert "playdemo \"" in cfg and str(demo).replace("\\", "/") in cfg
    assert "spec_mode 1" in script
    assert "spec_player '+index+'" in script
    assert "tick-lastRelockTick>=32" in script
    assert "mirv_script_spec_lock" not in cfg + script
    assert "76561197960265728" in script
    assert "addAtTick 640" in script and "addAtTick 1280" in script
    assert "mirv_streams record start" in script and "mirv_streams record end" in script
    assert "events.recordStart" not in script and "events.recordEnd" not in script
    assert args[0:3] == ["-customLoader", "-noGui", "-autoStart"]
    assert "-insecure" in args[-1]
    assert "host_framerate" not in cfg + script


def test_hlae_requires_a_complete_source2_install_and_real_demo(tmp_path: Path):
    hlae, cs2, demo = install(tmp_path)
    assert validate_hlae_installation(str(hlae), str(cs2))["hook"].is_file()
    with pytest.raises(HLAECaptureError, match="quotes, semicolons"):
        build_hlae_capture(
            hlae_path=str(hlae), cs2_path=str(cs2), demo_path=str(demo),
            output_prefix=str(tmp_path / "unsafe;path"),
            steam_id64="76561197960265728", start_tick=1, end_tick=64,
            tick_rate=64, config_name="tactical_0123456789abcdef",
        )
    (hlae.parent / "x64" / "AfxHookSource2.dll").unlink()
    with pytest.raises(HLAECaptureError, match="Incomplete HLAE installation"):
        validate_hlae_installation(str(hlae), str(cs2))


def test_hlae_reuses_app_ffmpeg_without_leaving_global_ini_changes(tmp_path: Path):
    hlae, cs2, _ = install(tmp_path)
    root = hlae.parent
    bundled = root / "ffmpeg" / "bin" / "ffmpeg.exe"
    bundled.unlink()
    external = tmp_path / "app-tools" / "ffmpeg.exe"
    external.parent.mkdir(parents=True)
    external.touch()
    ffmpeg_ini = root / "ffmpeg" / "ffmpeg.ini"

    files = validate_hlae_installation(str(hlae), str(cs2), str(external))
    assert files["ffmpeg"] == external.resolve()
    snapshot = _install_hlae_ffmpeg_reference(files)
    assert snapshot == (ffmpeg_ini, None)
    assert "Path=" + str(external.resolve()) in ffmpeg_ini.read_text(encoding="utf-8")

    assert _restore_hlae_ffmpeg_reference(snapshot) is True
    assert not ffmpeg_ini.exists()

    ffmpeg_ini.write_text("[Ffmpeg]\nPath=C:\\existing\\ffmpeg.exe\n", encoding="utf-8")
    previous = ffmpeg_ini.read_bytes()
    snapshot = _install_hlae_ffmpeg_reference(files)
    assert snapshot == (ffmpeg_ini, previous)
    assert _restore_hlae_ffmpeg_reference(snapshot) is True
    assert ffmpeg_ini.read_bytes() == previous


def test_hlae_reports_ffmpeg_ini_restore_failure(tmp_path: Path, monkeypatch):
    ffmpeg_ini = tmp_path / "ffmpeg.ini"
    ffmpeg_ini.write_text("[Ffmpeg]\nPath=temporary.exe\n", encoding="utf-8")

    def fail_replace(_source, _destination):
        raise PermissionError("file is locked")

    monkeypatch.setattr("app.features.tactical_playbook.hlae_capture.os.replace", fail_replace)
    assert _restore_hlae_ffmpeg_reference((ffmpeg_ini, b"[Ffmpeg]\nPath=original.exe\n")) is False


def test_hlae_ffmpeg_ini_update_is_atomic_on_replace_failure(tmp_path: Path, monkeypatch):
    hlae, cs2, _ = install(tmp_path)
    hlae_root = hlae.parent
    local_ffmpeg = hlae_root / "ffmpeg" / "bin" / "ffmpeg.exe"
    local_ffmpeg.unlink()
    external = tmp_path / "app-tools" / "ffmpeg.exe"
    external.parent.mkdir(parents=True)
    external.touch()
    ffmpeg_ini = hlae_root / "ffmpeg" / "ffmpeg.ini"
    ffmpeg_ini.write_bytes(b"[Ffmpeg]\r\nPath=original.exe\r\n")
    previous = ffmpeg_ini.read_bytes()

    def fail_replace(_source, _destination):
        raise PermissionError("file is locked")

    monkeypatch.setattr("app.features.tactical_playbook.hlae_capture.os.replace", fail_replace)
    files = validate_hlae_installation(str(hlae), str(cs2), str(external))
    with pytest.raises(HLAECaptureError, match="Could not configure HLAE's FFmpeg path"):
        _install_hlae_ffmpeg_reference(files)
    assert ffmpeg_ini.read_bytes() == previous


def test_hlae_config_generator_accepts_the_app_ffmpeg_path(tmp_path: Path):
    hlae, cs2, demo = install(tmp_path)
    (hlae.parent / "ffmpeg" / "bin" / "ffmpeg.exe").unlink()
    external = tmp_path / "app-tools" / "ffmpeg.exe"
    external.parent.mkdir(parents=True)
    external.touch()

    cfg, _, _ = build_hlae_capture(
        hlae_path=str(hlae), cs2_path=str(cs2), demo_path=str(demo),
        output_prefix=str(tmp_path / "pov" / "capture"),
        steam_id64="76561197960265728", start_tick=640, end_tick=1280,
        tick_rate=64, config_name="tactical_0123456789abcdef",
        ffmpeg_path=str(external),
    )
    assert "mirv_streams settings edit afxDefault settings afxFfmpeg" in cfg


@pytest.mark.parametrize(
    ("tick_rate", "start_tick", "end_tick", "width", "height"),
    [
        (0, 10, 20, 1280, 720),
        (float("nan"), 10, 20, 1280, 720),
        (float("inf"), 10, 20, 1280, 720),
        (64, 10, 20, 0, 720),
        (64, 10, 20, 1280, 10000),
    ],
)
def test_hlae_generator_rejects_invalid_tick_rates_and_resolutions(
    tmp_path: Path, tick_rate: float, start_tick: int, end_tick: int, width: int, height: int,
):
    hlae, cs2, demo = install(tmp_path)
    with pytest.raises(HLAECaptureError, match="tick rate, output FPS, or resolution"):
        build_hlae_capture(
            hlae_path=str(hlae), cs2_path=str(cs2), demo_path=str(demo),
            output_prefix=str(tmp_path / "pov" / "capture"),
            steam_id64="76561197960265728", start_tick=start_tick, end_tick=end_tick,
            tick_rate=tick_rate, config_name="tactical_0123456789abcdef",
            width=width, height=height,
        )


def test_hlae_generator_rejects_negative_ticks(tmp_path: Path):
    hlae, cs2, demo = install(tmp_path)
    with pytest.raises(HLAECaptureError, match="capture tick range"):
        build_hlae_capture(
            hlae_path=str(hlae), cs2_path=str(cs2), demo_path=str(demo),
            output_prefix=str(tmp_path / "pov" / "capture"),
            steam_id64="76561197960265728", start_tick=-1, end_tick=20,
            tick_rate=64, config_name="tactical_0123456789abcdef",
        )


def test_hlae_generator_rejects_non_integer_fps(tmp_path: Path):
    hlae, cs2, demo = install(tmp_path)
    with pytest.raises(HLAECaptureError, match="output FPS"):
        build_hlae_capture(
            hlae_path=str(hlae), cs2_path=str(cs2), demo_path=str(demo),
            output_prefix=str(tmp_path / "pov" / "capture"),
            steam_id64="76561197960265728", start_tick=10, end_tick=20,
            tick_rate=64, config_name="tactical_0123456789abcdef", fps=60.0,
        )


def test_hlae_process_tree_finds_only_descendants_of_the_custom_loader():
    snapshot = {
        10: (1, "HLAE.exe"),
        11: (10, "helper.exe"),
        12: (11, "cs2.exe"),
        20: (1, "cs2.exe"),
    }
    assert _descendant_process_ids(10, snapshot) == {11, 12}


def test_capture_scan_ignores_files_deleted_during_scan(tmp_path: Path, monkeypatch):
    video = tmp_path / "capture.mp4"
    audio = tmp_path / "capture.wav"
    video.write_bytes(b"video")
    audio.write_bytes(b"audio")
    original_stat = Path.stat

    def flaky_stat(path, *args, **kwargs):
        if path == video:
            raise FileNotFoundError(path)
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", flaky_stat)
    assert _capture_files(tmp_path) == (None, audio)


def test_wait_for_capture_returns_only_after_both_outputs_stop_growing(tmp_path: Path, monkeypatch):
    video = tmp_path / "capture.mp4"
    audio = tmp_path / "capture.wav"
    video.write_bytes(b"video")
    audio.write_bytes(b"audio")
    now = [0.0]
    monkeypatch.setattr("app.features.tactical_playbook.hlae_capture.time.monotonic", lambda: now[0])
    monkeypatch.setattr("app.features.tactical_playbook.hlae_capture.time.sleep", lambda delay: now.__setitem__(0, now[0] + delay))

    assert _wait_for_capture(tmp_path, deadline=10.0) == (video, audio)
