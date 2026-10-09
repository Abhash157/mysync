import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, dialog, shell, Notification, clipboard } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { HostClient } from './host-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const BUILD = path.join(appRoot, 'build');
const startHidden = process.argv.includes('--hidden');

/** Only the installed app registers itself to start with Windows (never in dev or under tests). */
const autoStartSupported = () => app.isPackaged && !process.env.MYSYNC_APP_TEST;

if (process.env.MYSYNC_APP_DATA) app.setPath('userData', process.env.MYSYNC_APP_DATA);
app.setAppUserModelId('com.abhashlimbu.mysync');

let store = null;
let host = null;
let win = null;
let tray = null;
let quitting = false;
let hostStopped = false;
let engine = { ready: false, port: null, error: null };
let hub = null;
let restarts = 0;
let broadcastTimer = null;
const snapshots = new Map();
const lastToast = new Map();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logDir = () => path.join(app.getPath('userData'), 'logs');

function log(text) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const file = path.join(logDir(), 'mysync.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${String(text).trimEnd()}\n`);
  } catch {
    // Logging must never break the app.
  }
}

process.on('uncaughtException', (err) => log(`uncaughtException: ${err?.stack || err}`));
process.on('unhandledRejection', (err) => log(`unhandledRejection: ${err?.stack || err}`));

// ---------------------------------------------------------------------------
// State shown in the window and tray
// ---------------------------------------------------------------------------

const SHORT = {
  synced: 'Up to date',
  syncing: 'Syncing...',
  alone: 'Not shared yet',
  offline: 'Offline',
  waiting: 'Waiting for a file',
  paused: 'Paused',
  attention: 'Needs attention',
};

function folderList() {
  return store.get('folders').map(({ root }) => {
    const key = path.resolve(root);
    return (
      snapshots.get(key) || {
        root: key,
        name: path.basename(key) || key,
        state: 'syncing',
        message: 'Starting...',
        paused: false,
        peers: [],
        conflicts: [],
        skipped: [],
        activity: [],
      }
    );
  });
}

function publicState() {
  return {
    version: app.getVersion(),
    platform: process.platform,
    onboarded: store.get('onboarded'),
    engine,
    hub,
    settings: {
      deviceName: store.get('deviceName') || os.hostname(),
      autoStart: store.get('autoStart'),
      canAutoStart: autoStartSupported(),
    },
    defaultJoinBase: path.join(app.getPath('documents'), 'MySync'),
    folders: folderList(),
  };
}

function changed() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    if (win && !win.isDestroyed()) win.webContents.send('state:changed', publicState());
    updateTray();
  }, 80);
}

// ---------------------------------------------------------------------------
// Engine process
// ---------------------------------------------------------------------------

async function bootEngine() {
  engine = { ready: false, port: null, error: null };
  changed();

  host = new HostClient({
    entry: path.join(here, 'engine-host.mjs'),
    env: process.env.MYSYNC_DISCOVERY_PORT ? { MYSYNC_DISCOVERY_PORT: process.env.MYSYNC_DISCOVERY_PORT } : {},
    onOutput: log,
  });

  host.on('event:update', (snap) => {
    snapshots.set(snap.root, snap);
    changed();
  });
  host.on('event:removed', ({ root }) => {
    snapshots.delete(root);
    changed();
  });
  host.on('event:server', ({ port, error }) => {
    engine.port = port;
    if (error) log(`server: ${error}`);
    changed();
  });
  host.on('event:notify', (info) => notifyConflict(info));
  host.on('event:fatal', ({ message }) => log(`engine fatal: ${message}`));
  host.on('exit', ({ expected }) => {
    if (expected || quitting) return;
    engine = { ready: false, port: null, error: 'The sync engine stopped. Restarting...' };
    changed();
    restarts++;
    if (restarts > 5) {
      engine.error = 'The sync engine keeps stopping. Please restart MySync.';
      changed();
      return;
    }
    setTimeout(() => bootEngine().catch((err) => log(`restart failed: ${err.message}`)), 1500 * restarts);
  });

  await host.start();
  const started = await host.call('init', {
    deviceName: store.get('deviceName') || os.hostname(),
    port: Number(process.env.MYSYNC_ENGINE_PORT) || 3000,
  });
  engine.port = started.port;
  for (const snap of await host.call('restore', { folders: store.get('folders') })) snapshots.set(snap.root, snap);
  hub = await host.call('getHub');
  engine.ready = true;
  changed();
  setTimeout(() => { restarts = 0; }, 60_000).unref?.();
}

