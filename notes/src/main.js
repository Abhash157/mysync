import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, clipboard } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostClient } from '../host/host-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fsp = fs.promises;

// Tests point the app at a throwaway profile and notes folder.
if (process.env.MYNOTES_USER_DATA) app.setPath('userData', process.env.MYNOTES_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

// ------------------------------------------------------------------ config

const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { vault: null, session: {}, bounds: null, sync: { on: false, deviceName: '' } };

function loadCfg() {
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch {}
  if (process.env.MYNOTES_VAULT) cfg.vault = process.env.MYNOTES_VAULT;
}
function saveCfg() {
  try {
    fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
    fs.writeFileSync(cfgFile(), JSON.stringify(cfg));
  } catch {}
}

// ------------------------------------------------------------------ vault

const WELCOME = `# Welcome

Notes are plain markdown files in this folder. Edit them anywhere.

- **Ctrl+N** new note, **Ctrl+O** open a note, **Ctrl+E** switch edit / reading view
- **Ctrl+Shift+F** search all notes, **Ctrl+L** turn a line into a to-do

## To-do

- [ ] Try ticking this box in reading view
- [ ] Press Enter after a to-do to get the next one
- [x] Install MyNotes

Link notes together with [[double brackets]].
`;

function vaultDir() {
  cfg.vault = path.resolve(cfg.vault || path.join(app.getPath('documents'), 'Notes'));
  fs.mkdirSync(cfg.vault, { recursive: true });
  if (!fs.readdirSync(cfg.vault).length) fs.writeFileSync(path.join(cfg.vault, 'Welcome.md'), WELCOME);
  return cfg.vault;
}

// Resolve a vault-relative path, refusing anything that escapes the vault.
function abs(rel) {
  const root = vaultDir();
  const p = path.resolve(root, String(rel || ''));
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('Path is outside the vault');
  return p;
}

const clean = (name) => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\.md$/i, '').trim().replace(/^\.+/, '');
const join = (dir, name) => (dir ? dir + '/' + name : name);

async function walk(dir, rel = '') {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = join(rel, e.name);
    if (e.isDirectory()) {
      out.push({ p: r, d: 1 });
      out.push(...(await walk(path.join(dir, e.name), r)));
    } else if (e.isFile() && /\.md$/i.test(e.name)) out.push({ p: r });
  }
  return out;
}

function unique(dir, base, ext) {
  for (let i = 0; ; i++) {
    const name = base + (i ? ' ' + i : '');
    if (!fs.existsSync(abs(join(dir, name + ext)))) return name;
  }
}

