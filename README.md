# CS2 Tactic Studio

A Windows desktop workspace for reviewing Counter-Strike 2 demos, building round tactics, and recording synchronized player POVs with CS2 and OBS.

## Current desktop app

The maintained Tauri, Rust, React, and Python application is in [`insight/`](insight/). Start with its [Chinese guide](insight/README.md), [English guide](insight/README_EN.md), and [player guide](insight/PLAYER_GUIDE.md).

The Electron sources in the repository root are an earlier prototype. They are kept for reference; use `insight/` to build the current desktop application.

## Build on Windows

Install Git, Node.js, pnpm, Rust, and the Visual Studio C++ build tools. Then:

```powershell
cd insight/frontend
pnpm install
pnpm run desktop:build
```

The installer is written beneath `insight/frontend/src-tauri/target/release/bundle/`. The app uses the user's installed CS2 and OBS; neither game demos nor personal OBS credentials belong in this repository.

## Checks

```powershell
cd insight
uv run --group dev python -m pytest -c pyproject.toml backend/tests -q
cd frontend
pnpm exec vitest run
pnpm exec tauri build --no-bundle
```

The real five-player POV pipeline was exercised with a local CS2 demo and OBS. It produced five 720p60 MP4s with audio, and each file passed a complete FFmpeg decode. See [POV pipeline notes](docs/POV_PIPELINE.md) for the current acceptance details.

## License and game assets

The maintained application and its bundled dependencies have separate license terms. The application source under [`insight/`](insight/) uses [PolyForm Noncommercial 1.0.0](insight/LICENSE), which permits noncommercial use and restricts commercial use. This is source available under a noncommercial license; it is not an OSI-approved open source license. Read [`insight/THIRD_PARTY_LICENSES.md`](insight/THIRD_PARTY_LICENSES.md) before redistributing builds. Some Counter-Strike assets are Valve property and are not included as standalone game content.
