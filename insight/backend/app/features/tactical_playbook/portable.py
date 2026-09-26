"""Versioned offline tactical packages with byte-preserving media handling."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import zipfile
from pathlib import Path
from typing import BinaryIO


PACKAGE_FORMAT = "cs2-tactic-package"
PACKAGE_VERSION = 1
MANIFEST_NAME = "manifest.json"
MAX_PACKAGE_BYTES = 100 * 1024**3
MAX_MEMBER_BYTES = 80 * 1024**3
MAX_MANIFEST_BYTES = 64 * 1024**2
CHUNK_SIZE = 1024 * 1024
MAX_SQLITE_INT = 2**63 - 1
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _reject_json_constant(value: str):
    raise ValueError(f"invalid JSON constant: {value}")


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except (OSError, ValueError):
        return False


def _portable_value(value):
    """Drop machine-local paths and identifiers recursively from JSON metadata."""
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            normalized = str(key).casefold()
            if normalized == "pov_batch_id" or normalized.endswith("_path") or normalized in {
                "path", "video_path", "proxy_path", "render_log_path", "stream_url", "proxy_url",
            }:
                continue
            result[key] = _portable_value(item)
        return result
    if isinstance(value, list):
        return [_portable_value(item) for item in value]
    return value


def sanitize_metadata(value: dict) -> dict:
    """Remove machine-bound metadata from an untrusted package before persistence."""
    cleaned = _portable_value(value)
    return cleaned if isinstance(cleaned, dict) else {}


def write_package(output_path: Path, tactic: dict, batch: dict | None, pov_root: Path) -> None:
    """Write ZIP_STORED members by streaming original bytes; do not transcode or recompress."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    assets = {"source_demo": None, "players": [{"video": None, "proxy": None} for _ in range(5)]}
    media_files: list[tuple[str, Path, str | None]] = []

    source_demo = Path(str(tactic.get("source_demo_path") or "")).expanduser()
    if source_demo.is_file():
        media_files.append(("media/source.dem", source_demo, "source_demo"))

    portable_players = []
    recording = None
    if batch:
        batch_id = str(batch.get("id") or "")
        batch_root = (pov_root / batch_id).resolve()
        players = batch.get("players") or []
        if len(players) != 5:
            raise ValueError("the linked POV batch does not contain five player records")
        for index, player in enumerate(players):
            portable_player = {
                "player_name": str(player.get("player_name") or ""),
                "steam_id64": str(player.get("steam_id64") or ""),
                "coverage_start_tick": int(player.get("coverage_start_tick") or player.get("start_tick") or 0),
                "coverage_end_tick": int(player.get("coverage_end_tick") or player.get("end_tick") or 0),
                "status": "Failed",
            }
            if player.get("status") == "Complete":
                video = Path(str(player.get("video_path") or "")).expanduser()
                if not _inside(video, batch_root):
                    raise ValueError(f"player {index + 1} video is outside its local POV batch")
                if not video.is_file() or video.stat().st_size <= 0:
                    raise ValueError(f"player {index + 1} full-quality POV video is missing")
                member = f"media/player{index + 1}.mp4"
                media_files.append((member, video, f"players.{index}.video"))
                portable_player["status"] = "Complete"
                for field in ("duration", "fps", "has_audio", "height"):
                    if field in player and isinstance(player[field], (str, int, float, bool)):
                        portable_player[field] = player[field]
                proxy = Path(str(player.get("proxy_path") or "")).expanduser()
                if proxy.is_file() and _inside(proxy, batch_root):
                    proxy_member = f"media/player{index + 1}-preview.mp4"
                    media_files.append((proxy_member, proxy, f"players.{index}.proxy"))
            portable_players.append(portable_player)
        recording = {
            "recording_mode": str(batch.get("recording_mode") or "obs"),
            "tick_rate": batch.get("tick_rate"),
            "players": portable_players,
        }

    metadata = _portable_value(dict(tactic.get("metadata") or {}))
    manifest = {
        "format": PACKAGE_FORMAT,
        "version": PACKAGE_VERSION,
        "tactic": {
            "name": str(tactic.get("name") or ""),
            "description": str(tactic.get("description") or ""),
            "map_name": str(tactic.get("map_name") or ""),
            "side": str(tactic.get("side") or ""),
            "round_number": tactic.get("round_number"),
            "round_start_tick": tactic.get("round_start_tick"),
            "freeze_end_tick": tactic.get("freeze_end_tick"),
            "round_end_tick": tactic.get("round_end_tick"),
            "source_demo_hash": tactic.get("source_demo_hash"),
            "metadata": metadata,
            "steps": [
                {"tick": step.get("tick"), "title": step.get("title") or "", "note": step.get("note") or "",
                 "annotations": step.get("annotations") or []}
                for step in tactic.get("steps", [])
            ],
        },
        "recording": recording,
        "assets": assets,
    }

    try:
        with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            # Hash each file while copying it into the archive so the manifest describes
            # the exact archived bytes, even if a source changes during export.
            for member, source_path, role in media_files:
                digest = hashlib.sha256()
                size = 0
                with source_path.open("rb") as source, archive.open(member, "w", force_zip64=True) as target:
                    while chunk := source.read(CHUNK_SIZE):
                        target.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                entry = {"member": member, "size": size, "sha256": digest.hexdigest()}
                if role == "source_demo":
                    assets["source_demo"] = entry
                else:
                    _, index_text, kind = role.split(".")
                    assets["players"][int(index_text)][kind] = entry
            expected_hash = tactic.get("source_demo_hash")
            if assets["source_demo"] and expected_hash and assets["source_demo"]["sha256"] != expected_hash:
                raise ValueError("source demo changed since this tactic was saved; relink it before exporting")
            # Preserve the saved fingerprint when the demo is offline, so future relinking
            # can still verify that the selected demo is the original match.
            manifest["tactic"]["source_demo_hash"] = (
                assets["source_demo"]["sha256"] if assets["source_demo"] else expected_hash
            )
            archive.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
    except Exception:
        output_path.unlink(missing_ok=True)
        raise


