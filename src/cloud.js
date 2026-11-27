// Cloud sync: use storage you already have (Google Drive, OneDrive, MEGA, WebDAV, or
// any folder a desktop sync client keeps in the cloud) as an always-on meeting point,
// like a hub you do not have to run.
//
// Layout inside the provider's MySync folder, one sub-folder per workspace:
//   <name>/workspace.json        { format, folderId, token, name, createdAt }
//   <name>/objects/<hash>        immutable, content-addressed (same bytes as .mysync/objects)
//   <name>/heads/<deviceId>.json { deviceId, device, branch, commit, at }
//
// Cloud storage cannot do an atomic "update only if unchanged", so instead of one
// shared branch every device owns its own head file and nobody else ever writes it.
// Objects are uploaded before the head that needs them, and each device folds all
// heads into one commit with the same deterministic merge, so they all converge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  GDIF_DIR,
  initRepo,
  getConfig,
  writeConfig,
  setRemote,
  getPeer,
  getHeadInfo,
  getOrCreateDeviceId,
  getOrCreateFolderId,
  getOrCreateToken,
  updateRemoteBranchRef,
} from './repo.js';
import { getObjectPath, childHashes, reachableObjects, isValidObject } from './objects.js';
import { integrate, mergeCommits, isAncestor, snapshot, getDeviceName } from './auto.js';
import { readGlobal, writeGlobal } from './global.js';
import { isValidWorkspaceName } from './hub.js';
import {
  FolderStore,
  WebDavStore,
  GoogleDriveStore,
  OneDriveStore,
  MegaStore,
  OAUTH,
  ROOT_FOLDER,
  startOAuth,
  cloudError,
} from './cloud-store.js';

export { cloudError, ROOT_FOLDER } from './cloud-store.js';

const HASH_RE = /^[0-9a-f]{40}$/;
const DEVICE_RE = /^[0-9a-f]{16}$/;
const ACCOUNT_RE = /^[a-z]+-[0-9a-f]{6,16}$/;
const CONCURRENCY = 8;

export const CLOUD_PROVIDERS = {
  gdrive: { label: 'Google Drive', oauth: true },
  onedrive: { label: 'OneDrive', oauth: true },
  mega: { label: 'MEGA' },
  webdav: { label: 'WebDAV' },
  folder: { label: 'Cloud folder' },
};

// ---------------------------------------------------------------------------
// Accounts: kept in the per-user global config, so every folder on this machine
// can use them. They hold sign-in tokens, so the file is only readable by you.
// ---------------------------------------------------------------------------

function accounts() {
  return readGlobal().cloud?.accounts || {};
}

function saveAccount(id, account) {
  const data = readGlobal();
  data.cloud ??= {};
  data.cloud.accounts ??= {};
  data.cloud.accounts[id] = account;
  writeGlobal(data);
}

function patchAccount(id, patch) {
  const data = readGlobal();
  const account = data.cloud?.accounts?.[id];
  if (!account) return;
  Object.assign(account, patch);
  writeGlobal(data);
}

/** What a UI may show about an account: never passwords or tokens. */
function publicAccount(id, a) {
  return {
    id,
    provider: a.provider,
    providerLabel: CLOUD_PROVIDERS[a.provider]?.label || a.provider,
    label: a.label || CLOUD_PROVIDERS[a.provider]?.label || a.provider,
    detail: a.detail || null,
    path: a.provider === 'folder' ? a.path : undefined,
    url: a.provider === 'webdav' ? a.url : undefined,
  };
}

export function listCloudAccounts() {
  return Object.entries(accounts()).map(([id, a]) => publicAccount(id, a));
}

export function getCloudAccount(id) {
  const a = accounts()[id];
  return a ? publicAccount(id, a) : null;
}

/** OAuth app ids: per-machine settings, then environment variables. */
export function getCloudApp(provider) {
  const saved = readGlobal().cloud?.apps?.[provider] || {};
  const prefix = provider === 'gdrive' ? 'MYSYNC_GOOGLE' : 'MYSYNC_ONEDRIVE';
  return {
    clientId: saved.clientId || process.env[`${prefix}_CLIENT_ID`] || null,
    clientSecret: saved.clientSecret || process.env[`${prefix}_CLIENT_SECRET`] || null,
  };
}

