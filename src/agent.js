import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  GDIF_DIR,
  initRepo,
  getConfig,
  writeConfig,
  listPeers,
  getOrCreateFolderId,
  getOrCreateDeviceId,
  getOrCreateToken,
  getHeadInfo,
} from './repo.js';
import { createIgnoreFilter, isPathIgnored } from './ignore.js';
import { snapshot, getDeviceName, getSkippedFiles, getDeferredCount } from './auto.js';
import { readCommit } from './objects.js';
import { flattenTree } from './commit.js';
import { syncPeer, adoptDiscoveredPeer, peerName } from './sync.js';
import { startDiscovery } from './discovery.js';
import { handleSyncRequest } from './server.js';

const BUSY_AFTER_MS = 700;
const MAX_ACTIVITY = 60;
const MAX_CONFLICTS = 30;

// ---------------------------------------------------------------------------
// Plain-language errors
// ---------------------------------------------------------------------------

/** Turns network/engine errors into something a non-technical person can act on. */
export function friendlyError(err) {
  const code = err?.cause?.code || err?.code;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'The other device did not answer in time';
  }
  if (code === 'ECONNREFUSED') return 'MySync is not running on the other device';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Cannot find the other device. Check your internet connection';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN') return 'The other device is not reachable from here';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'The connection was interrupted';
  if (err?.status === 401) return 'The access code no longer matches';
  if (err?.status === 404) return 'This folder is no longer shared there';
  if (err?.status === 503) return 'Syncing is paused on the other device';
  if (err?.code === 'ELOCKED') return err.message;
  if (err?.message === 'fetch failed') return 'Cannot connect to the other device';
  return String(err?.message || err).replace(/^fatal: /, '');
}

// ---------------------------------------------------------------------------
// Choosing a folder safely
// ---------------------------------------------------------------------------

const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

function isInside(child, parent) {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function userError(message) {
  const err = new Error(message);
  err.code = 'EUSER';
  return err;
}

/**
 * Throws a human-readable error when `root` is a bad thing to sync (a whole drive,
 * the user's home folder, system folders, or overlapping another synced folder).
 * @param {string} root
 * @param {string[]} existingRoots Folders already synced by this app
 */
export function validateWorkspaceRoot(root, existingRoots = []) {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw userError('That folder does not exist.');
  }
  if (path.parse(resolved).root === resolved) {
    throw userError('Choose a folder, not a whole drive.');
  }
  const home = os.homedir();
  if (norm(resolved) === norm(home) || isInside(home, resolved)) {
    throw userError('Choose a folder inside your user folder (for example Documents\\Notes), not the whole thing.');
  }
  const system = [process.env.SystemRoot, process.env.windir, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    .filter(Boolean);
  if (system.some((dir) => isInside(resolved, dir))) {
    throw userError('System folders cannot be synced.');
  }
  for (const other of existingRoots) {
    if (norm(other) === norm(resolved)) throw userError('This folder is already being synced.');
    if (isInside(resolved, other)) throw userError('This folder is inside a folder that is already synced.');
    if (isInside(other, resolved)) throw userError('This folder contains a folder that is already synced.');
  }
}

/**
 * Quickly measures a folder (within a time budget) so the UI can warn before syncing something huge.
 * @returns {{ files: number, bytes: number, truncated: boolean }}
 */
export function estimateFolder(root, { maxMs = 3000, maxFiles = 300_000 } = {}) {
  const ig = createIgnoreFilter(root);
  const started = Date.now();
  const stack = [root];
  let files = 0;
  let bytes = 0;
  let truncated = false;

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (isPathIgnored(rel, ig)) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files++;
        try { bytes += fs.statSync(full).size; } catch { /* vanished */ }
      }
      if (files >= maxFiles || Date.now() - started > maxMs) {
        return { files, bytes, truncated: true };
      }
    }
  }
  return { files, bytes, truncated };
}

// ---------------------------------------------------------------------------
// One synced folder
// ---------------------------------------------------------------------------

const CONFLICT_COPY = /\.conflict-[0-9a-f]{7}(?=(\.[^./]+)?$)/;

const peerLabel = (name) => (name === 'hub' ? 'Internet' : name.replace(/-[0-9a-f]{4}$/, ''));