def _validate_asset(value, expected_member: str) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("member") != expected_member:
        raise ValueError("package contains an invalid media reference")
    size = value.get("size")
    digest = value.get("sha256")
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0 or size > MAX_MEMBER_BYTES:
        raise ValueError("package contains an invalid media size")
    if not isinstance(digest, str) or not _SHA256_RE.fullmatch(digest):
        raise ValueError("package contains an invalid media fingerprint")
    return {"member": expected_member, "size": size, "sha256": digest}


def _validate_manifest(manifest: object) -> tuple[dict, dict[str, Path]]:
    if not isinstance(manifest, dict) or manifest.get("format") != PACKAGE_FORMAT or manifest.get("version") != PACKAGE_VERSION:
        raise ValueError("unsupported tactical package format or version")
    tactic = manifest.get("tactic")
    if not isinstance(tactic, dict):
        raise ValueError("package is missing tactic data")
    assets = manifest.get("assets")
    if not isinstance(assets, dict):
        raise ValueError("package is missing its media index")
    demo = _validate_asset(assets.get("source_demo"), "media/source.dem")
    raw_players = assets.get("players")
    if not isinstance(raw_players, list) or len(raw_players) != 5:
        raise ValueError("package must contain exactly five POV asset slots")
    validated_players = []
    for index, item in enumerate(raw_players):
        if not isinstance(item, dict):
            raise ValueError("package contains an invalid POV media index")
        video = _validate_asset(item.get("video"), f"media/player{index + 1}.mp4")
        proxy = _validate_asset(item.get("proxy"), f"media/player{index + 1}-preview.mp4")
        if proxy and not video:
            raise ValueError("a POV preview cannot exist without its full-quality video")
        validated_players.append({"video": video, "proxy": proxy})
    recording = manifest.get("recording")
    if recording is not None:
        if not isinstance(recording, dict) or not isinstance(recording.get("players"), list) or len(recording["players"]) != 5:
            raise ValueError("package has invalid five-player recording metadata")
        if any(not isinstance(player, dict) for player in recording["players"]):
            raise ValueError("package has invalid player metadata")
        mode = recording.get("recording_mode") or "obs"
        if not isinstance(mode, str) or mode not in {"obs", "advanced_obs", "hlae"}:
            raise ValueError("package has an unsupported POV recording mode")
        raw_tick_rate = recording.get("tick_rate")
        if not isinstance(raw_tick_rate, (int, float)) or isinstance(raw_tick_rate, bool):
            raise ValueError("package has an invalid recording tick rate")
        try:
            tick_rate = float(raw_tick_rate)
        except (ValueError, OverflowError) as exc:
            raise ValueError("package has an invalid recording tick rate") from exc
        if not math.isfinite(tick_rate) or tick_rate <= 0:
            raise ValueError("package has an invalid recording tick rate")
        recording["tick_rate"] = tick_rate
        for index, player in enumerate(recording["players"]):
            status = player.get("status")
            if not isinstance(status, str) or status not in {"Complete", "Failed"}:
                raise ValueError("package has an invalid player recording status")
            if status == "Complete" and not validated_players[index]["video"]:
                raise ValueError("package is missing a completed player's full-quality video")
            if status != "Complete" and validated_players[index]["video"]:
                raise ValueError("package includes video for a player marked incomplete")
            start = player.get("coverage_start_tick", 0)
            end = player.get("coverage_end_tick", 0)
            if (not isinstance(start, int) or isinstance(start, bool) or
                    not isinstance(end, int) or isinstance(end, bool) or
                    start < 0 or end < start or end > MAX_SQLITE_INT):
                raise ValueError("package has an invalid player tick interval")
            for field in ("duration", "fps"):
                value = player.get(field)
                if value is not None and (
                    not isinstance(value, (int, float)) or isinstance(value, bool) or
                    not math.isfinite(value) or value < 0 or (field == "fps" and value == 0)
                ):
                    raise ValueError(f"package has an invalid player {field}")
            if "has_audio" in player and not isinstance(player["has_audio"], bool):
                raise ValueError("package has invalid player audio metadata")
            if "height" in player and (
                not isinstance(player["height"], int) or isinstance(player["height"], bool) or player["height"] < 0
            ):
                raise ValueError("package has invalid player video dimensions")
    elif any(item["video"] or item["proxy"] for item in validated_players):
        raise ValueError("package media has no associated POV recording")

    tactic_required = ("name", "map_name", "side", "round_number", "round_start_tick", "freeze_end_tick", "round_end_tick")
    if any(key not in tactic for key in tactic_required):
        raise ValueError("package tactic is missing required fields")
    if not isinstance(tactic["name"], str) or not tactic["name"].strip() or len(tactic["name"]) > 512:
        raise ValueError("package tactic has an invalid name")
    if not isinstance(tactic["map_name"], str) or not tactic["map_name"].strip() or len(tactic["map_name"]) > 128:
        raise ValueError("package tactic has an invalid map name")
    if tactic["side"] not in {"T", "CT"}:
        raise ValueError("package tactic has an invalid side")
    round_number = tactic["round_number"]
    start, freeze, end = (tactic[key] for key in ("round_start_tick", "freeze_end_tick", "round_end_tick"))
    if (not isinstance(round_number, int) or isinstance(round_number, bool) or round_number < 1 or round_number > MAX_SQLITE_INT or
            any(not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > MAX_SQLITE_INT
                for value in (start, freeze, end)) or not start <= freeze < end):
        raise ValueError("package tactic has an invalid round or tick interval")
    steps = tactic.get("steps", [])
    if not isinstance(steps, list) or len(steps) > 10000:
        raise ValueError("package contains an invalid step list")
    for step in steps:
        if (not isinstance(step, dict) or not isinstance(step.get("tick"), int) or
                isinstance(step.get("tick"), bool) or not start <= step["tick"] <= end or
                not isinstance(step.get("annotations", []), list)):
            raise ValueError("package contains an invalid tactic step")
    if not isinstance(tactic.get("metadata", {}), dict):
        raise ValueError("package contains invalid tactic metadata")
    source_demo_hash = tactic.get("source_demo_hash")
    if source_demo_hash is not None and (not isinstance(source_demo_hash, str) or not _SHA256_RE.fullmatch(source_demo_hash)):
        raise ValueError("package contains an invalid source demo fingerprint")
    tactic["metadata"] = sanitize_metadata(tactic.get("metadata", {}))

    expected_members = {MANIFEST_NAME}
    if demo:
        expected_members.add(demo["member"])
    for item in validated_players:
        for asset in item.values():
            if asset:
                expected_members.add(asset["member"])

    # Member paths are selected from the fixed allow-list, never from uploaded names.
    targets: dict[str, Path] = {}
    if demo:
        targets[demo["member"]] = Path("source.dem")
    for index, item in enumerate(validated_players):
        if item["video"]:
            targets[item["video"]["member"]] = Path(f"player{index + 1}.mp4")
        if item["proxy"]:
            targets[item["proxy"]["member"]] = Path(f"player{index + 1}-proxy.mp4")
    return {**manifest, "assets": {"source_demo": demo, "players": validated_players}, "_expected_members": expected_members}, targets