const handlers = {
  info: async () => ({ vault: vaultDir(), files: await walk(vaultDir()), session: cfg.session || {} }),
  list: () => walk(vaultDir()),
  read: (rel) => fsp.readFile(abs(rel), 'utf8'),
  write: (rel, text) => fsp.writeFile(abs(rel), String(text)),

  async create(dir, name) {
    abs(dir);
    const final = unique(dir || '', clean(name || '') || 'Untitled', '.md');
    const rel = join(dir || '', final + '.md');
    await fsp.writeFile(abs(rel), '', { flag: 'wx' });
    return rel;
  },
  async mkdir(dir) {
    abs(dir);
    const rel = join(dir || '', unique(dir || '', 'New folder', ''));
    await fsp.mkdir(abs(rel));
    return rel;
  },
  async rename(rel, newName) {
    const from = abs(rel);
    const isDir = (await fsp.stat(from)).isDirectory();
    const name = clean(newName);
    if (!name) throw new Error('Name cannot be empty');
    const slash = rel.lastIndexOf('/');
    const to = join(slash < 0 ? '' : rel.slice(0, slash), name + (isDir ? '' : '.md'));
    if (to === rel) return rel;
    if (to.toLowerCase() !== rel.toLowerCase() && fs.existsSync(abs(to))) throw new Error('That name is already taken');
    await fsp.rename(from, abs(to));
    return to;
  },
  async remove(rel) {
    if (!rel) throw new Error('Cannot delete the vault');
    await shell.trashItem(abs(rel)); // recoverable from the Recycle Bin
  },

  async search(q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    for (const f of await walk(vaultDir())) {
      if (f.d) continue;
      let text = '';
      try { text = await fsp.readFile(abs(f.p), 'utf8'); } catch { continue; }
      const lines = [];
      text.split('\n').forEach((l, i) => {
        if (lines.length < 5 && l.toLowerCase().includes(q)) lines.push({ n: i, t: l.trim().slice(0, 160) });
      });
      if (f.p.toLowerCase().includes(q) || lines.length) hits.push({ p: f.p, lines });
      if (hits.length >= 100) break;
    }
    return hits;
  },

  async pick() {
    const dir = await handlers.pickFolder();
    if (!dir) return null;
    if (cfg.sync.on) await stopSync(); // files stay where they are; the old folder just stops syncing
    cfg.vault = dir;
    cfg.session = {};
    saveCfg();
    return handlers.info();
  },
  async pickFolder() {
    const r = await dialog.showOpenDialog(win, { title: 'Choose notes folder', properties: ['openDirectory', 'createDirectory'], defaultPath: vaultDir() });
    if (r.canceled || !r.filePaths[0]) return null;
    if (cfg.sync.on && path.resolve(r.filePaths[0]) !== vaultDir()) {
      const ok = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Continue', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Syncing will stop for the current notes folder.', detail: 'Its files stay exactly where they are. You can turn sync on again for the new folder.' });
      if (ok !== 0) return null;
    }
    return path.resolve(r.filePaths[0]);
  },
  clipboard: () => clipboard.readText().slice(0, 4000),
  copy: (text) => clipboard.writeText(String(text)),
  session(s) { cfg.session = s; saveCfg(); },
  reveal(rel) { rel ? shell.showItemInFolder(abs(rel)) : shell.openPath(vaultDir()); },
  external(url) { if (/^(https?:|mailto:)/i.test(String(url))) shell.openExternal(url); },
};

// ------------------------------------------------------------------ sync
// The sync engine runs in its own process and is only started once sync is turned on, so
// people who never sync pay nothing for it.

const userError = (m) => new Error(m);
const sync = { ready: false, starting: false, error: null, snap: null, hub: null };
let host = null;
let bootP = null;
let restarts = 0;
let stopping = false;
let syncTimer = null;
const deviceName = () => cfg.sync.deviceName || os.hostname().replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 40) || 'My PC';
const sameRoot = (a) => a && path.resolve(a).toLowerCase() === vaultDir().toLowerCase();

function syncState() {
  return { enabled: !!cfg.sync.on, ready: sync.ready, starting: sync.starting, error: sync.error, snap: sync.snap, hub: sync.hub, deviceName: deviceName(), vault: vaultDir() };
}
function pushSync() {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    if (win && !win.isDestroyed()) win.webContents.send('sync', syncState());
  }, 80);
}

function bootEngine() {
  if (bootP) return bootP;
  sync.starting = true;
  sync.error = null;
  pushSync();
  stopping = false;
  const h = new HostClient({
    entry: path.join(here, '..', 'host', 'engine-host.mjs'),
    env: process.env.MYSYNC_DISCOVERY_PORT ? { MYSYNC_DISCOVERY_PORT: process.env.MYSYNC_DISCOVERY_PORT } : {},
  });
  host = h;
  h.on('event:update', (snap) => { if (sameRoot(snap.root)) { sync.snap = snap; pushSync(); } });
  h.on('event:removed', ({ root }) => { if (sameRoot(root)) { sync.snap = null; pushSync(); } });
  h.on('event:notify', (info) => { if (win && !win.isDestroyed()) win.webContents.send('sync-notify', info); });
  h.on('exit', ({ expected }) => {
    host = null;
    bootP = null;
    sync.ready = false;
    if (expected || stopping || !cfg.sync.on) return;
    if (++restarts > 5) { sync.error = 'The sync engine keeps stopping. Please restart MyNotes.'; sync.starting = false; pushSync(); return; }
    sync.error = 'The sync engine stopped. Restarting...';
    pushSync();
    setTimeout(() => bootEngine().catch(() => {}), 1500 * restarts);
  });
  bootP = (async () => {
    await h.start();
    await h.call('init', { deviceName: deviceName(), port: Number(process.env.MYNOTES_ENGINE_PORT) || 3010 });
    if (cfg.sync.on) {
      const list = await h.call('restore', { folders: [{ root: vaultDir() }] });
      sync.snap = list.find((s) => sameRoot(s.root)) || null;
    }
    sync.hub = await h.call('getHub');
    sync.ready = true;
    sync.starting = false;
    sync.error = null;
    setTimeout(() => { restarts = 0; }, 60_000).unref?.();
    pushSync();
  })().catch((err) => {
    bootP = null;
    sync.starting = false;
    sync.error = err.message;
    pushSync();
    throw err;
  });
  return bootP;
}