/**
 * Keeps one folder in sync: watches it, saves changes, and runs an independent
 * sync loop per peer so a slow or unreachable device never holds up the others.
 * Emits 'update' (with a snapshot) whenever something a UI would show changes,
 * and 'notify' for things worth interrupting the user about.
 */
export class Workspace extends EventEmitter {
  /**
   * @param {string} root
   * @param {{ interval?: number, debounce?: number, paused?: boolean }} [options] interval in seconds, debounce in ms
   */
  constructor(root, { interval = 3, debounce = 600, paused = false } = {}) {
    super();
    this.root = path.resolve(root);
    this.name = path.basename(this.root) || this.root;
    this.interval = interval * 1000;
    this.debounce = debounce;
    this.paused = paused;
    this.stopped = true;

    this.links = new Map();
    this.activity = [];
    this.conflicts = [];
    this.ops = new Set();
    this.blocked = null;
    this.error = null;
    this.lastChangeAt = null;
    this.lastCheckAt = null;
    this.watcher = null;
    this.watcherOk = false;
    this.scanning = false;
    this.scanAgain = false;
    this.timers = {};
    this.activityId = 0;
    this.lastSignature = '';
    this.refreshIdentity();
  }

  refreshIdentity() {
    this.folderId = getOrCreateFolderId(this.root);
    this.deviceId = getOrCreateDeviceId(this.root);
    this.deviceName = getDeviceName(this.root);
    getOrCreateToken(this.root);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.ig = createIgnoreFilter(this.root);
    this._startWatcher();
    this.timers.tick = setInterval(() => this._tick(), this.interval);
    this._scheduleSafetyScan();
    this._reconcileLinks();
    this.knownCopies = this._conflictCopies();
    this._scan().then(() => this._pokeAll());
    this._recompute(true);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timers.tick);
    clearTimeout(this.timers.debounce);
    clearTimeout(this.timers.safety);
    clearTimeout(this.timers.restartWatcher);
    this._closeWatcher();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this._log('Syncing paused');
    this._recompute(true);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this._log('Syncing resumed');
    this.syncNow();
    this._recompute(true);
  }

  /** Scan and talk to every peer right away. */
  async syncNow() {
    if (this.stopped || this.paused) return;
    await this._scan();
    this._pokeAll();
  }

  /** A peer pushed new content into this folder. */
  noteIncoming() {
    this.lastChangeAt = Date.now();
    this._log('Received changes from another device', 'in');
    this._noticeNewConflictCopies();
    this._recompute();
  }

  // -- local changes ---------------------------------------------------------

  requestScan() {
    if (this.stopped || this.paused) return;
    // Wait for a quiet moment, but never postpone a scan by more than a few seconds.
    const now = Date.now();
    if (!this.pendingSince) this.pendingSince = now;
    clearTimeout(this.timers.debounce);
    const wait = Math.max(0, Math.min(this.debounce, this.pendingSince + 5000 - now));
    this.timers.debounce = setTimeout(() => {
      this.pendingSince = 0;
      this._scan().then(() => this._pokeAll());
    }, wait);
  }

  _startWatcher() {
    this._closeWatcher();
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return this.requestScan();
        const rel = String(filename).split(path.sep).join('/');
        if (!isPathIgnored(rel, this.ig)) this.requestScan();
      });
      this.watcher.on('error', () => {
        this._closeWatcher();
        // Folder moved, deleted or drive removed: look again soon.
        this.timers.restartWatcher = setTimeout(() => !this.stopped && fs.existsSync(this.root) && this._startWatcher(), 10_000);
      });
      this.watcherOk = true;
    } catch {
      this.watcherOk = false;
    }
  }

  _closeWatcher() {
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = null;
    this.watcherOk = false;
  }

  /** A slow full scan as a safety net; much more frequent if live watching is unavailable. */
  _scheduleSafetyScan() {
    clearTimeout(this.timers.safety);
    this.timers.safety = setTimeout(() => {
      if (this.stopped) return;
      if (!this.watcherOk && fs.existsSync(this.root)) this._startWatcher();
      this.requestScan();
      this._scheduleSafetyScan();
    }, this.watcherOk ? 60_000 : 5_000);
  }

  async _scan() {
    if (this.stopped || this.paused) return;
    if (this.scanning) {
      this.scanAgain = true;
      return;
    }
    this.scanning = true;
    const op = this._beginOp();
    try {
      do {
        this.scanAgain = false;
        this.ig = createIgnoreFilter(this.root);
        const hash = await snapshot(this.root, { quietMs: 1000 });
        this.error = null;
        if (getDeferredCount(this.root) > 0) this.requestScan(); // files still being written
        if (hash) {
          this.lastChangeAt = Date.now();
          const match = /^sync: (\d+) file/.exec(readCommit(this.root, hash).message);
          const n = match ? Number(match[1]) : 1;
          this._log(`Saved ${n} change${n === 1 ? '' : 's'} on this PC`, 'out');
        }
      } while (this.scanAgain && !this.stopped);
    } catch (err) {
      this.error = friendlyError(err);
    } finally {
      this.scanning = false;
      this._endOp(op);
    }
  }

  // -- peers -----------------------------------------------------------------

  _reconcileLinks() {
    const peers = listPeers(this.root);
    const names = new Set(peers.map((p) => p.name));
    for (const peer of peers) {
      let link = this.links.get(peer.name);
      if (!link) {
        link = { name: peer.name, url: peer.url, online: null, error: null, lastOkAt: null, failures: 0, nextAt: 0, inFlight: false, again: false };
        this.links.set(peer.name, link);
      }
      link.url = peer.url;
    }
    for (const name of [...this.links.keys()]) {
      if (!names.has(name)) this.links.delete(name);
    }
  }

  /** Called when a new peer was just added to the config. */
  refreshPeers() {
    this._reconcileLinks();
    this._pokeAll();
    this._recompute();
  }

  _tick() {
    if (this.stopped) return;
    if (!fs.existsSync(path.join(this.root, GDIF_DIR))) {
      this.error = 'This folder cannot be found. If you moved or deleted it, remove it from MySync.';
      this._recompute();
      return;
    }
    if (this.error?.startsWith('This folder cannot be found')) {
      this.error = null;
      this._startWatcher();
      this.requestScan();
    }
    if (this.paused) return;
    this._reconcileLinks();
    const now = Date.now();
    for (const link of this.links.values()) {
      if (!link.inFlight && now >= link.nextAt) this._syncLink(link);
    }
  }

  _pokeAll() {
    if (this.stopped || this.paused) return;
    this._reconcileLinks();
    for (const link of this.links.values()) this._syncLink(link);
  }

  async _syncLink(link) {
    if (this.stopped || this.paused) return;
    if (link.inFlight) {
      link.again = true;
      return;
    }
    link.inFlight = true;
    const op = this._beginOp();
    const label = peerLabel(link.name);
    try {
      do {
        link.again = false;
        const result = await syncPeer(this.root, link.name, { skipSnapshot: true });
        const now = Date.now();
        if (link.online === false) this._log(`Reconnected to ${label}`);
        link.online = true;
        link.error = null;
        link.failures = 0;
        link.lastOkAt = now;
        link.nextAt = now + this.interval;
        this.lastCheckAt = now;
        this.blocked = null;
        if (result.pulled !== 'up-to-date') {
          this.lastChangeAt = now;
          this._log(`Received changes from ${label}`, 'in');
          this._noticeNewConflictCopies();
        }
        if (result.pushed) this._log(`Sent changes to ${label}`, 'out');
        for (const file of result.conflicts) this._addConflict(file);
      } while (link.again && !this.stopped && !this.paused);
    } catch (err) {
      const now = Date.now();
      if (err.code === 'ELOCKED') {
        // Not a connection problem: a file is open somewhere. Try again shortly.
        this.blocked = { file: err.file || err.message, at: now };
        link.nextAt = now + 5000;
      } else {
        if (link.online !== false) this._log(`Cannot reach ${label}: ${friendlyError(err)}`, 'warn');
        link.online = false;
        link.error = friendlyError(err);
        link.failures++;
        link.nextAt = now + Math.min(30_000, this.interval * 2 ** Math.min(link.failures, 5));
      }
    } finally {
      link.inFlight = false;
      this._endOp(op);
    }
  }

  /** Paths in the synced tree that are conflict copies, e.g. "notes.conflict-1a2b3c4.txt". */
  _conflictCopies() {
    try {
      const head = getHeadInfo(this.root).commitHash;
      if (!head) return new Set();
      const files = flattenTree(this.root, readCommit(this.root, head).treeHash);
      return new Set(Object.keys(files).filter((p) => CONFLICT_COPY.test(p)));
    } catch {
      return new Set();
    }
  }

  /**
   * Another device may have merged a conflict and sent us the result, so we never saw the
   * merge ourselves. New conflict copies in the tree are the evidence; tell the user.
   */
  _noticeNewConflictCopies() {
    const now = this._conflictCopies();
    for (const copy of now) {
      if (!this.knownCopies?.has(copy)) this._addConflict(copy.replace(CONFLICT_COPY, ''));
    }
    this.knownCopies = now;
  }

  _addConflict(file) {
    const recent = this.conflicts.find((c) => c.path === file && Date.now() - c.at < 60_000);
    if (recent) return;
    this.conflicts.unshift({ path: file, at: Date.now() });
    this.conflicts.length = Math.min(this.conflicts.length, MAX_CONFLICTS);
    this._log(`"${file}" was changed on two devices. Both versions were kept`, 'warn');
    this.emit('notify', { kind: 'conflict', root: this.root, name: this.name, files: [file] });
  }

  // -- status ----------------------------------------------------------------

  _beginOp() {
    const op = { startedAt: Date.now() };
    this.ops.add(op);
    setTimeout(() => this._recompute(), BUSY_AFTER_MS + 30).unref?.();
    return op;
  }

  _endOp(op) {
    this.ops.delete(op);
    this._recompute();
  }

  _log(text, kind = 'info') {
    this.activity.unshift({ id: ++this.activityId, at: Date.now(), text, kind });
    this.activity.length = Math.min(this.activity.length, MAX_ACTIVITY);
    this.emit('activity', { at: Date.now(), text, kind });
  }

  _isBusy() {
    const now = Date.now();
    for (const op of this.ops) if (now - op.startedAt > BUSY_AFTER_MS) return true;
    return false;
  }

  _status() {
    const links = [...this.links.values()];
    if (this.paused) return ['paused', 'Syncing is paused'];
    if (this.error) return ['attention', this.error];
    if (this.blocked) return ['waiting', `Waiting for "${path.basename(String(this.blocked.file))}" to be closed on a device`];
    if (this._isBusy()) return ['syncing', 'Syncing...'];
    if (links.length === 0) return ['alone', 'Not shared with another device yet'];
    if (links.every((l) => l.online === null)) return ['syncing', 'Connecting...'];
    if (!links.some((l) => l.online === true)) return ['offline', 'Cannot reach your other devices'];
    return ['synced', 'Up to date'];
  }

  /** Plain, serialisable description of this folder for a UI. */
  snapshot() {
    const [state, message] = this._status();
    return {
      root: this.root,
      name: this.name,
      folderId: this.folderId,
      state,
      message,
      missing: false,
      paused: this.paused,
      deviceName: this.deviceName,
      lastChangeAt: this.lastChangeAt,
      lastCheckAt: this.lastCheckAt,
      peers: [...this.links.values()].map((l) => ({
        name: l.name,
        label: peerLabel(l.name),
        kind: l.name === 'hub' ? 'internet' : 'local',
        online: l.online,
        error: l.error,
        lastOkAt: l.lastOkAt,
      })),
      conflicts: this.conflicts.slice(),
      skipped: getSkippedFiles(this.root),
      activity: this.activity.slice(0, 30),
      hub: getConfig(this.root).hub || null,
    };
  }

  _recompute(force = false) {
    const snap = this.snapshot();
    const signature = JSON.stringify([
      snap.state,
      snap.message,
      snap.name,
      snap.deviceName,
      snap.peers.map((p) => [p.name, p.online, p.error]),
      snap.conflicts.length,
      snap.skipped.length,
      snap.activity[0]?.id,
      snap.lastChangeAt,
    ]);
    if (!force && signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.emit('update', snap);
  }
}

