import fs from 'node:fs';
import path from 'node:path';
import {
  getPeer,
  listPeers,
  setRemote,
  updateRemoteBranchRef,
  initRepo,
  GDIF_DIR,
  getHeadInfo,
  getConfig,
  writeConfig,
  getOrCreateFolderId,
} from './repo.js';
import { checkout } from './branch.js';
import { readObject, readCommit, readTree, getObjectPath } from './objects.js';
import {
  fetchRemoteRefs,
  fetchRemoteObjects,
  fetchMissingOnRemote,
  pushRemoteObjects,
  updateRemoteRef,
  verifyPeer,
} from './client.js';
import { scanNearby } from './discovery.js';
import { snapshot, integrate } from './auto.js';

const PUSH_BATCH_BYTES = 8 * 1024 * 1024;

function requirePeer(repoRoot, remoteName) {
  const peer = getPeer(repoRoot, remoteName);
  if (!peer) throw new Error(`fatal: '${remoteName}' does not appear to be a mysync repository`);
  return peer;
}

/** Hashes an object refers to (tree + parents for commits, entries for trees). */
function childrenOf(repoRoot, hash) {
  const { type } = readObject(repoRoot, hash);
  if (type === 'commit') {
    const commit = readCommit(repoRoot, hash);
    return [commit.treeHash, ...commit.parentHashes].filter(Boolean);
  }
  if (type === 'tree') return readTree(repoRoot, hash).map((entry) => entry.hash);
  return [];
}

/**
 * Downloads missing objects from remote recursively.
 */
async function downloadMissingObjects(repoRoot, peer, rootHashes) {
  const queue = [...rootHashes];
  const requested = new Set();

  while (queue.length > 0) {
    const batch = [];
    while (queue.length > 0 && batch.length < 200) {
      const hash = queue.shift();
      if (!requested.has(hash) && !fs.existsSync(getObjectPath(repoRoot, hash))) {
        batch.push(hash);
        requested.add(hash);
      }
    }

    if (batch.length === 0) continue;

    const objects = await fetchRemoteObjects(peer, batch);

    for (const hash of batch) {
      if (!objects[hash]) throw new Error(`fatal: remote is missing object ${hash}`);
    }
    for (const [hash, base64Data] of Object.entries(objects)) {
      const objPath = getObjectPath(repoRoot, hash);
      fs.mkdirSync(path.dirname(objPath), { recursive: true });
      fs.writeFileSync(objPath, Buffer.from(base64Data, 'base64'));
      queue.push(...childrenOf(repoRoot, hash));
    }
  }
}

/**
 * Every object name reachable from `start`, skipping history the remote
 * already has (everything reachable from `remoteHead`).
 */
function collectHashes(repoRoot, start, remoteHead) {
  const known = new Set();
  if (remoteHead && fs.existsSync(getObjectPath(repoRoot, remoteHead))) {
    const stack = [remoteHead];
    while (stack.length > 0) {
      const hash = stack.pop();
      if (known.has(hash)) continue;
      known.add(hash);
      stack.push(...readCommit(repoRoot, hash).parentHashes);
    }
  }

  const found = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const hash = stack.pop();
    if (!hash || found.has(hash) || known.has(hash)) continue;
    found.add(hash);
    stack.push(...childrenOf(repoRoot, hash));
  }
  return [...found];
}

async function uploadObjects(repoRoot, peer, hashes) {
  let batch = {};
  let size = 0;
  for (const hash of hashes) {
    const data = fs.readFileSync(getObjectPath(repoRoot, hash));
    batch[hash] = data.toString('base64');
    size += data.length;
    if (size >= PUSH_BATCH_BYTES) {
      await pushRemoteObjects(peer, batch);
      batch = {};
      size = 0;
    }
  }
  await pushRemoteObjects(peer, batch);
}

/**
 * Fetches all branches from a remote.
 */
export async function fetch(repoRoot, remoteName, { quiet = false } = {}) {
  const peer = requirePeer(repoRoot, remoteName);

  if (!quiet) console.log(`Fetching from ${peer.url}...`);
  const refs = await fetchRemoteRefs(peer);

  await downloadMissingObjects(repoRoot, peer, Object.values(refs));

  for (const [branch, hash] of Object.entries(refs)) {
    updateRemoteBranchRef(repoRoot, remoteName, branch, hash);
    if (!quiet) console.log(` * [new branch]      ${branch} -> ${remoteName}/${branch}`);
  }
  return refs;
}

