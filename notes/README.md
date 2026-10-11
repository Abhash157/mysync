# MyNotes

A tiny markdown notes app for Windows with an Obsidian-style layout: file explorer, tabs, edit / reading views, to-do lists and `[[wikilinks]]`. No plugins, no accounts, no database — notes are plain `.md` files in a folder (default `Documents\Notes`), so they sync with MySync or anything else.

| Shortcut | Action |
| --- | --- |
| Ctrl+N | New note |
| Ctrl+O | Quick switcher (type a new name to create a note) |
| Ctrl+E | Toggle edit / reading view (double-click a note in reading view also edits) |
| Ctrl+Shift+F | Search all notes |
| Ctrl+L | Turn the current line into a to-do / toggle it |
| Ctrl+B / Ctrl+I | Bold / italic |
| Enter, Tab, Shift+Tab | Continue list or to-do, indent, outdent |
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
- Conflicting edits keep both copies (`name.conflict-xxxx.md`).
- Traffic between devices on a network is not encrypted, so only use sync on networks you trust. Anyone with an invite code can read and change the notes.

Tick to-dos in reading view and the file updates. Deleting sends a note to the Recycle Bin. Changes made outside the app (for example by MySync) appear when you switch back to the window.

```
npm install
npm start        # run
npm test         # end-to-end test (drives the real window)
npm run dist     # build the Windows installer into dist/
```

The app has no runtime dependencies: just Electron and about 1,100 lines of code.
