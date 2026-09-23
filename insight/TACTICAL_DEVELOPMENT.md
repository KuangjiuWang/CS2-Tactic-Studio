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
recording queue. Each job is verified with ffprobe for decodable video, positive
duration and an audio stream. Completed source recordings are copied into a
per-batch cache and receive 360p/15fps muted proxies. Metadata survives
backend restart. Dead players only have genuine in-eye coverage through death
plus the configured tail; the UI exposes these coverage boundaries.

Tactic and step records persist in the existing SQLite database. The product
still lacks `.cstactic` exchange, drawing/editing UI, sharing, full user QA on
actual recorded five-POV demos, and a built installer on this workstation.
The latter is blocked by the absent MSVC `link.exe`; CS2, OBS and FFmpeg were
also not found in the expected local tool paths during this development run.