/**
 * Clones a repository.
 */
export async function clone(url, targetDir, { token = null } = {}) {
  const dirName = targetDir || path.basename(new URL(url).pathname) || 'mysync-repo';
  const repoRoot = path.resolve(process.cwd(), dirName);

  if (fs.existsSync(repoRoot) && fs.readdirSync(repoRoot).length > 0) {
    throw new Error(`fatal: destination path '${dirName}' already exists and is not an empty directory.`);
  }

  fs.mkdirSync(repoRoot, { recursive: true });
  initRepo(repoRoot);
  setRemote(repoRoot, 'origin', url, token);

  const refs = await fetch(repoRoot, 'origin');
  const defaultBranch = refs.main ? 'main' : Object.keys(refs)[0];

  if (defaultBranch) {
    const commitHash = refs[defaultBranch];
    const branchPath = path.join(repoRoot, GDIF_DIR, 'refs', 'heads', defaultBranch);
    fs.mkdirSync(path.dirname(branchPath), { recursive: true });
    fs.writeFileSync(branchPath, `${commitHash}\n`, 'utf8');

    checkout(repoRoot, defaultBranch);
  }
  console.log(`Cloned into '${dirName}'.`);
}

/** Stable remote name for a device, so rediscovering it updates one entry. */
export function peerName(device, deviceId) {
  return `${String(device).replace(/[^a-zA-Z0-9_-]/g, '_')}-${deviceId.slice(0, 4)}`;
}

/**
 * Finds nearby devices whose folder proves it shares `token`.
 * @returns {Promise<Array<{ url: string, device: string, deviceId: string, folderId: string }>>}
 */
export async function findNearby(token) {
  const verified = [];
  for (const candidate of await scanNearby()) {
    if (await verifyPeer(candidate.url, token)) verified.push(candidate);
  }
  return verified;
}

/**
 * Joins an existing mysync network from any folder (new, or already holding files).
 * Files already here are merged with the peer's, never overwritten. Pass url
 * 'auto' to find the device on the local network that accepts `token`.
 */
export async function join(url, targetDir, { token = null, device = null } = {}) {
  if (!token) throw new Error('fatal: --token is required to join');

  if (url === 'auto') {
    console.log('Looking for devices on the local network...');
    const nearby = await findNearby(token);
    if (nearby.length === 0) {
      throw new Error('fatal: no nearby device accepted that token. Is `mysync watch` running there? Otherwise pass its URL.');
    }
    url = nearby[0].url;
    console.log(`Found ${nearby[0].device} at ${url}`);
  }

  const info = await verifyPeer(url, token, { timeout: 5000 });
  if (!info) throw new Error(`fatal: could not reach ${url} or its token does not match`);

  const repoRoot = path.resolve(process.cwd(), targetDir || '.');
  fs.mkdirSync(repoRoot, { recursive: true });
  initRepo(repoRoot);

  // Every device in a folder shares one token and one folder id.
  const config = getConfig(repoRoot);
  config.token = token;
  config.folderId = info.folderId;
  if (device) config.device = device;
  writeConfig(repoRoot, config);

  const name = peerName(info.device, info.deviceId);
  setRemote(repoRoot, name, url, token);
  const result = await syncPeer(repoRoot, name);
  console.log(`Joined ${url} in ${repoRoot}`);
  return result;
}

/**
 * Records a device found on the LAN as a peer if it proves it shares our token.
 * @returns {Promise<boolean>} true when a peer was added or its address updated
 */
export async function adoptDiscoveredPeer(repoRoot, msg, address) {
  const config = getConfig(repoRoot);
  if (!config.token || msg.folderId !== getOrCreateFolderId(repoRoot)) return false;

  const url = `http://${address}:${msg.port}`;
  const name = peerName(msg.device, msg.deviceId);
  if (config.remotes?.[name] === url) return false;

  const info = await verifyPeer(url, config.token);
  if (!info || info.folderId !== msg.folderId || info.deviceId !== msg.deviceId) return false;
  setRemote(repoRoot, name, url, config.token);
  return true;
}

/**
 * Fetches and merges the given branch of a remote into the current branch.
 * Local uncommitted work is snapshotted first; diverged histories are merged.
 */