function notifyConflict({ root, name, files }) {
  if (!Notification.isSupported()) return;
  const now = Date.now();
  if (now - (lastToast.get(root) || 0) < 30_000) return;
  lastToast.set(root, now);
  const note = new Notification({
    title: 'Two versions of a file were kept',
    body: `"${files[0]}" was changed on two devices in ${name}. You can find both copies in the folder.`,
    icon: path.join(BUILD, 'icon.png'),
  });
  note.on('click', () => {
    showWindow();
    win?.webContents.send('select-folder', root);
  });
  note.show();
}

// ---------------------------------------------------------------------------
// Window and tray
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'MySync',
    icon: path.join(BUILD, 'icon.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161a' : '#f4f5f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(appRoot, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!startHidden || !store.get('onboarded')) win.show();
  });
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (!store.get('trayHintShown') && Notification.isSupported()) {
      store.set('trayHintShown', true);
      new Notification({
        title: 'MySync is still running',
        body: 'It keeps your folders in sync from the system tray. Right-click the icon to quit.',
        icon: path.join(BUILD, 'icon.png'),
      }).show();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function overallKind() {
  const folders = folderList();
  if (folders.length === 0) return 'idle';
  if (folders.every((f) => f.state === 'paused')) return 'paused';
  if (folders.some((f) => ['attention', 'offline', 'waiting'].includes(f.state))) return 'attention';
  if (folders.some((f) => f.state === 'syncing')) return 'syncing';
  return 'synced';
}

const TOOLTIP = {
  idle: 'MySync: no folders yet',
  paused: 'MySync: paused',
  attention: 'MySync: needs attention',
  syncing: 'MySync: syncing...',
  synced: 'MySync: everything is up to date',
};

function updateTray() {
  if (!tray) return;
  const kind = overallKind();
  const folders = folderList();
  const allPaused = folders.length > 0 && folders.every((f) => f.paused);

  tray.setImage(nativeImage.createFromPath(path.join(BUILD, `tray-${kind}.png`)));
  tray.setToolTip(TOOLTIP[kind]);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open MySync', click: showWindow },
      { type: 'separator' },
      ...folders.map((f) => ({ label: `${f.name}: ${SHORT[f.state] || f.state}`, click: () => shell.openPath(f.root) })),
      ...(folders.length ? [{ type: 'separator' }] : []),
      {
        label: allPaused ? 'Resume all' : 'Pause all',
        enabled: folders.length > 0,
        click: () => folders.forEach((f) => setPaused(f.root, !allPaused).catch(() => {})),
      },
      { label: 'Sync now', enabled: folders.length > 0, click: () => folders.forEach((f) => host?.call('syncNow', { root: f.root }).catch(() => {})) },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: !!store.get('autoStart'),
        enabled: autoStartSupported(),
        click: (item) => setAutoStart(item.checked),
      },
      { label: 'Quit MySync', click: quitApp },
    ]),
  );
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(BUILD, 'tray-idle.png')));
  tray.on('click', showWindow);
  updateTray();
}

async function quitApp() {
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function setAutoStart(enabled) {
  store.set('autoStart', !!enabled);
  if (autoStartSupported()) app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--hidden'] });
  changed();
}

/** Calls the engine, with a friendly message while it is still starting up. */
function engineCall(cmd, args) {
  if (!host || !engine.ready) return Promise.reject(new Error('MySync is still starting. Try again in a moment.'));
  return host.call(cmd, args);
}

async function setPaused(root, paused) {
  await engineCall(paused ? 'pause' : 'resume', { root });
  store.setPaused(root, paused);
}

/** The window may only act on folders MySync is actually syncing. */
function knownRoot(root) {
  const resolved = path.resolve(String(root || ''));
  if (!store.hasFolder(resolved)) throw new Error('That folder is not being synced.');
  return resolved;
}

function trusted(event) {
  return !!win && event.sender === win.webContents && String(event.senderFrame?.url || '').startsWith('file://');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!trusted(event)) return { ok: false, error: 'Not allowed' };
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      log(`${channel} failed: ${err?.message}`);
      return { ok: false, error: err?.message || 'Something went wrong', code: err?.code || null };
    }
  });
}