export function setCloudApp(provider, { clientId, clientSecret = null }) {
  if (!OAUTH[provider]) throw cloudError(`${provider} does not use an app ID`);
  const data = readGlobal();
  data.cloud ??= {};
  data.cloud.apps ??= {};
  if (!clientId) delete data.cloud.apps[provider];
  else data.cloud.apps[provider] = { clientId: String(clientId).trim(), ...(clientSecret ? { clientSecret: String(clientSecret).trim() } : {}) };
  writeGlobal(data);
}

const stores = new Map();

function makeStore(id, a) {
  switch (a.provider) {
    case 'folder': return new FolderStore(a);
    case 'webdav': return new WebDavStore(a);
    case 'mega': return new MegaStore(a);
    case 'gdrive': return new GoogleDriveStore(a, (patch) => patchAccount(id, patch));
    case 'onedrive': return new OneDriveStore(a, (patch) => patchAccount(id, patch));
    default: throw cloudError(`Unknown cloud provider ${a.provider}`);
  }
}

/** The storage behind an account, reused so caches (Drive ids, MEGA session) survive. */
export function openStore(id) {
  const a = accounts()[id];
  if (!a) throw cloudError('This cloud account was removed from MySync. Connect it again in Settings', { code: 'ECLOUDGONE' });
  const fingerprint = JSON.stringify([a.provider, a.path, a.url, a.username, a.password, a.email, a.refreshToken, a.clientId]);
  const cached = stores.get(id);
  if (cached && cached.fingerprint === fingerprint) return cached.store;
  const store = makeStore(id, a);
  stores.set(id, { store, fingerprint });
  return store;
}

const newAccountId = (provider) => `${provider}-${crypto.randomBytes(4).toString('hex')}`;

/**
 * Adds an account that signs in with settings typed by the person (folder, WebDAV, MEGA).
 * The connection is tested first, so a typo never ends up saved.
 * @returns {Promise<ReturnType<typeof publicAccount>>}
 */