export async function pull(repoRoot, remoteName, branchName) {
  const peer = requirePeer(repoRoot, remoteName);
  const headInfo = getHeadInfo(repoRoot);
  if (branchName && headInfo.branch !== branchName) {
    throw new Error(`fatal: You are not currently on branch '${branchName}'.`);
  }

  const refs = await fetch(repoRoot, remoteName, { quiet: true });
  const targetHash = refs[headInfo.branch];
  if (!targetHash) throw new Error(`fatal: couldn't find remote ref ${headInfo.branch}`);

  const result = await integrate(repoRoot, targetHash);
  reportIntegration(headInfo.branch, result);
  return result;
}

function reportIntegration(branch, result) {
  if (result.action === 'up-to-date') console.log('Already up to date.');
  else if (result.action === 'fast-forward') console.log(`Fast-forwarded ${branch} to ${result.commitHash.slice(0, 7)}`);
  else console.log(`Merged into ${branch} at ${result.commitHash.slice(0, 7)}`);
  for (const file of result.conflicts) {
    console.log(`  conflict in ${file}: both versions kept (see ${file}.conflict-*)`);
  }
}

/**
 * Pushes local branch to remote. Rejects (status 409) if the remote has diverged;
 * `mysync sync` handles that by merging first.
 */
export async function push(repoRoot, remoteName, branchName) {
  const peer = requirePeer(repoRoot, remoteName);
  const headInfo = getHeadInfo(repoRoot);
  const branch = branchName || headInfo.branch;

  await snapshot(repoRoot);
  const localHash = getHeadInfo(repoRoot).commitHash;
  if (!localHash) throw new Error('fatal: nothing to push');

  const refs = await fetchRemoteRefs(peer).catch(() => ({}));
  const remoteHash = refs[branch];
  if (remoteHash === localHash) return 'up-to-date';

  const hashes = collectHashes(repoRoot, localHash, remoteHash);
  const missing = await fetchMissingOnRemote(peer, hashes);
  await uploadObjects(repoRoot, peer, missing);
  await updateRemoteRef(peer, branch, localHash);
  updateRemoteBranchRef(repoRoot, remoteName, branch, localHash);
  return `pushed ${missing.length} objects`;
}

/**
 * One full two-way sync round with a peer: snapshot local edits, merge the
 * peer's changes in, then push the result back. Retries if the peer moved.
 * @returns {Promise<{ pulled: string, pushed: boolean, conflicts: string[] }>}
 */
export async function syncPeer(repoRoot, remoteName) {
  const peer = requirePeer(repoRoot, remoteName);
  const conflicts = [];
  let pulled = 'up-to-date';
  let pushed = false;

  await snapshot(repoRoot);

  for (let attempt = 0; attempt < 4; attempt++) {
    const branch = getHeadInfo(repoRoot).branch;
    const refs = await fetchRemoteRefs(peer);
    const theirs = refs[branch];

    if (theirs) {
      await downloadMissingObjects(repoRoot, peer, [theirs]);
      updateRemoteBranchRef(repoRoot, remoteName, branch, theirs);
      const result = await integrate(repoRoot, theirs);
      if (result.action !== 'up-to-date') pulled = result.action;
      conflicts.push(...result.conflicts);
    }

    const ours = getHeadInfo(repoRoot).commitHash;
    if (!ours || ours === theirs) return { pulled, pushed, conflicts };

    try {
      const hashes = collectHashes(repoRoot, ours, theirs);
      const missing = await fetchMissingOnRemote(peer, hashes);
      await uploadObjects(repoRoot, peer, missing);
      await updateRemoteRef(peer, branch, ours);
      updateRemoteBranchRef(repoRoot, remoteName, branch, ours);
      pushed = true;
      return { pulled, pushed, conflicts };
    } catch (err) {
      if (err.status !== 409) throw err; // peer moved while we merged: go around again
    }
  }

  throw new Error(`peer '${remoteName}' kept changing; will retry next round`);
}

/**
 * Syncs with every configured remote. Failures are reported per peer.
 * @returns {Promise<Array<{ name: string, ok: boolean, error?: string, pulled?: string, pushed?: boolean, conflicts?: string[] }>>}
 */
export async function syncAll(repoRoot) {
  const results = [];
  for (const { name } of listPeers(repoRoot)) {
    try {
      results.push({ name, ok: true, ...(await syncPeer(repoRoot, name)) });
    } catch (err) {
      results.push({ name, ok: false, error: err.cause?.code ? `${err.message} (${err.cause.code})` : err.message });
    }
  }
  return results;
}