def extract_package(archive_source: BinaryIO, destination: Path) -> dict:
    """Validate a package and stream verified media into a caller-owned staging directory."""
    try:
        archive_source.seek(0, os.SEEK_END)
        archive_size = archive_source.tell()
        archive_source.seek(0)
        if archive_size <= 0 or archive_size > MAX_PACKAGE_BYTES:
            raise ValueError("tactical package exceeds the supported size limit")
        with zipfile.ZipFile(archive_source, "r") as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) > 12 or len(names) != len(set(names)):
                raise ValueError("package has duplicate or too many files")
            if any("\\" in name or name.startswith(("/", "\\")) or ".." in Path(name).parts for name in names):
                raise ValueError("package contains an unsafe file path")
            by_name = {info.filename: info for info in infos}
            manifest_info = by_name.get(MANIFEST_NAME)
            if not manifest_info or manifest_info.file_size > MAX_MANIFEST_BYTES:
                raise ValueError("package manifest is missing or too large")
            if any(info.is_dir() or info.compress_type != zipfile.ZIP_STORED for info in infos):
                raise ValueError("package entries must be regular, uncompressed files")
            if any(info.flag_bits & 0x1 for info in infos):
                raise ValueError("encrypted tactical packages are not supported")
            if any(stat.S_ISLNK((info.external_attr >> 16) & 0xFFFF) for info in infos):
                raise ValueError("package contains a symbolic link")
            try:
                manifest = json.loads(archive.read(manifest_info).decode("utf-8"), parse_constant=_reject_json_constant)
            except (UnicodeDecodeError, ValueError) as exc:
                raise ValueError("package manifest is not valid UTF-8 JSON") from exc
            try:
                manifest, targets = _validate_manifest(manifest)
            except (TypeError, OverflowError) as exc:
                raise ValueError("package manifest contains invalid field values") from exc
            if set(names) != manifest["_expected_members"]:
                raise ValueError("package contains missing or unlisted files")
            descriptors = {}
            demo = manifest["assets"]["source_demo"]
            if demo:
                descriptors[demo["member"]] = demo
            for player in manifest["assets"]["players"]:
                for asset in player.values():
                    if asset:
                        descriptors[asset["member"]] = asset
            total_size = 0
            for name, descriptor in descriptors.items():
                info = by_name[name]
                if info.file_size != descriptor["size"]:
                    raise ValueError("package media size does not match its manifest")
                total_size += info.file_size
                if info.file_size > MAX_MEMBER_BYTES or total_size > MAX_PACKAGE_BYTES:
                    raise ValueError("package media exceeds the supported size limit")
            destination.mkdir(parents=True, exist_ok=False)
            for member, descriptor in descriptors.items():
                output = destination / targets[member]
                output.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                size = 0
                with archive.open(by_name[member], "r") as source, output.open("xb") as target:
                    while chunk := source.read(CHUNK_SIZE):
                        target.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                        if size > descriptor["size"]:
                            raise ValueError("package media is larger than its manifest")
                if size != descriptor["size"] or digest.hexdigest() != descriptor["sha256"]:
                    raise ValueError(f"package media integrity check failed: {member}")
            manifest.pop("_expected_members", None)
            return manifest
    except (zipfile.BadZipFile, EOFError, RuntimeError, RecursionError) as exc:
        raise ValueError("uploaded file is not a valid tactical package") from exc
