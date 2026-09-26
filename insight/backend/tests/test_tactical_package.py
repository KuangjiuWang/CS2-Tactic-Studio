import asyncio
import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.features.tactical_playbook import api
from app.features.tactical_playbook.portable import extract_package, write_package
from app.features.tactical_playbook.storage import TacticalStore

_BATCH_ID = "a" * 32


def _tactic(demo, digest=None):
    return {
        "id": "old-tactic", "name": "Mirage T", "description": "Fast A",
        "map_name": "de_mirage", "side": "T", "round_number": 3,
        "round_start_tick": 100, "freeze_end_tick": 200, "round_end_tick": 1000,
        "source_demo_path": str(demo), "source_demo_hash": digest,
        "metadata": {"pov_batch_id": _BATCH_ID, "analysis_workspace": {
            "demo_path": str(demo), "map_name": "de_mirage", "players": [],
        }},
        "steps": [{"tick": 400, "title": "Smoke", "note": "A execute", "annotations": [{"type": "arrow"}]}],
    }


def _make_media(root):
    batch_id = _BATCH_ID
    batch_dir = root / batch_id
    batch_dir.mkdir(parents=True)
    players = []
    full_videos = []
    proxies = []
    for index in range(1, 6):
        video = batch_dir / f"player{index}.mp4"
        proxy = batch_dir / f"player{index}-proxy.mp4"
        video_bytes = (f"original full quality player {index}" * 20).encode()
        proxy_bytes = (f"low resolution preview player {index}" * 3).encode()
        video.write_bytes(video_bytes)
        proxy.write_bytes(proxy_bytes)
        full_videos.append(video_bytes)
        proxies.append(proxy_bytes)
        players.append({
            "player_name": f"Player {index}", "steam_id64": str(765600 + index),
            "coverage_start_tick": 200, "coverage_end_tick": 1000,
            "status": "Complete", "video_path": str(video), "proxy_path": str(proxy),
            "duration": 12.5, "fps": 60.0, "has_audio": True, "height": 1080,
        })
    return {"id": batch_id, "status": "Complete", "round_number": 3, "side": "T",
            "demo_path": "old-local-path.dem", "tick_rate": 64, "recording_mode": "advanced_obs",
            "players": players}, full_videos, proxies


def test_package_round_trip_preserves_original_media_and_removes_local_paths(tmp_path):
    demo = tmp_path / "match.dem"
    demo_bytes = b"CS2 demo source bytes" * 11
    demo.write_bytes(demo_bytes)
    pov_root = tmp_path / "tactical-povs"
    batch, videos, proxies = _make_media(pov_root)
    tactic = _tactic(demo, hashlib.sha256(demo_bytes).hexdigest())
    package = tmp_path / "share.cstactic"
    write_package(package, tactic, batch, pov_root)

    with zipfile.ZipFile(package) as archive:
        assert all(item.compress_type == zipfile.ZIP_STORED for item in archive.infolist())
        manifest_bytes = archive.read("manifest.json")
        manifest = json.loads(manifest_bytes)
        assert b"old-local-path" not in manifest_bytes
        assert str(demo).encode() not in manifest_bytes
        assert _BATCH_ID.encode() not in manifest_bytes
        assert "demo_path" not in manifest["tactic"]["metadata"]["analysis_workspace"]
        assert archive.read("media/source.dem") == demo_bytes
        for index, expected in enumerate(videos, 1):
            assert archive.read(f"media/player{index}.mp4") == expected
            assert archive.read(f"media/player{index}-preview.mp4") == proxies[index - 1]

    restored = tmp_path / "restored"
    with package.open("rb") as source:
        imported = extract_package(source, restored)
    assert (restored / "source.dem").read_bytes() == demo_bytes
    for index, expected in enumerate(videos, 1):
        assert (restored / f"player{index}.mp4").read_bytes() == expected
        assert (restored / f"player{index}-proxy.mp4").read_bytes() == proxies[index - 1]
    assert imported["assets"]["players"][0]["video"]["sha256"] == hashlib.sha256(videos[0]).hexdigest()


