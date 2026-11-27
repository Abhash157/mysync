# MyNotes

A tiny markdown notes app for Windows with an Obsidian-style layout: file explorer, tabs, formatting shown as you type, tables, lists and to-dos, callouts, tags, `[[wikilinks]]`, backlinks and a command palette. No plugins, no accounts, no database — notes are plain `.md` files in a folder (default `Documents\Notes`), so they sync with MySync or anything else.

| Shortcut | Action |
| --- | --- |
| Ctrl+N | New note |
| Ctrl+O | Quick switcher (type a new name to create a note) |
| Ctrl+E | Toggle edit / reading view (double-click a note in reading view also edits) |
| Ctrl+Shift+E | Switch between live preview and plain markdown (source) |
| Ctrl+P | Command palette (also on right-click in the editor) |
| Ctrl+Shift+F | Search all notes |
| Ctrl+L | Turn the current line into a to-do / toggle it |
| Ctrl+B / Ctrl+I | Bold / italic |
| Enter, Tab, Shift+Tab | Continue list or to-do, indent, outdent |
| Alt+Up / Alt+Down | Move the current line |
| Tab, Shift+Tab, Enter in a table | Next cell, previous cell, next row (the table re-aligns itself) |
| Ctrl+W, Ctrl+Tab | Close tab, next tab |
| Ctrl+\\ | Toggle sidebar |
| F2 | Rename the open note |

## Sync

Click the cloud icon (or the status at the bottom left) to sync your notes folder between devices. It uses the same engine as MySync, so the two can sync with each other.

**On the same network, there is nothing to copy.**

1. On the device that has your notes: open **Sync** and choose **Start syncing this folder**.
2. On the new device: open **Sync**, choose **Join notes from another device**, and pick your other device from the list.
3. The first device shows a card with a 4-digit code. If it matches the code on the new device, click **Allow**. The notes start flowing.

Any device that already syncs the folder can answer, and a device you decline can't ask again for a minute.

**Another network, or the internet:** open the first device's sync screen, expand **Invite code**, copy it, and on the new device expand **Use an invite code instead**. For the internet, add a MySync server under **Settings** in the sync screen (the invite then also works from anywhere).

Things worth knowing:

- Sync runs while MyNotes is open. The sync engine only starts when sync is on (or while the join screen is open), so it costs nothing otherwise.
- The first time, Windows Firewall asks whether MyNotes may use the network. Allow it on **Private networks** so devices can find each other.
- Edits to different lines of a note combine by themselves. Edits to the same lines stay in the note, shown red (older) and green (newer) with buttons to keep either or both.
- Traffic between devices on a network is not encrypted, so only use sync on networks you trust. Anyone with an invite code can read and change the notes.

Besides standard markdown, notes understand `==highlight==`, `#tags` (click one to search), `> [!note]` callouts (`tip`, `warning`, `danger`, ...) and pipe tables. The outline button lists a note's headings and the notes that link to it.

In live preview you edit the formatted note itself: markdown symbols appear only around the cursor, and table cells are edited in place (Tab / Shift+Tab move, Enter goes down, Esc leaves the table). Tick to-dos while editing or in reading view and the file updates. Conflict copies from older versions (`name.conflict-1a2b3c4.md`) are folded into `name.md` automatically as red (copy) / green (current) blocks, and the copy files go to the Recycle Bin. The **Check for updates** button (bottom left, or in the command palette) looks for a newer `notes-v*` release on GitHub and offers to open its download page; nothing is checked or installed on its own. Deleting sends a note to the Recycle Bin. Changes made outside the app (for example by MySync) appear when you switch back to the window.

```
npm install
npm start        # run
npm test         # end-to-end test (drives the real window)
npm run dist     # build the Windows installer into dist/
```

The editor is built on CodeMirror (`editor/live.js`), bundled by `scripts/prepare.js`; the installed app needs nothing beyond Electron.