/**
 * Stands in for a remembered folder that cannot be synced right now (moved, deleted, drive unplugged,
 * or its .mysync data is gone). It never recreates anything: re-initialising an empty folder would
 * look like "everything was deleted" to the other devices.
 */
class MissingWorkspace extends EventEmitter {
  constructor(root, { paused = false } = {}) {
    super();
    this.root = path.resolve(root);
    this.name = path.basename(this.root) || this.root;
    this.paused = paused;
    this.stopped = true;
    this.missing = true;
    this.folderId = null;
    this.deviceId = null;
    this.deviceName = '';
  }

  start() {
    this.stopped = false;
    this.timer = setInterval(() => {
      if (fs.existsSync(path.join(this.root, GDIF_DIR))) {
        clearInterval(this.timer);
        this.emit('recovered');
      }
    }, 10_000);
    this.timer.unref?.();
    this.emit('update', this.snapshot());
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  pause() {}
  resume() {}
  async syncNow() {}
  refreshIdentity() {}
  refreshPeers() {}
  noteIncoming() {}

  snapshot() {
    return {
      root: this.root,
      name: this.name,
      folderId: null,
      state: 'attention',
      message: fs.existsSync(this.root)
        ? 'The sync data for this folder is missing. Remove it from MySync, then add it again.'
        : 'This folder cannot be found. If you moved or deleted it, remove it from MySync.',
      missing: true,
      paused: false,
      deviceName: '',
      lastChangeAt: null,
      lastCheckAt: null,
      peers: [],
      conflicts: [],
      skipped: [],
      activity: [],
      hub: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Many folders, one server, one discovery socket
// ---------------------------------------------------------------------------

function listen(server, port, host, tries) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (p) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && ++attempt < tries) tryPort(p + 1);
        else reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    tryPort(port);
  });
}