export async function addCloudAccount(provider, settings = {}) {
  let account;
  if (provider === 'folder') {
    const dir = path.resolve(String(settings.path || ''));
    if (!settings.path || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw cloudError('Choose a folder that exists');
    account = { provider, path: dir, label: settings.label || guessFolderLabel(dir), detail: dir };
  } else if (provider === 'webdav') {
    const url = String(settings.url || '').trim().replace(/\/+$/, '');
    account = { provider, url, username: settings.username || '', password: settings.password || '', label: settings.label || 'WebDAV', detail: url ? safeHost(url) : null };
  } else if (provider === 'mega') {
    const email = String(settings.email || '').trim();
    account = { provider, email, password: settings.password || '', label: 'MEGA', detail: email };
  } else if (OAUTH[provider]) {
    throw cloudError(`${CLOUD_PROVIDERS[provider].label} is connected by signing in, not with typed settings`);
  } else {
    throw cloudError(`Unknown cloud provider ${provider}`);
  }

  const existing = Object.entries(accounts()).find(([, a]) => a.provider === provider && sameTarget(a, account));
  const id = existing?.[0] || newAccountId(provider);
  await makeStore(id, account).check();
  saveAccount(id, account);
  stores.delete(id);
  return publicAccount(id, account);
}

function sameTarget(a, b) {
  if (a.provider === 'folder') return path.resolve(a.path).toLowerCase() === path.resolve(b.path).toLowerCase();
  if (a.provider === 'webdav') return a.url === b.url && a.username === b.username;
  if (a.provider === 'mega') return a.email.toLowerCase() === b.email.toLowerCase();
  return false;
}

const safeHost = (url) => {
  try { return new URL(url).host; } catch { return url; }
};

/**
 * Signs in to Google Drive or OneDrive. Resolves { url, done, cancel } at once: open
 * `url` in a browser; `done` resolves with the new account after the person approves.
 */
export async function connectCloudAccount(provider, { clientId = null, clientSecret = null, timeoutMs } = {}) {
  if (!OAUTH[provider]) throw cloudError(`${provider} is not connected by signing in`);
  const app = getCloudApp(provider);
  const id = clientId || app.clientId;
  const secret = clientSecret || (clientId ? null : app.clientSecret);
  const flow = await startOAuth(provider, { clientId: id, clientSecret: secret, timeoutMs });
  const done = flow.result.then(async (tokens) => {
    const account = { provider, clientId: id, clientSecret: secret, ...tokens, label: CLOUD_PROVIDERS[provider].label };
    const tmpId = newAccountId(provider);
    const store = makeStore(tmpId, account);
    await store.check();
    account.detail = await store.whoami().catch(() => null);
    // Signing in to the same account again refreshes it instead of adding a twin.
    const existing = Object.entries(accounts()).find(([, a]) => a.provider === provider && account.detail && a.detail === account.detail);
    const accountId = existing?.[0] || tmpId;
    saveAccount(accountId, account);
    stores.delete(accountId);
    return publicAccount(accountId, account);
  });
  done.catch(() => {});
  return { url: flow.url, done, cancel: flow.cancel };
}

/** Forgets an account on this PC. Files in the cloud are left alone. */
export function removeCloudAccount(id) {
  const data = readGlobal();
  if (!data.cloud?.accounts?.[id]) return false;
  delete data.cloud.accounts[id];
  writeGlobal(data);
  stores.delete(id);
  return true;
}

// ---------------------------------------------------------------------------
// Finding cloud folders on this PC (desktop sync clients)
// ---------------------------------------------------------------------------

function guessFolderLabel(dir) {
  const lower = dir.toLowerCase();
  if (lower.includes('onedrive')) return 'OneDrive';
  if (lower.includes('google drive') || lower.includes('my drive') || lower.includes('googledrive')) return 'Google Drive';
  if (lower.includes('dropbox')) return 'Dropbox';
  if (lower.includes('mega')) return 'MEGA';
  if (lower.includes('icloud')) return 'iCloud Drive';
  if (lower.includes('box')) return 'Box';
  return path.basename(dir) || 'Cloud folder';
}

/**
 * Folders that desktop sync clients keep in the cloud, found where they usually live.
 * @returns {Array<{ label: string, path: string }>}
 */
export function detectCloudFolders() {
  const home = os.homedir();
  const candidates = [];
  const add = (label, dir) => {
    if (dir && !candidates.some((c) => c.path.toLowerCase() === dir.toLowerCase())) candidates.push({ label, path: dir });
  };
  for (const name of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (process.env[name]) add(name === 'OneDriveCommercial' ? 'OneDrive (work)' : 'OneDrive', process.env[name]);
  }
  try {
    for (const entry of fs.readdirSync(home)) {
      const match = /^OneDrive(?: - (.+))?$/.exec(entry);
      if (match) add(match[1] ? `OneDrive (${match[1]})` : 'OneDrive', path.join(home, entry));
    }
  } catch { /* unreadable home */ }
  add('Dropbox', path.join(home, 'Dropbox'));
  add('MEGA', path.join(home, 'MEGA'));
  add('MEGA', path.join(home, 'Documents', 'MEGA'));
  add('MEGA', path.join(home, 'MEGAsync'));
  add('iCloud Drive', path.join(home, 'iCloudDrive'));
  add('Box', path.join(home, 'Box'));
  add('Google Drive', path.join(home, 'Google Drive'));
  add('Google Drive', path.join(home, 'My Drive'));
  if (process.platform === 'win32') {
    // Google Drive for desktop shows up as its own drive letter (G: by default).
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') add('Google Drive', `${letter}:\\My Drive`);
  } else {
    add('Google Drive', path.join(home, 'Library', 'CloudStorage'));
  }
  return candidates.filter((c) => {
    try { return fs.statSync(c.path).isDirectory(); } catch { return false; }
  });
}

// ---------------------------------------------------------------------------
// Remotes: a cloud workspace is stored as the remote URL "cloud:<account>/<name>"
// ---------------------------------------------------------------------------

export const isCloudUrl = (url) => typeof url === 'string' && url.startsWith('cloud:');
export const cloudRemoteName = (accountId) => `cloud-${accountId}`;
export const isCloudRemoteName = (name) => typeof name === 'string' && name.startsWith('cloud-');

export function parseCloudUrl(url) {
  const match = /^cloud:([^/]+)\/(.+)$/.exec(String(url));
  if (!match || !ACCOUNT_RE.test(match[1]) || !isValidWorkspaceName(match[2])) throw cloudError(`Not a cloud address: ${url}`);
  return { accountId: match[1], workspace: match[2] };
}

/** Friendly name for a cloud remote, e.g. "Google Drive". */
export function cloudLabel(remoteName) {
  const a = accounts()[String(remoteName).slice('cloud-'.length)];
  return a ? a.label || CLOUD_PROVIDERS[a.provider]?.label : 'Cloud storage';
}

function cleanName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

async function readJson(store, key) {
  const data = await store.read(key);
  if (!data) return null;
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Workspaces stored in a cloud account, for a "join from the cloud" list.
 * @returns {Promise<Array<{ name: string, folderId: string, devices: Array<{ device: string, at: number }>, updatedAt: number|null }>>}
 */
export async function listCloudWorkspaces(accountId) {
  const store = openStore(accountId);
  const entries = (await store.list('')).filter((e) => e.dir && isValidWorkspaceName(e.name));
  const out = [];
  await eachLimit(entries, CONCURRENCY, async ({ name }) => {
    const manifest = await readJson(store, `${name}/workspace.json`);
    if (!manifest?.folderId) return;
    const heads = await readHeads(store, name, null);
    out.push({
      name,
      folderId: manifest.folderId,
      devices: heads.map((h) => ({ device: h.device, at: h.at })),
      updatedAt: heads.reduce((max, h) => Math.max(max, h.at || 0), 0) || manifest.createdAt || null,
    });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Starts syncing this folder through a cloud account, under `name` (made from the
 * folder name if not given). Re-linking a folder that is already there is fine;
 * a name used by a different folder is refused.
 * @returns {Promise<{ remote: string, name: string, created: boolean }>}
 */
export async function linkCloud(repoRoot, accountId, name = null, { initialSync = true } = {}) {
  const store = openStore(accountId);
  const ws = cleanName(name || path.basename(repoRoot));
  if (!isValidWorkspaceName(ws)) throw cloudError('Choose a name of 2 to 63 letters, numbers, dots, dashes or underscores');

  const token = getOrCreateToken(repoRoot);
  const folderId = getOrCreateFolderId(repoRoot);
  await store.check();

  const manifest = await readJson(store, `${ws}/workspace.json`);
  let created = false;
  if (manifest && manifest.folderId !== folderId) {
    throw cloudError(`“${ws}” is already used by another folder in this cloud account. Pick another name`, { code: 'ECLOUDTAKEN' });
  }
  if (!manifest) {
    await store.write(`${ws}/workspace.json`, Buffer.from(JSON.stringify({ format: 1, folderId, token, name: ws, createdAt: Date.now() }, null, 2)));
    created = true;
  }

  const remote = cloudRemoteName(accountId);
  setRemote(repoRoot, remote, `cloud:${accountId}/${ws}`);
  if (initialSync) await syncCloud(repoRoot, remote);
  return { remote, name: ws, created };
}

/** Stops syncing this folder through that account. Its copy in the cloud stays. */
export function unlinkCloud(repoRoot, accountId) {
  const config = getConfig(repoRoot);
  const remote = cloudRemoteName(accountId);
  if (!config.remotes?.[remote]) return false;
  delete config.remotes[remote];
  delete config.remoteTokens?.[remote];
  writeConfig(repoRoot, config);
  fs.rmSync(path.join(repoRoot, GDIF_DIR, 'refs', 'remotes', remote), { recursive: true, force: true });
  return true;
}

/**
 * Joins a workspace stored in a cloud account into `targetDir` (new, or holding
 * files to merge in). Devices joined this way can also find each other on the LAN.
 * @returns {Promise<{ repoRoot: string, peer: string, pulled?: string, pushed?: boolean, conflicts?: string[] }>}
 */
export async function joinCloud(accountId, name, targetDir, { device = null, initialSync = true } = {}) {
  const store = openStore(accountId);
  const ws = cleanName(name);
  const manifest = isValidWorkspaceName(ws) ? await readJson(store, `${ws}/workspace.json`) : null;
  if (!manifest?.folderId || !manifest.token) throw cloudError(`There is no folder called “${name}” in this cloud account`, { code: 'ECLOUDGONE' });

  const repoRoot = path.resolve(process.cwd(), targetDir || ws);
  fs.mkdirSync(repoRoot, { recursive: true });
  initRepo(repoRoot);
  const config = getConfig(repoRoot);
  if (config.folderId && config.folderId !== manifest.folderId) {
    throw cloudError('This folder is already synced with a different workspace; choose another folder');
  }
  config.token = manifest.token;
  config.folderId = manifest.folderId;
  if (device) config.device = device;
  writeConfig(repoRoot, config);

  const remote = cloudRemoteName(accountId);
  setRemote(repoRoot, remote, `cloud:${accountId}/${ws}`);
  if (!initialSync) return { repoRoot, peer: remote };
  const result = await syncCloud(repoRoot, remote);
  return { ...result, repoRoot, peer: remote };
}

// ---------------------------------------------------------------------------
// The sync round
// ---------------------------------------------------------------------------

async function eachLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

// Head files rarely change, so their contents are remembered by version and a quiet
// round costs one listing.
const headCache = new Map();

async function readHeads(store, ws, cacheKey) {
  const entries = (await store.list(`${ws}/heads`)).filter((e) => !e.dir && /^[0-9a-f]{16}\.json$/.test(e.name));
  const heads = [];
  await eachLimit(entries, CONCURRENCY, async ({ name, version }) => {
    const key = `${cacheKey}|${name}`;
    const hit = cacheKey && headCache.get(key);
    let head = hit && hit.version === version && version ? hit.head : null;
    if (!head) {
      head = await readJson(store, `${ws}/heads/${name}`);
      if (cacheKey && head) headCache.set(key, { version, head });
    }
    if (head && DEVICE_RE.test(head.deviceId) && `${head.deviceId}.json` === name && HASH_RE.test(head.commit || '')) heads.push(head);
  });
  return heads;
}

/**
 * Downloads every object reachable from `roots` that this folder does not have yet.
 * Normally an object being present means everything below it is too, so the walk stops
 * there. An interrupted download breaks that (a commit arrived, some files did not), so
 * it leaves a marker and the next attempt walks through objects it already has.
 */
async function download(repoRoot, store, ws, roots) {
  const marker = path.join(repoRoot, GDIF_DIR, 'cloud-incomplete.json');
  let deep = false;
  try {
    roots = [...new Set([...roots, ...JSON.parse(fs.readFileSync(marker, 'utf8'))])];
    deep = true;
  } catch { /* no unfinished download */ }
  fs.writeFileSync(marker, JSON.stringify(roots.filter((h) => HASH_RE.test(h || ''))));

  const seen = new Set();
  let level = roots.filter((h) => h && (deep || !fs.existsSync(getObjectPath(repoRoot, h))));
  while (level.length > 0) {
    const nextLevel = [];
    await eachLimit(level, CONCURRENCY, async (hash) => {
      if (seen.has(hash)) return;
      seen.add(hash);
      const objPath = getObjectPath(repoRoot, hash);
      if (!fs.existsSync(objPath)) {
        const data = await store.read(`${ws}/objects/${hash}`);
        // A desktop sync client may still be bringing it down: just try again next round.
        if (!data) throw cloudError('Some changes are still on their way to the cloud. Trying again shortly', { code: 'ECLOUDPARTIAL' });
        if (!isValidObject(hash, data)) throw cloudError('A file in the cloud copy is damaged. Trying again shortly', { code: 'ECLOUDPARTIAL' });
        fs.mkdirSync(path.dirname(objPath), { recursive: true });
        const tmp = `${objPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, objPath);
      }
      for (const child of childHashes(repoRoot, hash)) {
        if (!seen.has(child) && (deep || !fs.existsSync(getObjectPath(repoRoot, child)))) nextLevel.push(child);
      }
    });
    level = nextLevel;
  }
  fs.rmSync(marker, { force: true });
}

const verified = new Map();

/** Makes sure the cloud folder still belongs to this workspace (checked once per process). */
async function checkManifest(store, ws, url, folderId) {
  if (verified.get(url) === folderId) return;
  const manifest = await readJson(store, `${ws}/workspace.json`);
  if (!manifest) throw cloudError('The cloud copy of this folder was deleted. Link it again to start over', { code: 'ECLOUDGONE' });
  if (manifest.folderId !== folderId) throw cloudError('The cloud copy now belongs to a different folder', { code: 'ECLOUDTAKEN' });
  verified.set(url, folderId);
}

/**
 * One two-way sync round with a cloud workspace: bring in every other device's head
 * (one deterministic merge of all of them), then upload what is new and move our head.
 * Called by syncPeer for remotes whose URL starts with "cloud:".
 * @returns {Promise<{ pulled: string, pushed: boolean, conflicts: string[] }>}
 */
export async function syncCloud(repoRoot, remoteName, { skipSnapshot = false } = {}) {
  const peer = getPeer(repoRoot, remoteName);
  if (!peer || !isCloudUrl(peer.url)) throw cloudError(`'${remoteName}' is not a cloud remote`);
  const { accountId, workspace: ws } = parseCloudUrl(peer.url);
  const store = openStore(accountId);
  const deviceId = getOrCreateDeviceId(repoRoot);
  await checkManifest(store, ws, peer.url, getOrCreateFolderId(repoRoot));

  if (!skipSnapshot) await snapshot(repoRoot);

  const branch = getHeadInfo(repoRoot).branch;
  const heads = await readHeads(store, ws, `${accountId}/${ws}`);
  const mine = heads.find((h) => h.deviceId === deviceId);
  const theirs = heads.filter((h) => h.deviceId !== deviceId && h.branch === branch).map((h) => h.commit);
  let ours = getHeadInfo(repoRoot).commitHash;
  let pulled = 'up-to-date';
  const conflicts = [];

  const news = [...new Set(theirs)].filter((c) => c !== ours && !(ours && fs.existsSync(getObjectPath(repoRoot, c)) && isAncestor(repoRoot, c, ours)));
  if (news.length > 0) {
    await download(repoRoot, store, ws, news);
    // Keep only heads nothing else contains, in a fixed order, so every device that
    // sees the same heads computes exactly the same combined commit.
    const candidates = [...new Set([ours, ...news].filter(Boolean))];
    const tips = candidates.filter((c) => !candidates.some((d) => d !== c && isAncestor(repoRoot, c, d))).sort();
    let target = tips[0];
    for (const tip of tips.slice(1)) {
      const merged = mergeCommits(repoRoot, target, tip);
      target = merged.commitHash;
      conflicts.push(...merged.conflicts);
    }
    if (target && target !== ours) {
      const result = await integrate(repoRoot, target);
      if (result.action !== 'up-to-date') pulled = result.action;
      conflicts.push(...result.conflicts);
      ours = getHeadInfo(repoRoot).commitHash;
    }
  }

  let pushed = false;
  if (ours && mine?.commit !== ours) {
    // Whatever any head in the cloud contains is already uploaded (heads are written last).
    const hashes = reachableObjects(repoRoot, ours, heads.map((h) => h.commit));
    await eachLimit(hashes, CONCURRENCY, async (hash) => {
      await store.write(`${ws}/objects/${hash}`, fs.readFileSync(getObjectPath(repoRoot, hash)));
    });
    const head = { deviceId, device: getDeviceName(repoRoot), branch, commit: ours, at: Date.now() };
    await store.write(`${ws}/heads/${deviceId}.json`, Buffer.from(JSON.stringify(head, null, 2)));
    pushed = true;
  }
  if (ours) updateRemoteBranchRef(repoRoot, remoteName, branch, ours);
  return { pulled, pushed, conflicts: [...new Set(conflicts)] };
}
