// Runs the MySync sync engine in its own process so heavy work (hashing big folders,
// network transfers) can never freeze the app window. The Electron main process talks
// to this file through a tiny request/response protocol:
//   request  { id, cmd, args }
//   response { id, ok: true, result } | { id, ok: false, error: { message, code } }
//   event    { event, data }
// It works both as an Electron utilityProcess (parentPort) and a plain Node child (process.send),
// which is how the tests drive it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = process.env.MYSYNC_ENGINE_DIR || path.resolve(here, '..', 'engine');
const E = await import(pathToFileURL(path.join(engineDir, 'index.js')).href);

const send = process.parentPort ? (msg) => process.parentPort.postMessage(msg) : (msg) => process.send?.(msg);
const listen = process.parentPort
  ? (fn) => process.parentPort.on('message', (e) => fn(e.data))
  : (fn) => process.on('message', fn);

const emit = (event, data) => send({ event, data });

let agent = null;
let deviceName = 'My PC';

const userError = (message) => Object.assign(new Error(message), { code: 'EUSER' });

function requireAgent() {
  if (!agent) throw userError('The sync engine is not ready yet.');
  return agent;
}

function cleanDeviceName(name) {
  const cleaned = String(name || '').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!cleaned) throw userError('Please enter a name for this PC.');
  return cleaned;
}

function roots() {
  return [...requireAgent().workspaces.keys()];
}

function inviteFor(root) {
  const a = requireAgent();
  const ws = a.getWorkspace(root);
  if (!ws || ws.missing || !ws.folderId) throw userError('This folder is not being synced.');
  const config = E.getConfig(root);
  const data = { t: E.getOrCreateToken(root) };
  if (config.hub) {
    data.h = config.hub.url;
    data.w = config.hub.workspace;
  }
  data.l = a.port ? E.lanAddresses().map((ip) => `http://${ip}:${a.port}/f/${ws.folderId}`) : [];
  return E.encodeInvite(data);
}

const handlers = {
  async init({ deviceName: name, port = 3000, discover = true, interval = 3 } = {}) {
    if (agent) throw userError('Already started.');
    deviceName = cleanDeviceName(name || deviceName);
    agent = new E.Agent({ port, discover, interval, debounce: 600 });
    agent.on('update', (snap) => emit('update', snap));
    agent.on('removed', (info) => emit('removed', info));
    agent.on('notify', (info) => emit('notify', info));
    agent.on('server', (info) => emit('server', info));
    await agent.start();
    return { port: agent.port };
  },

  /** Re-attach folders remembered from last run. Missing folders show up as "not found", never re-created. */
  restore({ folders = [] } = {}) {
    for (const { root, paused } of folders) {
      try {
        requireAgent().addWorkspace(root, { paused: !!paused, deviceName, validate: false, restore: true });
      } catch (err) {
        console.error(`could not restore ${root}: ${err.message}`);
      }
    }
    return requireAgent().list();
  },

  list() {
    return requireAgent().list();
  },

  /** Checks a folder is a sensible thing to sync and measures it, so the UI can warn about huge ones. */
  inspectFolder({ root }) {
    E.validateWorkspaceRoot(root, roots());
    return { estimate: E.estimateFolder(root) };
  },

  addFolder({ root }) {
    const a = requireAgent();
    E.validateWorkspaceRoot(root, roots());
    const ws = a.addWorkspace(root, { deviceName, validate: false });
    return ws.snapshot();
  },

  inspectInvite({ code }) {
    try {
      const invite = E.decodeInvite(String(code || '').trim());
      return {
        valid: true,
        name: invite.w || null,
        hasHub: !!invite.h,
        lanCount: (invite.l || []).length,
      };
    } catch {
      return { valid: false };
    }
  },

  async joinFolder({ code, dest, token = null }) {
    const a = requireAgent();
    const target = String(code || '').trim();
    if (!target) throw userError('Paste the invite code first.');
    const created = !fs.existsSync(dest);
    fs.mkdirSync(dest, { recursive: true });
    try {
      E.validateWorkspaceRoot(dest, roots());
      await E.join(target, dest, { token, device: deviceName, initialSync: false });
    } catch (err) {
      if (created) fs.rmSync(dest, { recursive: true, force: true }); // we made it, so nothing of the user's is in it
      throw err;
    }
    const ws = a.addWorkspace(dest, { deviceName, validate: false });
    return ws.snapshot();
  },

  invite({ root }) {
    return { code: inviteFor(root) };
  },

  async publish({ root, name }) {
    const ws = requireAgent().getWorkspace(root);
    if (!ws || ws.missing) throw userError('This folder is not being synced.');
    await E.publish(root, name, { port: agent.port || 3000 });
    ws.refreshPeers();
    return { code: inviteFor(root), snapshot: ws.snapshot() };
  },

  pause({ root }) {
    requireAgent().getWorkspace(root)?.pause();
    return true;
  },

  resume({ root }) {
    requireAgent().getWorkspace(root)?.resume();
    return true;
  },

  async syncNow({ root }) {
    await requireAgent().getWorkspace(root)?.syncNow();
    return true;
  },

  /** Stop syncing a folder. The files stay exactly where they are; `forget` also deletes MySync's hidden history. */
  removeFolder({ root, forget = false }) {
    const removed = requireAgent().removeWorkspace(root);
    if (forget) {
      try { fs.rmSync(path.join(root, E.GDIF_DIR), { recursive: true, force: true }); } catch { /* best effort */ }
    }
    return removed;
  },

  setDeviceName({ name }) {
    deviceName = cleanDeviceName(name);
    for (const ws of requireAgent().workspaces.values()) {
      if (ws.missing) continue;
      const config = E.getConfig(ws.root);
      config.device = deviceName;
      E.writeConfig(ws.root, config);
      ws.refreshIdentity();
      ws._recompute(true);
    }
    return deviceName;
  },

  getHub() {
    const hub = E.getDefaultHub();
    return hub ? { url: hub.url, hasSecret: !!hub.secret } : null;
  },

  setHub({ url, secret }) {
    const trimmed = String(url || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
      E.clearDefaultHub();
      return null;
    }
    if (!/^https?:\/\//.test(trimmed)) throw userError('The address must start with http:// or https://');
    E.setDefaultHub(trimmed, secret || E.getDefaultHub()?.secret || null);
    return handlers.getHub();
  },

  async testHub({ url }) {
    const target = String(url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(target)) throw userError('The address must start with http:// or https://');
    try {
      const res = await fetch(`${target}/health`, { signal: AbortSignal.timeout(6000) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.hub) return { ok: true };
      return { ok: false, error: 'That address answered, but it is not a MySync server.' };
    } catch (err) {
      return { ok: false, error: E.friendlyError(err) };
    }
  },

  shutdown() {
    agent?.stop();
    setTimeout(() => process.exit(0), 50);
    return true;
  },
};

listen(async (msg) => {
  if (!msg || typeof msg.id !== 'number') return;
  try {
    const handler = handlers[msg.cmd];
    if (!handler) throw userError(`unknown command ${msg.cmd}`);
    send({ id: msg.id, ok: true, result: await handler(msg.args || {}) });
  } catch (err) {
    send({ id: msg.id, ok: false, error: { message: E.friendlyError(err), code: err.code || null } });
  }
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
  emit('fatal', { message: String(err?.message || err) });
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

emit('ready', { pid: process.pid });