/**
 * Runs any number of synced folders in one process. Folders are reachable at
 * /f/<folderId>/ on a single port. For the single-folder CLI, `rootWorkspace`
 * additionally serves that folder at the server root.
 *
 * Events: 'update' (workspace snapshot), 'removed' ({ root }), 'notify', 'server' ({ port, error }).
 */
export class Agent extends EventEmitter {
  /**
   * @param {{ port?: number, host?: string, portTries?: number, serve?: boolean, discover?: boolean,
   *           interval?: number, debounce?: number, rootWorkspace?: string|null }} [options]
   */
  constructor({ port = 3000, host = '0.0.0.0', portTries = 20, serve = true, discover = true, interval = 3, debounce = 600, rootWorkspace = null } = {}) {
    super();
    this.options = { port, host, portTries, serve, discover, interval, debounce };
    this.rootWorkspace = rootWorkspace ? path.resolve(rootWorkspace) : null;
    this.workspaces = new Map();
    this.port = null;
    this.server = null;
    this.discovery = null;
    this.recentlyFailed = new Map();
  }

  async start() {
    if (this.options.serve) {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', () => {});
      try {
        this.port = await listen(this.server, this.options.port, this.options.host, this.options.portTries);
        this.emit('server', { port: this.port, error: null });
      } catch (err) {
        this.server = null;
        this.emit('server', { port: null, error: friendlyError(err) });
      }
    }

    if (this.options.discover) {
      this.discovery = startDiscovery({
        announce: () => this._identities(),
        onPeer: (msg, address) => this._onPeer(msg, address),
      });
    }
    return this.port;
  }

