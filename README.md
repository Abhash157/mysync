# mysync

Keep your folders in sync across all your devices, with a Windows app for everyone and a command-line tool for developers.

> ### Download for Windows
> **[MySync-Setup-0.1.0.exe](https://github.com/Abhash157/mysync/releases/download/app-v0.1.0/MySync-Setup-0.1.0.exe)** (early release, Windows 10/11)
> · [Release notes](https://github.com/Abhash157/mysync/releases/tag/app-v0.1.0) · [All releases](https://github.com/Abhash157/mysync/releases) · [User guide](docs/app-guide.md)

**Jump to:** [Desktop app](#desktop-app-windows) · [Seamless sync (CLI)](#seamless-sync-no-add--commit--push) · [Sync over the internet](#sync-over-the-internet-hub--workspace-names) · [Cloud storage](#sync-through-cloud-storage-google-drive-onedrive-mega-) · [Git-style commands](#available-commands)

Under the hood it is a lightweight, Git-like version control system built with Node.js, Commander, and Ignore.

## Features

- **Content-Addressable Storage**: SHA-1 hashing with zlib compression for blobs, trees, and commit objects stored in `.mysync/objects/`.
- **Staging Index**: Track staged files with metadata in `.mysync/index`.
- **Branching & Checkout**: Full branch creation, switching, and checkout tracking via `.mysync/refs/heads/` and `.mysync/HEAD`.
- **Ignore Rules**: Support for `.mysyncignore` files (plus default ignore rules for `.mysync`, `.git`, and `node_modules`).
- **Unified Diff**: Built-in line diffing comparing working tree with index or index with HEAD.
- **Commit History**: Traversal of commit history with author, timestamps, and oneline options.

## Installation & Setup

```bash
npm i -g @abhashlimbu/mysync
```

Or Locally:
```bash
npm install
```

Optionally link globally:
```bash
npm link
```

## Available Commands

| Command | Description | Example |
| :--- | :--- | :--- |
| `init [directory]` | Initialize an empty repository | `mysync init` |
| `status` | Show working tree and staging area status | `mysync status` |
| `add <pathspecs...>` | Stage file(s) or directories | `mysync add .` or `mysync add file.txt` |
| `commit -m <msg>` | Commit staged changes | `mysync commit -m "feat: initial commit"` |
| `diff [file]` | View diffs between working tree and staging | `mysync diff` or `mysync diff --staged` |
| `log [--oneline] [-n <N>]` | Display commit log | `mysync log --oneline` |
| `branch [name]` | List or create branches | `mysync branch feature-1` |
| `checkout <target>` | Switch to branch or commit | `mysync checkout feature-1` |
| `restore <pathspecs...>` | Discard changes or unstage | `mysync restore file.txt` or `mysync restore --staged file.txt` |
| `serve` | Start HTTP server for remote sync | `mysync serve --port 3000` |
| `clone <url> [dir]` | Clone remote repository | `mysync clone http://device-ip:3000` |
| `remote add <name> <url>`| Add remote repo | `mysync remote add origin http://device-ip:3000` |
| `pull <remote> [branch]` | Fetch and merge remote changes | `mysync pull origin` |
| `push <remote> [branch]` | Push local changes to remote | `mysync push origin` |
| `watch` | Continuous automatic sync with all peers | `mysync watch` |
| `join <url> [dir]` | Join a synced folder | `mysync join http://ip:3000 --token T` |
| `sync` | One automatic sync round | `mysync sync` |
| `invite` | Print the join command for this folder | `mysync invite` |
| `cloud add <provider>` | Connect Google Drive, OneDrive, MEGA, WebDAV or a cloud folder | `mysync cloud add folder ~/OneDrive` |
| `cloud link <account> [name]` | Sync this folder through cloud storage | `mysync cloud link onedrive` |
| `cloud join <account> <name> [dir]` | Get a folder kept in cloud storage | `mysync cloud join onedrive notes` |

## Desktop app (Windows)

Prefer clicking to typing? The `app/` folder is a Windows desktop app built on the same engine: pick a folder, copy an invite code, paste it on another device. It runs in the system tray, starts with Windows, finds your devices on the network by itself, and tells you in plain language when something needs attention. 
**Download:** get [MySync-Setup-0.1.0.exe](https://github.com/Abhash157/mysync/releases/download/app-v0.1.0/MySync-Setup-0.1.0.exe) (or the newest one from the [Releases page](https://github.com/Abhash157/mysync/releases)) and follow the [user guide](docs/app-guide.md). Developers: see [app/README.md](app/README.md) to run it from source or build the installer.

## Seamless Sync (no add / commit / push)

Run one watcher per device. Edits are saved automatically, merged with the other devices, and pushed out, with nothing to stage or commit.

**Device 1 (any folder you want to share):**
```bash
mysync init
mysync watch            # prints a ready-to-paste "join" command with a secret token
```

**Device 2, 3, ... (same command on each):**
```bash
mysync join http://<device-1-ip>:3000 --token <token> [folder]
mysync watch
```

No IP needed on the same network: `mysync join auto --token <token>` finds the device that accepts the token.

`join` works on an empty folder or one that already has files. Existing files are merged in, never overwritten. After that, saving a file on any device makes it appear on the others within a few seconds, deletes included.

- **Automatic discovery:** `watch` announces itself on the LAN (UDP multicast + broadcast, port 41234, override with `MYSYNC_DISCOVERY_PORT`). After one `join`, all devices in the folder find each other, follow IP changes, and keep syncing if the first device goes away. Turn it off with `watch --no-discover`; `mysync nearby` lists what is announcing.
- **Joining without a code (apps):** an `Agent` started with `pairing: true` announces that it accepts join requests. A new device lists nearby ones (`agent.nearby()`), asks (`requestPairing`), and the owner approves in the app (`agent.answerPair`); only then is the invite handed over. Requests expire after two minutes, are rate limited and are only accepted from private-network addresses. MyNotes uses this; the CLI and MySync still join with an invite code.
- Announcements contain no secrets. Before trusting a device, mysync makes it prove it knows the folder token (challenge-response), so the token is never sent to a stranger. All devices in a folder share one token.
- `mysync sync` does a single round by hand (useful for cron or if you don't want a daemon).
- `mysync invite` reprints the join command; `--device <name>` names this device in history.
- Every device can reach every peer it has a remote for. A phone behind NAT can join a PC and still get live updates, because it polls and pushes outward.

**If two devices edit the same file at once**, nothing is lost. In text files, edits to different lines are combined, and edits to the same lines are kept inside the file between git-style `<<<<<<<` / `=======` / `>>>>>>>` markers (older first, newer second). For binary files the newest edit keeps the filename, and the other version is saved beside it as `name.conflict-<hash>.ext`. Both devices make the same choice, so they converge; keep all devices on the same version. If one deletes a file that another edited, the edit wins.

**Security:** every request needs the repo's token (in `.mysync/config.json`). Traffic is plain HTTP, so use it on a trusted network or over a VPN like Tailscale/WireGuard.

## Sync over the internet (hub + workspace names)

LAN discovery only works on one network. For devices anywhere, run a **hub**: a small always-reachable server that holds named workspaces. Devices connect to it outbound, so phones and laptops behind NAT work without port forwarding.

**Once, on something reachable (VPS, home PC with a tunnel/port-forward):**
```bash
mysync hub serve --port 8080 --dir ./mysync-hub --secret <hub-secret>
```
Put it behind HTTPS (Caddy, nginx, Cloudflare Tunnel...). Over plain http the workspace token travels unencrypted.

**On each of your devices, once:**
```bash
mysync hub set https://hub.example.com --secret <hub-secret>
```

**Publish a folder under a name:**
```bash
cd ~/notes && mysync init && mysync publish notes     # prints an invite code
mysync watch
```

**Join from any device, anywhere:**
```bash
mysync join <invite-code> [folder]                    # one string, nothing else to type
mysync join notes --token <token>                     # or just the workspace name
mysync watch
```

An invite code carries the hub, the name, the token and the LAN addresses. Join tries the LAN first and falls back to the hub, then keeps both links, so devices sync directly at home and through the hub when apart. Treat the code like a password. `mysync invite` reprints it. The hub stores only bare copies (no working files), and refuses names that are already taken by someone else.

## Sync through cloud storage (Google Drive, OneDrive, MEGA, ...)

No server to run: use storage you already have as the meeting point. Devices never need to be online at the same time, and phones or laptops behind NAT work because everything goes outward to the cloud.

**Connect an account, once per device:**
```bash
mysync cloud detect                                   # cloud folders found on this PC (OneDrive, Dropbox, Google Drive, MEGA...)
mysync cloud add folder "C:\Users\me\OneDrive"        # any folder a desktop cloud app keeps in sync
mysync cloud add webdav https://cloud.example.com/remote.php/dav/files/me -u me -p <app-password>   # Nextcloud, ownCloud, pCloud, NAS...
mysync cloud add mega -e me@example.com -p <password>
mysync cloud add gdrive --client-id <id> --client-secret <secret>   # opens the browser to sign in
mysync cloud add onedrive --client-id <id>
mysync cloud list
```

**Keep a folder there, and get it on another device:**
```bash
cd ~/notes && mysync cloud link onedrive notes        # account id, or the provider name if you have one of that kind
mysync watch

mysync cloud workspaces onedrive                      # on the other device: what is stored there
mysync cloud join onedrive notes ~/notes
mysync watch
```

How it works and what to know:

- Everything lives in a `MySync` folder in the provider: per folder a `workspace.json`, the same compressed objects as `.mysync/objects`, and one small head file per device. Cloud storage cannot do an atomic "update if unchanged", so each device only ever writes its own head file, uploads objects before the head that needs them, and folds all heads into one commit with the deterministic merge. Every device computes the same result, so they converge without locking. Conflicts are handled the same way as between devices.
- Cloud remotes are checked every 20 seconds (`MYSYNC_CLOUD_INTERVAL_MS`) rather than every few seconds, to stay inside API rate limits. They work alongside LAN peers and a hub: devices joined through the cloud share the folder token, so they also sync directly when on the same network.
- **Cloud folder** is the simplest option: the provider's desktop app does the uploading. If another device's upload is still on its way, MySync waits and retries instead of failing.
- **Google Drive** uses the `drive.file` scope (MySync can only see files it created) and **OneDrive** uses its app folder (`Apps/MySync`). Both need an OAuth app ID you register yourself (Google Cloud Console "Desktop app" client with the Drive API enabled; Azure "Mobile and desktop" app with redirect URI `http://localhost`). Pass it once with `--client-id`, or set `MYSYNC_GOOGLE_CLIENT_ID`/`MYSYNC_GOOGLE_CLIENT_SECRET` and `MYSYNC_ONEDRIVE_CLIENT_ID`.
- **MEGA** goes through the optional [`megajs`](https://www.npmjs.com/package/megajs) package; accounts with two-step login are not supported yet (use the MEGA desktop app's folder instead).
- Sign-in tokens and passwords are stored in `~/.mysync-global.json`, like the hub secret. The cloud copy is not encrypted beyond what the provider does, and `workspace.json` holds the folder token, so anyone with access to that cloud folder can join it.
- `mysync push`/`pull`/`fetch` do not work with cloud remotes; use `sync` or `watch`.

## Remote Syncing (manual, git-style)

The classic commands still work. `serve` requires a token, `pull` now merges instead of only fast-forwarding, and `push` uploads only objects the peer is missing.

```bash
mysync serve --port 3000                       # prints the token
mysync clone http://<ip>:3000 my-project --token <token>
mysync remote add origin http://<ip>:3000 --token <token>
mysync pull origin
mysync push origin
```

## Running Tests

```bash
npm test
```
