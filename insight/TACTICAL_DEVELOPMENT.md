# CS2 Tactic Studio development status

This directory is the new Tauri 2 / React / FastAPI architecture. It is based
on CS2-insight-agent at commit `b296c9db486df1e0ed783a02df298f81b128c191`.
The upstream `LICENSE` (PolyForm Noncommercial 1.0.0), Required Notice and
`THIRD_PARTY_LICENSES` are retained. Commercial deployment needs a separate
license review or permission from the author.

From the repository root, `powershell -File .\launch-tactic-studio.ps1` starts
the backend and browser UI; Ctrl+C stops both child processes. The tactical
page is `/tactics`. For a packaged desktop app, the upstream packaging stages
an embedded Python runtime and builds the Tauri shell. The derivative disables
the upstream updater and its installer migration hook, and uses a separate
product identifier and data directory.

Current tactical path: parse a demo in Demo Analysis, open Tactical Playbook,
choose a round and side, then generate five jobs through the original CS2/OBS
recording queue. Each job is verified with ffprobe for video, positive duration
and an audio stream. Finished recordings are normalized to 720p60 H.264/AAC MP4
in a per-batch cache and receive 360p/15fps muted proxies. A player becomes
ready as soon as its video is encoded, while later players are still recording.
Metadata survives backend restart. Dead players only have genuine in-eye
coverage through death plus the configured tail; the UI exposes these boundaries.

Tactic and step records persist in the existing SQLite database. Nested
folders, tactic moves, editable steps and structured map-anchored drawing are
available. A Windows NSIS installer builds on this workstation with MSVC and
the embedded Python runtime. The installed CS2, OBS and FFmpeg executables
are all found by the application's path detectors.

This is not yet a validated five-POV end-to-end product: no real CS2 demo was
recorded through the complete queue during this development run; an importable
demo and OBS scene / WebSocket setup are still needed for that acceptance test.
The product also lacks `.cstactic` exchange and online sharing. The desktop
startup smoke test and automated tests are separate from an actual CS2 engine
capture; neither should be reported as proof that five real POVs render here.
