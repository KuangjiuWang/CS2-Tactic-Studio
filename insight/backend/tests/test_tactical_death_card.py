from pathlib import Path
from types import SimpleNamespace

from app.features.tactical_playbook import api


def test_death_card_filters_draw_the_reference_overlay_only_after_death():
    filters = api._death_card_filters(4.25)

    assert len(filters) == 4
    assert all("gte(t,4.250000)" in value for value in filters)
    assert filters[0].startswith("drawbox=x=0:y=0:w=iw:h=ih:color=black")
    assert "text='YOU DIED'" in filters[-1]


def test_normalizer_extends_round_and_applies_death_card_at_the_shared_tick(tmp_path, monkeypatch):
    source = tmp_path / "source.mkv"
    destination = tmp_path / "player.mp4"
    source.write_bytes(b"captured video")
    commands = []

    monkeypatch.setattr(api, "resolve_ffmpeg_binary", lambda _path: "ffmpeg.exe")
    monkeypatch.setattr(api, "load_config", lambda: SimpleNamespace(ffmpeg_path=""))

    def fake_run(command, **_kwargs):
        commands.append(command)
        Path(command[-1]).write_bytes(b"normalized video")
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(api.subprocess, "run", fake_run)
    api._normalize_pov(
        source,
        destination,
        expected_seconds=12.0,
        source_duration=11.5,
        death_start_seconds=5.25,
    )

    command = commands[0]
    filters = command[command.index("-vf") + 1]
    assert "tpad=stop_mode=clone:stop_duration=0.500000" in filters
    assert "drawtext=" in filters and "text='YOU DIED'" in filters
    assert "gte(t,5.250000)" in filters
    assert command[command.index("-af") + 1] == "apad"
    assert command[command.index("-t") + 1] == "12.000000"
    assert destination.read_bytes() == b"normalized video"
