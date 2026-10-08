# mysync

Lightweight, Git-like Version Control System (VCS) CLI built with Node.js, Commander, and Ignore.

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

`join` works on an empty folder or one that already has files. Existing files are merged in, never overwritten. After that, saving a file on any device makes it appear on the others within a few seconds, deletes included.

- `mysync sync` does a single round by hand (useful for cron or if you don't want a daemon).
- `mysync invite` reprints the join command; `--device <name>` names this device in history.
- Every device can reach every peer it has a remote for. A phone behind NAT can join a PC and still get live updates, because it polls and pushes outward.

**If two devices edit the same file at once**, nothing is lost. The newest edit keeps the filename, and the other version is saved beside it as `name.conflict-<hash>.ext`. Both devices make the same choice, so they converge. If one deletes a file that another edited, the edit wins.

**Security:** every request needs the repo's token (in `.mysync/config.json`). Traffic is plain HTTP, so use it on a trusted network or over a VPN like Tailscale/WireGuard.

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
