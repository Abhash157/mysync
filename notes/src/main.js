import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fsp = fs.promises;

// Tests point the app at a throwaway profile and notes folder.
if (process.env.MYNOTES_USER_DATA) app.setPath('userData', process.env.MYNOTES_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

// ------------------------------------------------------------------ config

const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { vault: null, session: {}, bounds: null };

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
    const r = await dialog.showOpenDialog(win, { title: 'Choose notes folder', properties: ['openDirectory', 'createDirectory'], defaultPath: vaultDir() });
    if (r.canceled || !r.filePaths[0]) return null;
    cfg.vault = r.filePaths[0];
    cfg.session = {};
    saveCfg();
    return handlers.info();
  },
  session(s) { cfg.session = s; saveCfg(); },
  reveal(rel) { rel ? shell.showItemInFolder(abs(rel)) : shell.openPath(vaultDir()); },
  external(url) { if (/^(https?:|mailto:)/i.test(String(url))) shell.openExternal(url); },
};

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
  nativeTheme.on('updated', () => { try { win.setTitleBarOverlay(overlay()); } catch {} });
  if (process.env.MYNOTES_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
