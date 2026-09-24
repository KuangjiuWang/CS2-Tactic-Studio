# Real CS2 POV pipeline — audit and verification

This document covers only native Counter-Strike 2 first-person capture. The 2D replay and mock UI are not accepted as POV footage.

## Source2 command audit (2026-09-23)

- Player selection: resolve the player controller by SteamID64 using `mirv.getEntityFromIndex`; load the official bundled `mirv_script_spec_lock.js` and pass the controller index. If CS2 reassigns that index after a seek or side swap, resolve and re-lock by SteamID. The snippet repeatedly invokes CS2 `spec_player`. Before recording, inspect the **actual** local observer target using the API in HLAE's bundled `snippets/tests/observer-test.js`; fail unless its SteamID matches. This is important because CS2 has had broken spectator console commands.
- In-eye: `spec_mode 1` is the CS2 console command used to enter first person; the script checks that the local pawn's *internal observer mode* is `2`, as in HLAE's bundled `mirv_script_view.js`. The old code incorrectly sent `spec_mode 2`.
- Tick seek/schedule: Source2 supports `mirv_skip` and `mirv_cmd`; use `mirv_skip tick to` for warmup and `mirv_cmd addAtTick` for exact start/end. The recorded `recordStart`/`recordEnd` ticks must each be within one tick of the requested range.
- Capture: Source2 `mirv_streams record screen enabled 1`, `record fps`, `record name`, `settings edit afxDefault settings afxFfmpeg`, `record startMovieWav 1`, and `record start` / `record end`. Game WAV is required; no microphone recording or synthetic camera is used.
- End: a job only proceeds when HLAE emits `recordEnd` at the requested tick. A missing event, process exit, AfxHookSource2 error window, console error, or timeout fails the job. No partial capture is published as a POV.

Primary references: [AdvancedFX Source2 command list](https://github.com/advancedfx/advancedfx/wiki/Source2:Commands), [Source2 mirv_streams](https://github.com/advancedfx/advancedfx/wiki/Source2:mirv_streams), and the official snippets shipped with HLAE. The HLAE team's [FAQ](https://github.com/advancedfx/advancedfx/wiki/FAQ) describes game-update incompatibility.

## Data and acceptance

`HLAERenderQueue` plans exactly five `HLAERenderJob` values from one selected roster. SteamID64, not T/CT side, is the stable key. The actual Dust2 DEMO confirms Team A swaps from T to CT at round 13 while the five SteamIDs remain unchanged.

For each job, `HLAEConfigGenerator` writes reproducible cfg/JS/launch data; `HLAEProcessController` launches and supervises HLAE/CS2; `RenderLog` saves console and state logs. After `recordEnd`, the queue waits for the HLAE video and WAV to stop growing before closing CS2. FFmpeg muxes them, then ffprobe checks nonzero duration, 60 FPS by default, requested resolution, and audio presence. FFmpeg fully decodes video and audio before publication. A 360p/15 FPS muted proxy is generated. Successful outputs are `pov/player1.mp4` through `pov/player5.mp4`, `proxies/player1.mp4` through `proxies/player5.mp4`, and a metadata JSON beside each source video.

All jobs share the same requested start/end ticks. Playback maps the canonical demo tick to each video's actual `recordStart` tick. The existing UI keeps only the selected main POV audible; previews are muted.

## HLAE pipeline result (Electron prototype)

The earlier Electron prototype at the repository root uses HLAE. On this machine, CS2 1.41.8.2 with HLAE 2.192.2 produces an `AfxHookSource2` address error before the demo loads. That HLAE route is not verified on this game build. Do not use its failed HLAE job as evidence of a successful capture.

## Current desktop app result (Tauri, 2026-09-24)

The maintained application under `insight/` uses the real CS2 engine with OBS for the five-player tactical POV queue. A local `de_ancient` demo was rendered end to end for round 1. All five selected T players completed: donk, zont1x, magixx, tN1R, and sh1ro. Each output is 1280×720 at 60 fps, contains decodable video and audio, and lasts 51.48–51.52 seconds for a planned 51.28-second interval. FFmpeg fully decoded all five audio/video streams; audio levels were nonzero. A captured frame from donk's output showed an in-game first-person view. The outputs were produced locally and are deliberately excluded from the public source repository.

This confirms the OBS-based route on the tested CS2/OBS setup. It does not establish that the separate HLAE prototype works with every current CS2 version, or guarantee exact sub-frame alignment on other machines.