const engine = async (cmd, args) => { await bootEngine(); return host.call(cmd, args); };

async function stopSync() {
  if (host && sync.ready) { try { await host.call('removeFolder', { root: vaultDir() }); } catch {} }
  cfg.sync.on = false;
  sync.snap = null;
  saveCfg();
  stopping = true;
  const h = host;
  host = null; bootP = null; sync.ready = false;
  if (h) await h.stop();
  pushSync();
}

Object.assign(handlers, {
  syncState,
  syncRetry: () => bootEngine().then(() => true),
  async syncEnable() {
    await engine('addFolder', { root: vaultDir() });
    cfg.sync.on = true;
    saveCfg();
    sync.snap = (await host.call('list')).find((s) => sameRoot(s.root)) || null;
    pushSync();
    return handlers.syncInvite();
  },
  async syncJoin(code, dest) {
    if (cfg.sync.on) throw userError('Stop syncing the current notes folder first.');
    dest = path.resolve(dest || vaultDir());
    if (dest === vaultDir()) { // an untouched welcome note would only clash with the real one
      const files = fs.readdirSync(dest);
      const w = path.join(dest, 'Welcome.md');
      if (files.length === 1 && files[0] === 'Welcome.md' && fs.readFileSync(w, 'utf8') === WELCOME) fs.unlinkSync(w);
    }
    const snap = await engine('joinFolder', { code, dest });
    if (dest !== vaultDir()) { cfg.vault = dest; cfg.session = {}; }
    sync.snap = snap;
    cfg.sync.on = true;
    saveCfg();
    pushSync();
    return handlers.info();
  },
  async syncInvite() { return (await engine('invite', { root: vaultDir() })).code; },
  async syncPublish(name) { const r = await engine('publish', { root: vaultDir(), name }); sync.snap = r.snapshot; pushSync(); return r.code; },
  syncInspect: (code) => engine('inspectInvite', { code }),
  syncNow: () => engine('syncNow', { root: vaultDir() }),
  syncPause: () => engine('pause', { root: vaultDir() }),
  syncResume: () => engine('resume', { root: vaultDir() }),
  syncStop: stopSync,
  async syncDevice(name) {
    const n = await engine('setDeviceName', { name });
    cfg.sync.deviceName = n;
    saveCfg();
    pushSync();
    return n;
  },
  async syncHub(url, secret) { sync.hub = await engine('setHub', { url, secret }); pushSync(); return sync.hub; },
  syncTestHub: (url) => engine('testHub', { url }),
});

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle('n:' + name, async (_e, ...args) => {
    try { return await fn(...args); } catch (err) { throw new Error(err.message); }
  });
}

// ------------------------------------------------------------------ window

let win;
const overlay = () => nativeTheme.shouldUseDarkColors
  ? { color: '#262626', symbolColor: '#bbbbbb', height: 36 }
  : { color: '#f0f0f0', symbolColor: '#444444', height: 36 };

function createWindow() {
  const b = cfg.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1000,
    height: b.height || 680,
    x: b.x,
    y: b.y,
    minWidth: 420,
    minHeight: 300,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    icon: path.join(here, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (b.max) win.maximize();
  win.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => win.webContents.send('focus'));
  win.on('close', () => {
    cfg.bounds = { ...win.getNormalBounds(), max: win.isMaximized() };
    saveCfg();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { handlers.external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  loadCfg();
  Menu.setApplicationMenu(null);
  createWindow();
  if (cfg.sync.on) bootEngine().catch(() => {});
  nativeTheme.on('updated', () => { try { win.setTitleBarOverlay(overlay()); } catch {} });
  if (process.env.MYNOTES_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (e) => {
  if (!host || stopping) return;
  e.preventDefault();
  stopping = true;
  Promise.race([host.stop(), new Promise((r) => setTimeout(r, 2500))]).finally(() => app.exit(0));
});
