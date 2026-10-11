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

Click the cloud icon (or the status at the bottom left) to sync your notes folder between devices with the same engine as MySync. Choose **Start syncing this folder** to get an invite code, then on the other device choose **I already sync notes on another device** and paste it. Devices on the same network find each other automatically; for the internet, add a MySync server under **Settings** in the sync screen. Sync runs while MyNotes is open, the engine only starts if sync is on, and conflicting edits keep both copies (`name.conflict-xxxx.md`). Anyone with the invite code can read and change the notes.

Tick to-dos in reading view and the file updates. Deleting sends a note to the Recycle Bin. Changes made outside the app (for example by MySync) appear when you switch back to the window.

```
npm install
npm start        # run
npm test         # end-to-end test (drives the real window)
npm run dist     # build the Windows installer into dist/
```

The app has no runtime dependencies: just Electron and about 1,100 lines of code.