  stop() {
    this.discovery?.stop();
    for (const ws of this.workspaces.values()) ws.stop();
    this.server?.close();
    this.server?.closeAllConnections?.();
  }

  /**
   * Starts syncing a folder. Throws a readable error for folders that should not be synced.
   * @param {string} root
   * @param {{ paused?: boolean, deviceName?: string, validate?: boolean, restore?: boolean }} [options]
   *   restore: this folder was synced before; if its sync data is gone, show it as missing instead of re-creating it
   */
  addWorkspace(root, { paused = false, deviceName = null, validate = true, restore = false } = {}) {
    const resolved = path.resolve(root);
    const existing = this.workspaces.get(resolved);
    if (existing) return existing;
    if (validate) validateWorkspaceRoot(resolved, [...this.workspaces.keys()]);

    if (restore && !fs.existsSync(path.join(resolved, GDIF_DIR))) {
      const placeholder = new MissingWorkspace(resolved, { paused });
      placeholder.on('update', (snap) => this.emit('update', snap));
      placeholder.on('recovered', () => {
        this.workspaces.delete(resolved);
        this.addWorkspace(resolved, { paused, deviceName, validate: false, restore: true });
      });
      this.workspaces.set(resolved, placeholder);
      placeholder.start();
      return placeholder;
    }

    initRepo(resolved);
    if (deviceName) {
      const config = getConfig(resolved);
      config.device = deviceName;
      writeConfig(resolved, config);
    }

    const ws = new Workspace(resolved, { interval: this.options.interval, debounce: this.options.debounce, paused });
    ws.on('update', (snap) => this.emit('update', snap));
    ws.on('notify', (info) => this.emit('notify', info));
    ws.on('activity', (entry) => this.emit('activity', { root: resolved, ...entry }));
    this.workspaces.set(resolved, ws);
    ws.start();
    return ws;
  }

