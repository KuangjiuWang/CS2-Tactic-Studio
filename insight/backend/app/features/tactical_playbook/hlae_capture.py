"""Real CS2 Source 2 POV capture through HLAE's Custom Loader."""

from __future__ import annotations

import csv
import ctypes
from collections import deque
import io
import json
import math
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Callable


class HLAECaptureError(RuntimeError):
    pass


def _console_path(value: str | Path) -> str:
    raw = str(value)
    if any(char in raw for char in ('"', ";", "\r", "\n")):
        raise HLAECaptureError("HLAE paths cannot contain quotes, semicolons, or line breaks.")
    return raw.replace("\\", "/")


def _ffmpeg_from_ini(ini_path: Path) -> Path | None:
    try:
        content = ini_path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError):
        return None
    match = re.search(r"(?im)^\s*Path\s*=\s*(.*?)\s*$", content)
    if not match or not match.group(1):
        return None
    candidate = Path(match.group(1).strip().strip('"')).expanduser()
    return candidate.resolve() if candidate.is_file() else None


def _write_atomic(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{os.urandom(6).hex()}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def validate_hlae_installation(
    hlae_path: str, cs2_path: str, ffmpeg_path: str | None = None,
) -> dict[str, Path]:
    executable = Path(hlae_path).expanduser()
    game = Path(cs2_path).expanduser()
    if not executable.is_file() or executable.name.lower() != "hlae.exe":
        raise HLAECaptureError("HLAE mode requires a valid HLAE.exe path. Set it in Settings → Paths.")
    if not game.is_file() or game.name.lower() != "cs2.exe":
        raise HLAECaptureError("HLAE mode requires the configured CS2 executable (cs2.exe).")
    root = executable.resolve().parent
    files = {
        "hlae": executable.resolve(),
        "cs2": game.resolve(),
        "hook": root / "x64" / "AfxHookSource2.dll",
    }
    missing = [str(path) for key, path in files.items() if key not in {"hlae", "cs2"} and not path.is_file()]
    if missing:
        raise HLAECaptureError("Incomplete HLAE installation; missing: " + ", ".join(missing))
    local_ffmpeg = root / "ffmpeg" / "bin" / "ffmpeg.exe"
    ini_path = root / "ffmpeg" / "ffmpeg.ini"
    selected_ffmpeg = local_ffmpeg if local_ffmpeg.is_file() else _ffmpeg_from_ini(ini_path)
    if selected_ffmpeg is None and ffmpeg_path:
        candidate = Path(ffmpeg_path).expanduser()
        if candidate.is_file():
            selected_ffmpeg = candidate.resolve()
    if selected_ffmpeg is None:
        raise HLAECaptureError(
            "HLAE screen recording needs FFmpeg. Install it in HLAE's ffmpeg folder "
            "or configure the app's FFmpeg path in Settings → Paths."
        )
    files["ffmpeg"] = selected_ffmpeg
    return files


def _install_hlae_ffmpeg_reference(files: dict[str, Path]) -> tuple[Path, bytes | None] | None:
    """Temporarily point HLAE's documented ffmpeg.ini at the app FFmpeg binary."""
    hlae_root = files["hlae"].parent
    local_ffmpeg = (hlae_root / "ffmpeg" / "bin" / "ffmpeg.exe").resolve()
    selected = files["ffmpeg"].resolve()
    ini_path = hlae_root / "ffmpeg" / "ffmpeg.ini"
    if selected == local_ffmpeg or _ffmpeg_from_ini(ini_path) == selected:
        return None
    if any(char in str(selected) for char in ("\r", "\n")):
        raise HLAECaptureError("FFmpeg path cannot contain line breaks.")
    try:
        previous = ini_path.read_bytes() if ini_path.exists() else None
        ini_path.parent.mkdir(parents=True, exist_ok=True)
        _write_atomic(ini_path, f"[Ffmpeg]\nPath={selected}\n".encode("utf-8"))
    except OSError as exc:
        raise HLAECaptureError(f"Could not configure HLAE's FFmpeg path: {exc}") from exc
    return ini_path, previous


def _restore_hlae_ffmpeg_reference(snapshot: tuple[Path, bytes | None] | None) -> bool:
    if snapshot is None:
        return True
    path, previous = snapshot
    try:
        if previous is None:
            path.unlink(missing_ok=True)
        else:
            _write_atomic(path, previous)
        return True
    except OSError:
        return False


def build_hlae_capture(
    *, hlae_path: str, cs2_path: str, demo_path: str, output_prefix: str,
    steam_id64: str, start_tick: int, end_tick: int, tick_rate: float,
    config_name: str, fps: int = 60, width: int = 1280, height: int = 720,
    ffmpeg_path: str | None = None,
) -> tuple[str, str, list[str]]:
    """Build Source 2 cfg/script and official HLAE Custom Loader arguments."""
    files = validate_hlae_installation(hlae_path, cs2_path, ffmpeg_path)
    demo = Path(demo_path).expanduser().resolve(strict=True)
    if not demo.is_file() or demo.suffix.lower() != ".dem":
        raise HLAECaptureError("HLAE capture requires a real .dem file.")
    if not re.fullmatch(r"\d{17}", steam_id64):
        raise HLAECaptureError("HLAE capture needs the player's SteamID64.")
    if not (
        isinstance(start_tick, int) and not isinstance(start_tick, bool)
        and isinstance(end_tick, int) and not isinstance(end_tick, bool)
        and start_tick >= 0 and end_tick > start_tick
    ):
        raise HLAECaptureError("Invalid HLAE capture tick range.")
    try:
        valid_tick_rate = math.isfinite(float(tick_rate)) and float(tick_rate) > 0
    except (TypeError, ValueError, OverflowError):
        valid_tick_rate = False
    valid_dimensions = (
        isinstance(width, int) and not isinstance(width, bool)
        and isinstance(height, int) and not isinstance(height, bool)
        and 320 <= width <= 7680 and 240 <= height <= 4320
        and width * height <= 33_177_600
    )
    valid_fps = isinstance(fps, int) and not isinstance(fps, bool) and fps in {30, 60, 120}
    if not valid_tick_rate or not valid_fps or not valid_dimensions:
        raise HLAECaptureError("Invalid HLAE tick rate, output FPS, or resolution.")
    if not re.fullmatch(r"tactical_[a-f0-9]{16,32}", config_name):
        raise HLAECaptureError("Invalid generated CS2 config name.")

    demo_arg = _console_path(demo)
    output_arg = _console_path(output_prefix)
    # Job-specific command names prevent a previous player job from matching a callback.
    token = config_name.removeprefix("tactical_")[:16]
    start_command = f"tl_{token}_record_start"
    end_command = f"tl_{token}_record_end"
    cfg = "\n".join((
        "// CS2 Source 2 HLAE capture; no Source 1 commands.",
        "mirv_streams record screen enabled 1",
        f"mirv_streams record fps {fps}",
        f'mirv_streams record name "{output_arg}"',
        "mirv_streams settings edit afxDefault settings afxFfmpeg",
        "mirv_streams record startMovieWav 1",
        "volume 1",
        "demo_timescale 1",
        f'mirv_script_load "{_console_path(Path(output_prefix).parent / "capture.js")}"',
        f'playdemo "{demo_arg}"',
    ))

    script = f'''"use strict";
(() => {{
 const id={json.dumps("tactical-" + token)};
 const targetSteamId={json.dumps(steam_id64)};
 let armed=false,index=0,finished=false,startRequested=false;
 let startTick=null,endTick=null,lastRelockTick=-100000;
 const observed=()=>{{
  const local=mirv.getEntityFromSplitScreenPlayer(0);if(!local)return null;
  const pawn=mirv.getEntityFromIndex(mirv.getHandleEntryIndex(local.getPlayerPawnHandle()));if(!pawn)return null;
  const target=mirv.getEntityFromIndex(mirv.getHandleEntryIndex(pawn.getObserverTargetHandle()));if(!target||!target.isPlayerPawn())return null;
  const controller=mirv.getEntityFromIndex(mirv.getHandleEntryIndex(target.getPlayerControllerHandle()));if(!controller)return null;
  return {{steamId:String(controller.getSteamId()),mode:pawn.getObserverMode()}};
 }};
 const findPlayer=()=>{{for(let i=1;i<=1024;i++){{const entity=mirv.getEntityFromIndex(i);if(entity&&entity.isPlayerController()&&String(entity.getSteamId())===targetSteamId)return i;}}return 0;}};
 const startCommand=new AdvancedfxConCommand(()=>{{
  const target=mirv.getEntityFromIndex(index),view=observed();
  if(!target||!target.isPlayerController()||String(target.getSteamId())!==targetSteamId||!view||view.steamId!==targetSteamId||view.mode!==2){{mirv.message('TL_ERROR actual in-eye spectator target mismatch '+JSON.stringify(view)+'\\n');return;}}
  startRequested=true;startTick=mirv.getDemoTick();mirv.message('TL_TARGET '+JSON.stringify({{index,steamId:view.steamId,mode:view.mode,tick:startTick}})+'\\n');
  mirv.exec('mirv_streams record start');
  mirv.message('TL_RECORD_START '+JSON.stringify({{tick:startTick}})+'\\n');
 }});
 startCommand.register({json.dumps(start_command)},'');
 const endCommand=new AdvancedfxConCommand(()=>{{if(finished)return;finished=true;endTick=mirv.getDemoTick();mirv.exec('mirv_streams record end; demo_pause');mirv.message('TL_RECORD_END '+JSON.stringify({{tick:endTick,startTick}})+'\\n');}});
 endCommand.register({json.dumps(end_command)},'');
 mirv.events.clientFrameStageNotify.on(id,e=>{{
  if(e.isBefore||!mirv.isPlayingDemo())return;
  const tick=mirv.getDemoTick();if(tick===undefined)return;
  if(!armed&&tick>0){{
   index=findPlayer();if(!index)return;
   armed=true;lastRelockTick=tick;mirv.message('TL_PLAYER '+index+' '+targetSteamId+'\\n');
   mirv.exec('spec_mode 1; spec_player '+index+'; mirv_cmd clear; mirv_cmd addAtTick {start_tick} "{start_command}"; mirv_cmd addAtTick {end_tick} "{end_command}"; mirv_skip tick to {max(0, start_tick - round(tick_rate * 3))}; demo_resume');
  }}
  if(armed&&!finished){{
   const target=mirv.getEntityFromIndex(index);
   if(!target||!target.isPlayerController()||String(target.getSteamId())!==targetSteamId){{
    const replacement=findPlayer();
    if(replacement){{index=replacement;mirv.message('TL_RELOCK '+index+'\\n');}}
    else if(startRequested){{finished=true;mirv.message('TL_ERROR target controller disappeared during recording\\n');mirv.exec('mirv_streams record end; demo_pause');}}
   }}
   const view=observed();
   if(tick-lastRelockTick>=32&&(!view||view.steamId!==targetSteamId||(!startRequested&&view.mode!==2))){{
    lastRelockTick=tick;mirv.exec('spec_mode 1; spec_player '+index);mirv.message('TL_RELOCK '+index+' '+tick+'\\n');
   }}
  }}
  if(armed&&!startRequested&&tick>{start_tick + round(tick_rate)}){{mirv.message('TL_ERROR missed start tick\\n');finished=true;mirv.exec('demo_pause');}}
 }});
 globalThis.tacticalCapture={{startCommand,endCommand}};
}})();'''

    cmd_line = (
        f"-steam -insecure -console -condebug -novid -nojoy -windowed "
        f"-w {width} -h {height} +exec {config_name}"
    )
    args = [
        "-customLoader", "-noGui", "-autoStart",
        "-programPath", str(files["cs2"]),
        "-hookDllPath", str(files["hook"]),
        "-cmdLine", cmd_line,
    ]
    return cfg, script, args


def _cs2_pids() -> list[int]:
    try:
        result = subprocess.run(
            ["tasklist.exe", "/FI", "IMAGENAME eq cs2.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    pids: list[int] = []
    for row in csv.reader(io.StringIO(result.stdout)):
        if len(row) >= 2 and row[0].casefold() == "cs2.exe":
            try:
                pids.append(int(row[1].replace(",", "")))
            except ValueError:
                pass
    return pids


def _windows_process_snapshot() -> dict[int, tuple[int, str]]:
    """Return PID -> (parent PID, executable name) without shelling out per poll."""
    if os.name != "nt":
        return {}
    try:
        from ctypes import wintypes

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", wintypes.LONG),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
        kernel32.Process32FirstW.restype = wintypes.BOOL
        kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
        kernel32.Process32NextW.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
        if snapshot in (None, ctypes.c_void_p(-1).value):
            return {}
        result: dict[int, tuple[int, str]] = {}
        try:
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(entry)
            more = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
            while more:
                result[int(entry.th32ProcessID)] = (
                    int(entry.th32ParentProcessID), str(entry.szExeFile),
                )
                more = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
        finally:
            kernel32.CloseHandle(snapshot)
        return result
    except (AttributeError, OSError, TypeError, ValueError):
        return {}


def _descendant_process_ids(root_pid: int, snapshot: dict[int, tuple[int, str]]) -> set[int]:
    children: dict[int, list[int]] = {}
    for pid, (parent_pid, _name) in snapshot.items():
        children.setdefault(parent_pid, []).append(pid)
    descendants: set[int] = set()
    pending = [root_pid]
    while pending:
        parent_pid = pending.pop()
        for child_pid in children.get(parent_pid, ()):
            if child_pid not in descendants:
                descendants.add(child_pid)
                pending.append(child_pid)
    return descendants


def _visible_window_titles(pid: int) -> list[str]:
    if os.name != "nt":
        return []
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user32.IsWindowVisible.argtypes = [wintypes.HWND]
        user32.IsWindowVisible.restype = wintypes.BOOL
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        user32.GetWindowTextLengthW.restype = ctypes.c_int
        user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        user32.GetWindowTextW.restype = ctypes.c_int
        user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
        user32.EnumWindows.restype = wintypes.BOOL
        titles: list[str] = []

        def visit(hwnd: int, _lparam: int) -> bool:
            if not user32.IsWindowVisible(hwnd):
                return True
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value != pid:
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return True
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buffer, len(buffer))
            if buffer.value:
                titles.append(buffer.value)
            return True

        user32.EnumWindows(callback_type(visit), 0)
        return titles
    except (AttributeError, OSError, ValueError):
        return []


def _read_new_console(console_log: Path, offset: int) -> tuple[str, int]:
    try:
        size = console_log.stat().st_size
        if size < offset:
            offset = 0
        with console_log.open("rb") as handle:
            handle.seek(offset)
            data = handle.read(2_000_000)
        return data.decode("utf-8", errors="replace"), offset + len(data)
    except FileNotFoundError:
        return "", offset


def _marker(text: str, name: str) -> dict | None:
    match = re.search(rf"{re.escape(name)} (\{{[^\r\n]+\}})", text)
    if not match:
        return None
    try:
        value = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


class _ConsoleLogMonitor:
    """Parse new console lines once while retaining a bounded diagnostic tail."""

    _WARNING = re.compile(
        r"Could not find address for pattern[^\r\n]*|Problem in .*AfxHookSource2[^\r\n]*"
    )
    _FAILURE = re.compile(
        r"TL_ERROR[^\r\n]*|AFXERROR: Failed writing image[^\r\n]*|"
        r"Error loading[^\r\n]*capture\.js[^\r\n]*",
        re.IGNORECASE,
    )

    def __init__(self, max_chars: int = 4_000_000) -> None:
        self.max_chars = max(1, max_chars)
        self._tail: deque[str] = deque()
        self._tail_size = 0
        self._pending_line = ""
        self._last_partial_line = ""
        self.warning: str | None = None
        self.failure: str | None = None
        self.target: dict | None = None
        self.started: dict | None = None
        self.ended: dict | None = None

    def _append_tail(self, text: str) -> None:
        if not text:
            return
        self._tail.append(text)
        self._tail_size += len(text)
        overflow = self._tail_size - self.max_chars
        while overflow > 0 and self._tail:
            first = self._tail[0]
            if len(first) <= overflow:
                self._tail.popleft()
                self._tail_size -= len(first)
                overflow -= len(first)
            else:
                self._tail[0] = first[overflow:]
                self._tail_size -= overflow
                overflow = 0

    def _parse_line(self, line: str) -> None:
        if self.warning is None:
            warning = self._WARNING.search(line)
            if warning:
                self.warning = warning.group(0)
        if self.failure is None:
            failure = self._FAILURE.search(line)
            if failure:
                self.failure = failure.group(0)
        if self.target is None:
            self.target = _marker(line, "TL_TARGET")
        if self.started is None:
            self.started = _marker(line, "TL_RECORD_START")
        if self.ended is None:
            self.ended = _marker(line, "TL_RECORD_END")

    def feed(self, text: str) -> None:
        if not text:
            return
        self._append_tail(text)
        lines = (self._pending_line + text).split("\n")
        self._pending_line = lines.pop()
        for line in lines:
            self._parse_line(line)
        # Console writers can expose a complete marker before writing its newline.
        # Re-scan only when that partial line actually grows.
        if self._pending_line and self._pending_line != self._last_partial_line:
            self._parse_line(self._pending_line)
        self._last_partial_line = self._pending_line

    def excerpt(self) -> str:
        return "".join(self._tail)


def _capture_files(folder: Path) -> tuple[Path | None, Path | None]:
    if not folder.is_dir():
        return None, None
    videos: list[tuple[float, Path]] = []
    wavs: list[tuple[float, Path]] = []
    for root, _, names in os.walk(folder):
        for name in names:
            path = Path(root) / name
            suffix = path.suffix.lower()
            if suffix not in {".mp4", ".avi", ".mov", ".wav"}:
                continue
            try:
                entry = (path.stat().st_mtime, path)
            except OSError:
                # HLAE may still be renaming a take while this directory is scanned.
                continue
            (wavs if suffix == ".wav" else videos).append(entry)
    videos.sort(key=lambda item: item[0], reverse=True)
    wavs.sort(key=lambda item: item[0], reverse=True)
    return (videos[0][1] if videos else None, wavs[0][1] if wavs else None)


def _wait_for_capture(folder: Path, deadline: float) -> tuple[Path, Path]:
    previous: tuple[str, int, str, int] | None = None
    stable = 0
    while time.monotonic() < deadline:
        video, audio = _capture_files(folder)
        if video and audio:
            try:
                signature = (str(video), video.stat().st_size, str(audio), audio.stat().st_size)
            except OSError:
                signature = None
            if signature and signature[1] > 0 and signature[3] > 0 and signature == previous:
                stable += 1
                if stable >= 3:
                    return video, audio
            else:
                stable = 0
            previous = signature
        time.sleep(0.5)
    raise HLAECaptureError("HLAE ended recording, but its real video and game WAV did not finish writing.")


def run_hlae_capture(
    *, files: dict[str, Path], demo_path: str, steam_id64: str,
    start_tick: int, end_tick: int, tick_rate: float, output_dir: Path,
    fps: int = 60, timeout_seconds: int = 1800,
    report: Callable[[str, str], None] | None = None,
) -> dict:
    """Launch one isolated CS2+HLAE POV and return only verified engine files."""
    if not isinstance(timeout_seconds, int) or isinstance(timeout_seconds, bool) or timeout_seconds <= 0:
        raise HLAECaptureError("HLAE timeout must be a positive number of seconds.")
    output_dir.mkdir(parents=True, exist_ok=True)
    cs2_game = files["cs2"].parents[2]
    csgo = cs2_game / "csgo"
    config_dir = csgo / "cfg"
    if not config_dir.is_dir():
        raise HLAECaptureError(f"CS2 cfg directory not found: {config_dir}")
    console_log = csgo / "console.log"
    config_name = f"tactical_{os.urandom(8).hex()}"
    output_prefix = output_dir / "capture"
    cfg_text, script_text, args = build_hlae_capture(
        hlae_path=str(files["hlae"]), cs2_path=str(files["cs2"]),
        demo_path=demo_path, output_prefix=str(output_prefix),
        steam_id64=steam_id64, start_tick=start_tick, end_tick=end_tick,
        tick_rate=tick_rate, config_name=config_name, fps=fps,
        ffmpeg_path=str(files["ffmpeg"]),
    )
    script_path = output_dir / "capture.js"
    config_file = config_dir / f"{config_name}.cfg"
    script_path.write_text(script_text, encoding="utf-8")
    (output_dir / "capture.cfg").write_text(cfg_text, encoding="utf-8")
    (output_dir / "launch.json").write_text(
        json.dumps({"executable": str(files["hlae"]), "arguments": args,
                    "player_steam_id64": steam_id64, "start_tick": start_tick,
                    "end_tick": end_tick}, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    try:
        with config_file.open("x", encoding="utf-8") as handle:
            handle.write(cfg_text.replace(
                f'{_console_path(Path(output_prefix).parent / "capture.js")}',
                _console_path(script_path),
            ))
    except FileExistsError as exc:
        raise HLAECaptureError("Generated CS2 config name unexpectedly already exists.") from exc

    # Require an idle CS2 baseline before launch; later process-tree checks tie the game to HLAE.
    existing = _cs2_pids()
    if existing:
        try:
            config_file.unlink(missing_ok=True)
        except OSError:
            pass
        raise HLAECaptureError("Close CS2 before starting the isolated HLAE POV renderer.")
    try:
        log_offset = console_log.stat().st_size
    except OSError:
        log_offset = 0
    launcher: subprocess.Popen | None = None
    game_pid: int | None = None
    owned_game_pids: set[int] = set()
    launcher_exit_seen_at: float | None = None
    ffmpeg_ini_snapshot: tuple[Path, bytes | None] | None = None
    console_monitor = _ConsoleLogMonitor()
    target: dict | None = None
    started: dict | None = None
    ended: dict | None = None
    take_folder = ""
    lines: list[str] = []

    def update(status: str, message: str) -> None:
        lines.append(message)
        if report:
            report(status, message)

    try:
        update("Launching CS2", "Launching CS2 through HLAE Custom Loader")
        ffmpeg_ini_snapshot = _install_hlae_ffmpeg_reference(files)
        # cfg has a unique, simple name so no paths or untrusted player text enter the command line.
        launcher = subprocess.Popen(
            [str(files["hlae"]), *args], cwd=str(files["cs2"].parent),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        deadline = time.monotonic() + timeout_seconds
        last_status = "Launching CS2"
        last_warning = ""
        while time.monotonic() < deadline:
            pids = _cs2_pids()
            if launcher is not None and game_pid is None and pids:
                snapshot = _windows_process_snapshot()
                descendants = _descendant_process_ids(launcher.pid, snapshot)
                launched_cs2 = {
                    pid for pid, (_parent, name) in snapshot.items()
                    if pid in descendants and name.casefold() == "cs2.exe"
                }
                owned_game_pids.update(launched_cs2)
                if len(launched_cs2) > 1:
                    raise HLAECaptureError(
                        "HLAE started multiple CS2 processes; refusing to guess which one belongs to this POV."
                    )
                if launched_cs2:
                    game_pid = next(iter(launched_cs2))
                    last_status = "Loading demo"
                    update(last_status, "CS2 started through HLAE; loading the demo and waiting for the target player")
            if game_pid is not None:
                hlae_error = next(
                    (title for title in _visible_window_titles(game_pid)
                     if "error - afxhooksource2" in title.casefold()),
                    None,
                )
                if hlae_error:
                    raise HLAECaptureError(
                        f"{hlae_error}: this HLAE Source 2 hook is incompatible with the installed CS2 build. "
                        "Install the current AdvancedFX release and retry."
                    )
            new_text, log_offset = _read_new_console(console_log, log_offset)
            if new_text:
                console_monitor.feed(new_text)
                warning = console_monitor.warning
                if warning and warning != last_warning:
                    last_warning = warning
                    update(last_status, f"HLAE compatibility warning (continuing verification): {last_warning}")
                if console_monitor.failure:
                    raise HLAECaptureError(console_monitor.failure)
                candidate = console_monitor.target
                if candidate:
                    if str(candidate.get("steamId")) != steam_id64 or candidate.get("mode") != 2:
                        raise HLAECaptureError("HLAE in-eye target verification failed: player SteamID or observer mode differs.")
                    target = candidate
                candidate = console_monitor.started
                if candidate and started is None:
                    started = candidate
                    take_folder = str(candidate.get("takeFolder") or "")
                    last_status = "Recording"
                    update(last_status, f"Recording native CS2 POV at tick {candidate.get('tick')}")
                candidate = console_monitor.ended
                if candidate:
                    ended = candidate
                    update("Verifying", f"HLAE recordEnd fired at tick {candidate.get('tick')}")
                    break
            if game_pid is not None and game_pid not in pids and ended is None:
                raise HLAECaptureError("CS2 exited before HLAE confirmed recording completion.")
            launcher_code = launcher.poll()
            if launcher_code is not None and launcher_code != 0:
                raise HLAECaptureError(f"HLAE Custom Loader failed (exit code {launcher_code}).")
            if launcher_code == 0 and game_pid is None:
                if launcher_exit_seen_at is None:
                    launcher_exit_seen_at = time.monotonic()
                elif time.monotonic() - launcher_exit_seen_at >= 30:
                    raise HLAECaptureError(
                        "HLAE exited successfully, but no CS2 process launched by that HLAE instance appeared."
                    )
            time.sleep(0.5)
        else:
            raise HLAECaptureError("HLAE did not report verified POV recording completion before timeout.")

        if target is None or started is None or ended is None:
            raise HLAECaptureError("HLAE did not confirm the exact player, start tick, and stop tick.")
        actual_start = int(started.get("tick", -1))
        actual_end = int(ended.get("tick", -1))
        if abs(actual_start - start_tick) > 1 or abs(actual_end - end_tick) > 1:
            raise HLAECaptureError(
                f"HLAE tick mismatch: wanted {start_tick}–{end_tick}, got {actual_start}–{actual_end}."
            )
        capture_dir = Path(take_folder) if take_folder else output_dir
        if not capture_dir.is_absolute():
            capture_dir = (files["cs2"].parent / capture_dir).resolve()
        if not capture_dir.is_dir():
            # Some HLAE builds report the take name before the directory flushes;
            # the configured recording prefix remains inside this unique job folder.
            capture_dir = output_dir
        update("Verifying", "Waiting for HLAE video and game audio files to finish writing")
        source_video, source_audio = _wait_for_capture(capture_dir, time.monotonic() + 45)
        return {
            "video_path": source_video,
            "audio_path": source_audio,
            "start_tick": actual_start,
            "end_tick": actual_end,
            "steam_id64": steam_id64,
            "target": target,
            "log_path": output_dir / "console.log",
            "render_log_path": output_dir / "render.log",
            "log_lines": lines,
        }
    finally:
        render_log_path = output_dir / "render.log"
        try:
            (output_dir / "console.log").write_text(console_monitor.excerpt(), encoding="utf-8")
        except OSError:
            pass

        def cleanup_warning(message: str) -> None:
            lines.append(message)
            try:
                with render_log_path.open("a", encoding="utf-8") as handle:
                    handle.write(message + "\n")
            except OSError:
                pass

        try:
            render_log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        except OSError:
            pass
        # Re-check both executable name and ancestry before killing. PIDs can be
        # reused after CS2 exits, and cleanup must never target an unrelated game.
        if launcher is not None and owned_game_pids:
            snapshot = _windows_process_snapshot()
            descendants = _descendant_process_ids(launcher.pid, snapshot)
            safe_to_kill = {
                pid for pid in owned_game_pids
                if pid in descendants
                and pid in snapshot
                and snapshot[pid][1].casefold() == "cs2.exe"
            }
        else:
            safe_to_kill = set()
        for pid in sorted(safe_to_kill):
            try:
                subprocess.run(
                    ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
                    capture_output=True, timeout=15,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
        if launcher is not None:
            try:
                if launcher.poll() is None:
                    launcher.kill()
            except OSError as exc:
                cleanup_warning(f"Cleanup warning: Could not stop the HLAE launcher: {exc}")
            try:
                launcher.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cleanup_warning("Cleanup warning: HLAE launcher did not exit after termination.")
            except OSError as exc:
                cleanup_warning(f"Cleanup warning: Could not reap the HLAE launcher: {exc}")
        try:
            config_file.unlink(missing_ok=True)
        except OSError as exc:
            cleanup_warning(f"Cleanup warning: Could not remove the generated CS2 config: {exc}")
        restored = _restore_hlae_ffmpeg_reference(ffmpeg_ini_snapshot)
        if not restored:
            cleanup_warning(
                "Cleanup warning: HLAE's ffmpeg.ini could not be restored; check its FFmpeg path before the next render."
            )