function registerIpc() {
  handle('state:get', () => publicState());

  handle('folder:pick', async ({ title, defaultPath }) => {
    const result = await dialog.showOpenDialog(win, {
      title: title || 'Choose a folder',
      defaultPath: defaultPath || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  handle('folder:inspect', ({ root }) => engineCall('inspectFolder', { root: path.resolve(String(root)) }));

  handle('folder:add', async ({ root }) => {
    const resolved = path.resolve(String(root));
    const snap = await engineCall('addFolder', { root: resolved });
    store.addFolder(snap.root);
    snapshots.set(snap.root, snap);
    changed();
    return snap;
  });

  handle('folder:join', async ({ code, dest }) => {
    const snap = await engineCall('joinFolder', { code: String(code), dest: path.resolve(String(dest)) });
    store.addFolder(snap.root);
    snapshots.set(snap.root, snap);
    changed();
    return snap;
  });

  handle('folder:invite', ({ root }) => engineCall('invite', { root: knownRoot(root) }));
  handle('folder:open', async ({ root }) => {
    const error = await shell.openPath(knownRoot(root));
    if (error) throw new Error('Could not open that folder. It may have been moved or deleted.');
    return true;
  });
  handle('folder:reveal', ({ root, rel }) => {
    const base = knownRoot(root);
    const full = path.resolve(base, String(rel || ''));
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error('Not allowed');
    if (fs.existsSync(full)) shell.showItemInFolder(full);
    else shell.openPath(base);
    return true;
  });
  handle('folder:pause', async ({ root }) => setPaused(knownRoot(root), true));
  handle('folder:resume', async ({ root }) => setPaused(knownRoot(root), false));
  handle('folder:sync', ({ root }) => engineCall('syncNow', { root: knownRoot(root) }));
  handle('folder:remove', async ({ root, forget }) => {
    const resolved = knownRoot(root);
    await engineCall('removeFolder', { root: resolved, forget: !!forget });
    store.removeFolder(resolved);
    snapshots.delete(resolved);
    changed();
    return true;
  });
  handle('folder:publish', async ({ root, name }) => {
    const result = await engineCall('publish', { root: knownRoot(root), name: String(name || '') });
    snapshots.set(result.snapshot.root, result.snapshot);
    changed();
    return result;
  });

  handle('invite:inspect', ({ code }) => engineCall('inspectInvite', { code: String(code || '') }));
  handle('invite:clipboard', () => {
    const text = clipboard.readText().trim();
    return text.startsWith('mys1.') && text.length < 4000 ? text : null;
  });
  handle('clipboard:write', ({ text }) => {
    clipboard.writeText(String(text).slice(0, 4000));
    return true;
  });

  handle('settings:save', async ({ deviceName, autoStart }) => {
    if (typeof deviceName === 'string') {
      const saved = await engineCall('setDeviceName', { name: deviceName });
      store.set('deviceName', saved);
    }
    if (typeof autoStart === 'boolean') setAutoStart(autoStart);
    changed();
    return publicState().settings;
  });
  handle('hub:set', async ({ url, secret }) => {
    hub = await engineCall('setHub', { url: String(url || ''), secret: secret ? String(secret) : null });
    changed();
    return hub;
  });
  handle('hub:test', ({ url }) => engineCall('testHub', { url: String(url || '') }));
  handle('app:logs', () => shell.openPath(logDir()));
  handle('onboarding:done', () => {
    store.set('onboarded', true);
    if (autoStartSupported()) app.setLoginItemSettings({ openAtLogin: !!store.get('autoStart'), args: ['--hidden'] });
    changed();
    return true;
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => {
    // Stay alive in the tray.
  });
  app.on('before-quit', (event) => {
    quitting = true;
    if (host && !hostStopped) {
      event.preventDefault();
      hostStopped = true;
      host.stop().finally(() => app.quit());
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    store = new Store(path.join(app.getPath('userData'), 'state.json'));
    registerIpc();
    createWindow();
    createTray();

    if (process.env.MYSYNC_APP_TEST) app.mysyncTest = { store, snapshots, showWindow, getHost: () => host, getWindow: () => win };

    try {
      await bootEngine();
    } catch (err) {
      log(`engine failed to start: ${err?.stack || err}`);
      engine = { ready: false, port: null, error: 'The sync engine could not start. Please restart MySync.' };
      changed();
    }
  });
}
