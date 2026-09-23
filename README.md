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
| `pull <remote> <branch>` | Fetch and integrate remote changes | `mysync pull origin main` |
| `push <remote> <branch>` | Push local changes to remote | `mysync push origin main` |

## Remote Syncing (including Android)

You can sync your repository across devices over your local network using the built-in HTTP server.

**On the Host Device (e.g., your Android phone using Termux or another PC):**
```bash
mysync serve --port 3000
```

**On the Client Device:**
```bash
# Clone the repository
mysync clone http://<host-device-ip>:3000 my-project

# Or add a remote to an existing repo
mysync remote add origin http://<host-device-ip>:3000
mysync pull origin main
mysync push origin main
```

## Running Tests

```bash
npm test
```