def test_package_import_rejects_media_hash_mismatch(tmp_path):
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    pov_root = tmp_path / "tactical-povs"
    batch, _, _ = _make_media(pov_root)
    package = tmp_path / "share.cstactic"
    write_package(package, _tactic(demo), batch, pov_root)

    corrupted = io.BytesIO()
    with zipfile.ZipFile(package) as original, zipfile.ZipFile(corrupted, "w", compression=zipfile.ZIP_STORED) as changed:
        manifest = json.loads(original.read("manifest.json"))
        manifest["assets"]["players"][0]["video"]["sha256"] = "0" * 64
        changed.writestr("manifest.json", json.dumps(manifest))
        for name in original.namelist():
            if name != "manifest.json":
                changed.writestr(name, original.read(name))
    corrupted.seek(0)
    with pytest.raises(ValueError, match="integrity check"):
        extract_package(corrupted, tmp_path / "bad-import")


def test_package_import_rejects_path_traversal(tmp_path):
    malicious = io.BytesIO()
    with zipfile.ZipFile(malicious, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("../outside.txt", b"do not extract")
    malicious.seek(0)
    destination = tmp_path / "safe-import"
    with pytest.raises(ValueError, match="unsafe file path"):
        extract_package(malicious, destination)
    assert not destination.exists()


def test_tactical_package_export_and_import_create_new_local_batch(tmp_path, monkeypatch):
    async def scenario():
        data_dir = tmp_path / "data"
        pov_root = data_dir / "tactical-povs"
        batch, video_bytes, _ = _make_media(pov_root)
        demo = tmp_path / "match.dem"
        demo.write_bytes(b"the exact source demo")
        batch["demo_path"] = str(demo)
        store = TacticalStore(tmp_path / "tactics.db")
        tactic = await store.create_tactic(
            name="Mirage T", map_name="de_mirage", side="T", demo_path=str(demo),
            round_number=3, round_start_tick=100, freeze_end_tick=200, round_end_tick=1000,
            source_demo_hash=hashlib.sha256(demo.read_bytes()).hexdigest(),
            metadata={"pov_batch_id": batch["id"], "analysis_workspace": {"map_name": "de_mirage", "rounds": []}},
        )
        await store.add_step(tactic["id"], 400, "Smoke", "A execute", [{"type": "arrow"}])
        monkeypatch.setattr(api, "TacticalStore", lambda: store)
        monkeypatch.setattr(api, "get_data_dir", lambda: data_dir)
        monkeypatch.setattr(api, "_batches", {})
        api._persist_batch(batch)

        app = FastAPI()
        app.include_router(api.router)
        with TestClient(app) as client:
            exported = client.get(f"/api/tactical/tactics/{tactic['id']}/export")
            assert exported.status_code == 200
            assert exported.headers["content-disposition"].endswith("filename*=utf-8''Mirage%20T.cstactic")
            imported_response = client.post(
                "/api/tactical/import-package",
                files={"package": ("mirage.cstactic", exported.content, "application/vnd.cs2-tactic+zip")},
            )
            assert imported_response.status_code == 200, imported_response.text
            imported = imported_response.json()

        assert imported["id"] != tactic["id"]
        assert imported["source_demo_available"] is True
        assert imported["source_demo_hash"] == hashlib.sha256(demo.read_bytes()).hexdigest()
        assert imported["steps"][0]["title"] == "Smoke"
        new_batch_id = imported["metadata"]["pov_batch_id"]
        assert new_batch_id != batch["id"]
        new_batch = api._get_batch(new_batch_id)
        assert new_batch["status"] == "Complete"
        for index, expected in enumerate(video_bytes, 1):
            assert (pov_root / new_batch_id / f"player{index}.mp4").read_bytes() == expected
        assert Path(imported["source_demo_path"]).read_bytes() == demo.read_bytes()

    asyncio.run(scenario())
