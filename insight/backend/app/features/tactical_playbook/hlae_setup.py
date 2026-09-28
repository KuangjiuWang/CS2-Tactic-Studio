"""Local discovery helpers for the HLAE setup and repair action."""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Any


def _as_hlae_executable(value: object) -> Path | None:
    raw = str(value or "").strip().strip('"')
    if not raw:
        return None
    try:
        candidate = Path(raw).expanduser()
    except (OSError, ValueError):
        return None
    if candidate.is_dir():
        candidate = candidate / "HLAE.exe"
    elif candidate.name.lower() != "hlae.exe":
        return None
    try:
        return candidate.resolve() if candidate.is_file() else None
    except OSError:
        return None


def _registry_hlae_candidates() -> list[Path]:
    if os.name != "nt":
        return []
    try:
        import winreg
    except ImportError:
        return []

    candidates: list[Path] = []
    uninstall_path = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"
    views = [0]
    for view_name in ("KEY_WOW64_64KEY", "KEY_WOW64_32KEY"):
        view = getattr(winreg, view_name, 0)
        if view and view not in views:
            views.append(view)

    for hive_name in ("HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE"):
        hive = getattr(winreg, hive_name, None)
        if hive is None:
            continue
        for view in views:
            try:
                root = winreg.OpenKey(hive, uninstall_path, 0, winreg.KEY_READ | view)
            except OSError:
                continue
            with root:
                index = 0
                while True:
                    try:
                        subkey_name = winreg.EnumKey(root, index)
                    except OSError:
                        break
                    index += 1
                    try:
                        with winreg.OpenKey(root, subkey_name) as entry:
                            display_name = str(winreg.QueryValueEx(entry, "DisplayName")[0]).casefold()
                            if not any(token in display_name for token in ("hlae", "advancedfx", "advanced effects")):
                                continue
                            for value_name in ("InstallLocation", "DisplayIcon", "UninstallString"):
                                try:
                                    raw = str(winreg.QueryValueEx(entry, value_name)[0]).strip()
                                except OSError:
                                    continue
                                quoted = re.match(r'^"([^\"]+)"', raw)
                                raw_path = quoted.group(1) if quoted else raw.split(",", 1)[0].strip()
                                path = Path(raw_path.strip('"'))
                                candidates.append(path if path.suffix.lower() == ".exe" else path / "HLAE.exe")
                    except OSError:
                        continue
    return candidates


def discover_hlae_installation(configured_path: str = "") -> dict[str, Any] | None:
    """Find an installed HLAE executable and report whether its Source 2 hook exists."""
    candidate_values: list[object] = [configured_path]
    for env_name in ("HLAE_PATH", "HLAE_HOME"):
        candidate_values.append(os.environ.get(env_name, ""))

    program_files = [os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")]
    for root in program_files:
        if root:
            candidate_values.extend((Path(root) / "HLAE", Path(root) / "AdvancedFX" / "HLAE"))
    for env_name in ("LOCALAPPDATA", "APPDATA"):
        root = os.environ.get(env_name)
        if root:
            candidate_values.extend((Path(root) / "HLAE", Path(root) / "AdvancedFX" / "HLAE"))
    candidate_values.extend((Path(r"C:\HLAE"), Path(r"C:\Program Files (x86)\HLAE")))
    candidate_values.extend(_registry_hlae_candidates())

    path_entry = shutil.which("HLAE.exe")
    if path_entry:
        candidate_values.append(path_entry)

    seen: set[str] = set()
    first_incomplete: dict[str, Any] | None = None
    for value in candidate_values:
        executable = _as_hlae_executable(value)
        if executable is None:
            continue
        key = os.path.normcase(str(executable))
        if key in seen:
            continue
        seen.add(key)
        hook = executable.parent / "x64" / "AfxHookSource2.dll"
        result = {
            "path": str(executable),
            "hook_path": str(hook),
            "hook_ok": hook.is_file(),
        }
        if result["hook_ok"]:
            return result
        if first_incomplete is None:
            first_incomplete = result
    return first_incomplete