  removeWorkspace(root) {
    const resolved = path.resolve(root);
    const ws = this.workspaces.get(resolved);
    if (!ws) return false;
    ws.stop();
    this.workspaces.delete(resolved);
    this.emit('removed', { root: resolved });
    return true;
  }

  getWorkspace(root) {
    return this.workspaces.get(path.resolve(root)) || null;
  }

  list() {
    return [...this.workspaces.values()].map((ws) => ws.snapshot());
  }

  /** Path other devices use to reach a folder on this agent's server. */
  pathFor(root) {
    const ws = this.getWorkspace(root);
    return ws && root !== this.rootWorkspace ? `/f/${ws.folderId}` : '';
  }

  _findById(folderId) {
    for (const ws of this.workspaces.values()) if (ws.folderId === folderId) return ws;
    return null;
  }

  _identities() {
    if (!this.port) return [];
    return [...this.workspaces.values()]
      .filter((ws) => !ws.stopped && ws.folderId)
      .map((ws) => ({
        folderId: ws.folderId,
        deviceId: ws.deviceId,
        device: ws.deviceName,
        port: this.port,
        ...(ws.root === this.rootWorkspace ? {} : { path: `/f/${ws.folderId}` }),
      }));
  }

  _handle(req, res) {
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    let ws = null;
    let url = req.url;
    const match = req.url.match(/^\/f\/([0-9a-f]{16})(\/.*)$/);
    if (match) {
      ws = this._findById(match[1]);
      url = match[2];
    } else if (this.rootWorkspace) {
      ws = this.workspaces.get(this.rootWorkspace) || null;
    } else if (req.url === '/health') {
      return reply(200, { ok: true });
    }

    if (!ws || ws.stopped) return reply(404, { error: 'Not found' });
    if (ws.paused && req.method === 'POST') return reply(503, { error: 'syncing is paused on this device' });

    handleSyncRequest(req, res, url, {
      repoRoot: ws.root,
      token: getOrCreateToken(ws.root),
      bare: false,
      onChange: () => ws.noteIncoming(),
    });
  }

  async _onPeer(msg, address) {
    const ws = this._findById(msg.folderId);
    if (!ws || ws.paused || ws.stopped) return;
    const key = `${address}:${msg.port}${msg.path || ''}`;
    if (Date.now() - (this.recentlyFailed.get(key) || 0) < 30_000) return;
    // A device announces from every network adapter it has. While the address we already use works,
    // keep it instead of hopping between equally valid ones.
    const current = ws.links.get(peerName(msg.device, msg.deviceId));
    if (current?.online === true && Date.now() - (current.lastOkAt || 0) < 30_000) return;
    try {
      if (await adoptDiscoveredPeer(ws.root, msg, address)) {
        ws._log(`Found ${msg.device} on your network`);
        ws.refreshPeers();
      } else if (!listPeers(ws.root).some((p) => p.url === `http://${key}`)) {
        this.recentlyFailed.set(key, Date.now());
      }
    } catch {
      this.recentlyFailed.set(key, Date.now());
    }
  }
}
