from pathlib import Path

import pytest

from app.features.tactical_playbook.hlae_capture import (
    HLAECaptureError,
    _install_hlae_ffmpeg_reference,
    _restore_hlae_ffmpeg_reference,
    build_hlae_capture,
    validate_hlae_installation,
)


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

    _restore_hlae_ffmpeg_reference(snapshot)
    assert not ffmpeg_ini.exists()

    ffmpeg_ini.write_text("[Ffmpeg]\nPath=C:\\existing\\ffmpeg.exe\n", encoding="utf-8")
    previous = ffmpeg_ini.read_bytes()
    snapshot = _install_hlae_ffmpeg_reference(files)
    assert snapshot == (ffmpeg_ini, previous)
    _restore_hlae_ffmpeg_reference(snapshot)
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
