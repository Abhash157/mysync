# MySync for Windows

A desktop app for the MySync engine, for people who would rather not use a command line.
Pick a folder, copy an invite code to another device, and the folder stays identical on both.

## What it does

- **Sync a folder**: choose any folder; MySync saves changes automatically and keeps every device in step.
- **Join a folder**: paste an invite code, choose where to save it, done. Files already in that folder are merged in, never overwritten.
- **Finds your devices by itself** on the same network. For devices far apart, point it at a MySync server (`mysync hub serve`) under *Settings → Internet sync*.
- **Lives in the system tray**, starts with Windows (installed version), and shows a status icon: up to date, syncing, paused, or needs attention.
- **Never loses work**: if two devices change the same file, both versions are kept and you are told. A file that is open in another program is left alone and synced later. A remembered folder that disappears is flagged, never re-created empty.

## Run it from source

```bash
cd app
npm install
npm start
```

## Build the installer

```bash
npm run dist      # dist/MySync-Setup-<version>.exe  (per-user installer, no admin needed)
npm run pack      # dist/win-unpacked/ only, useful for testing
```

The installer is **not code-signed**, so Windows SmartScreen will warn on first run until a certificate is added
(`win.certificateFile` / `CSC_LINK` in electron-builder). Windows Firewall also asks once whether MySync may use
private networks; that is what lets devices find each other.

## Tests

```bash
npm test                                     # engine host + full end-to-end run of the real window
MYSYNC_APP_EXE=dist/win-unpacked/MySync.exe node test/e2e.test.js   # same run against the packaged build
```

The end-to-end test drives the real Electron window with Playwright, using the command-line tool as the second
device, and writes screenshots to `test/shots/`.

## How it is put together

```
Window (renderer/)  <--IPC-->  Main process (src/main.js)  <--messages-->  Engine host (src/engine-host.mjs)
 plain HTML/CSS/JS              tray, window, settings,                      runs the sync Agent from ../src
 no Node access                 notifications, supervision                   (copied to engine/ at build time)
```

- The **engine runs in its own process** (Electron `utilityProcess`), so hashing a big folder or a slow network can never freeze the window. If it crashes, the main process restarts it.
- The window has **no Node access**: `src/preload.cjs` exposes a short allow-list of actions, and the main process re-checks every request (for example it only acts on folders it is actually syncing).
- One server port (default 3000, next free port if busy) serves **all** folders at `/f/<folder id>/`, and each folder is announced separately on the network.
- `npm start`, `pack`, `dist` and `test` first run `scripts/prepare.js`, which copies `../src` into `engine/` so the app is self-contained.

## Known limits

- Files over **100 MB** are skipped (shown in the window). Large files are sent whole, so streaming transfer is future work.
- MySync keeps a hidden copy of your files' history in each folder (`.mysync`), so it needs roughly as much extra disk space. The app warns before syncing very large folders.
- There is no version-history or "restore deleted file" screen yet, although the history is kept.
- Windows only for now (the code is cross-platform, but tray and installer are tuned for Windows).
