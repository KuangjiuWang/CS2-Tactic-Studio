# CS2 Tactic Studio desktop updates

The Tauri app checks the latest stable GitHub Release for a signed `latest.json` manifest. The manifest points to the full NSIS installer and carries its Tauri updater signature. The app verifies that signature before installing. If an older release has no manifest, the update dialog opens the GitHub Release page for a manual install.

Build a new version from `frontend` with:

```powershell
pnpm run desktop:build:ver -- 1.2.2
```

The build stages the installer, its updater signature and manifest in `frontend/src-tauri/target/release/bundle/nsis`. Publish these with a SHA-256 checksum:

- `CS2.Tactic.Studio_1.2.2_x64-setup.exe`
- `CS2.Tactic.Studio_1.2.2_x64-setup.exe.sig`
- `latest.json`
- `CS2.Tactic.Studio_1.2.2_x64-setup.exe.sha256`

Publish all four assets on the stable GitHub Release tagged `v1.2.2`. The manifest URL and asset name must match that tag and the uploaded installer. A different version requires a fresh build and a fresh signature. Do not attach an unsigned installer to a signed manifest.

The private updater key for this checkout is stored outside the repository at `%USERPROFILE%\.tauri\cs2-tactic-studio.key`. Back it up securely; the matching public key is committed in `frontend/src-tauri/tauri.conf.json`. Future signed releases must use the same private key, or installed clients will reject them. This signature is separate from Windows Authenticode signing.

The published 1.2.0 installer does not contain this updater integration, so it needs one manual upgrade to 1.2.1. After that, subsequent signed releases can install in-app.
