# gdif

Lightweight, Git-like Version Control System (VCS) CLI built with Node.js, Commander, and Ignore.

## Features

- **Content-Addressable Storage**: SHA-1 hashing with zlib compression for blobs, trees, and commit objects stored in `.gdif/objects/`.
- **Staging Index**: Track staged files with metadata in `.gdif/index`.
- **Branching & Checkout**: Full branch creation, switching, and checkout tracking via `.gdif/refs/heads/` and `.gdif/HEAD`.
- **Ignore Rules**: Support for `.gdifignore` files (plus default ignore rules for `.gdif`, `.git`, and `node_modules`).
- **Unified Diff**: Built-in line diffing comparing working tree with index or index with HEAD.
- **Commit History**: Traversal of commit history with author, timestamps, and oneline options.

## Installation & Setup

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
| `init [directory]` | Initialize an empty repository | `gdif init` |
| `status` | Show working tree and staging area status | `gdif status` |
| `add <pathspecs...>` | Stage file(s) or directories | `gdif add .` or `gdif add file.txt` |
| `commit -m <msg>` | Commit staged changes | `gdif commit -m "feat: initial commit"` |
| `diff [file]` | View diffs between working tree and staging | `gdif diff` or `gdif diff --staged` |
| `log [--oneline] [-n <N>]` | Display commit log | `gdif log --oneline` |
| `branch [name]` | List or create branches | `gdif branch feature-1` |
| `checkout <target>` | Switch to branch or commit | `gdif checkout feature-1` |
| `restore <pathspecs...>` | Discard changes or unstage | `gdif restore file.txt` or `gdif restore --staged file.txt` |
| `serve` | Start HTTP server for remote sync | `gdif serve --port 3000` |
| `clone <url> [dir]` | Clone remote repository | `gdif clone http://device-ip:3000` |
| `remote add <name> <url>`| Add remote repo | `gdif remote add origin http://device-ip:3000` |
| `pull <remote> <branch>` | Fetch and integrate remote changes | `gdif pull origin main` |
| `push <remote> <branch>` | Push local changes to remote | `gdif push origin main` |

## Remote Syncing (including Android)

You can sync your repository across devices over your local network using the built-in HTTP server.

**On the Host Device (e.g., your Android phone using Termux or another PC):**
```bash
gdif serve --port 3000
```

**On the Client Device:**
```bash
# Clone the repository
gdif clone http://<host-device-ip>:3000 my-project

# Or add a remote to an existing repo
gdif remote add origin http://<host-device-ip>:3000
gdif pull origin main
gdif push origin main
```

## Running Tests

```bash
npm test
```
