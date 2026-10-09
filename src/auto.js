import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GDIF_DIR, getHeadInfo, updateBranchRef, getConfig } from './repo.js';
import { readCommit, writeCommit, writeBlob, readBlob, hashObject, getObjectPath } from './objects.js';
import { readIndex, writeIndex, listWorktreeFiles } from './staging.js';
import { createIgnoreFilter } from './ignore.js';
import { buildTreeFromIndex, flattenTree } from './commit.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Locking: one operation at a time per repo, across async tasks and processes.
// ---------------------------------------------------------------------------

const queues = new Map();

async function acquireFileLock(repoRoot) {
  const lockPath = path.join(repoRoot, GDIF_DIR, 'lock');
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 60_000) fs.unlinkSync(lockPath);
      } catch { /* raced with another process */ }
      await sleep(50);
    }
  }
  throw new Error('fatal: could not acquire .mysync/lock (another mysync process is busy)');
}

/**
 * Runs fn while holding the repository lock.
 * @template T
 * @param {string} repoRoot
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withLock(repoRoot, fn) {
  const prev = queues.get(repoRoot) || Promise.resolve();
  const run = prev.then(async () => {
    const release = await acquireFileLock(repoRoot);
    try {
      return await fn();
    } finally {
      release();
    }
  });
  queues.set(repoRoot, run.catch(() => {}));
  return run;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getDeviceName(repoRoot) {
  return getConfig(repoRoot).device || os.hostname() || 'device';
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** True when every segment is a legal Windows file name (other systems allow more). */
export function isValidWindowsPath(rel) {
  return rel
    .split('/')
    .every((part) => !/[<>:"|?*\u0000-\u001f]/.test(part) && !/[ .]$/.test(part) && !WINDOWS_RESERVED.test(part));
}

/** Rejects paths that could escape the repo, touch mysync/git internals, or cannot exist on this OS. */
export function isSafeRelPath(rel) {
  if (!rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    return false;
  }
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  const first = parts[0].toLowerCase();
  if (first === GDIF_DIR || first === '.git') return false;
  return process.platform !== 'win32' || isValidWindowsPath(rel);
}

function commitFiles(repoRoot, commitHash) {
  if (!commitHash) return {};
  return flattenTree(repoRoot, readCommit(repoRoot, commitHash).treeHash);
}

function pruneEmptyDirs(repoRoot, fullPath) {
  let dir = path.dirname(fullPath);
  const root = path.resolve(repoRoot);
  while (dir.startsWith(root + path.sep)) {
    try {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** Name used to keep the losing side of a conflict, deterministic so every device agrees. */
export function conflictPath(rel, blobHash) {
  const ext = path.posix.extname(rel);
  const stem = ext ? rel.slice(0, -ext.length) : rel;
  return `${stem}.conflict-${blobHash.slice(0, 7)}${ext}`;
}

// ---------------------------------------------------------------------------
// History queries
// ---------------------------------------------------------------------------

/** Map of every commit reachable from `start` (inclusive) to its parents. */
function ancestorsOf(repoRoot, start) {
  const seen = new Map();
  const queue = [start];
  while (queue.length > 0) {
    const hash = queue.pop();
    if (!hash || seen.has(hash)) continue;
    const { parentHashes } = readCommit(repoRoot, hash);
    seen.set(hash, parentHashes);
    queue.push(...parentHashes);
  }
  return seen;
}

/** True when `maybeAncestor` is `descendant` or reachable from it. */
export function isAncestor(repoRoot, maybeAncestor, descendant) {
  if (maybeAncestor === descendant) return true;
  return ancestorsOf(repoRoot, descendant).has(maybeAncestor);
}

/** Best common ancestor of two commits, chosen deterministically; null if unrelated. */
function findMergeBase(repoRoot, a, b) {
  const ancA = ancestorsOf(repoRoot, a);
  const ancB = ancestorsOf(repoRoot, b);
  const common = [...ancA.keys()].filter((hash) => ancB.has(hash));
  if (common.length === 0) return null;

  // Anything that is an ancestor of another common commit is not a "best" base.
  const dominated = new Set();
  const stack = common.flatMap((hash) => ancA.get(hash));
  while (stack.length > 0) {
    const hash = stack.pop();
    if (dominated.has(hash)) continue;
    dominated.add(hash);
    stack.push(...(ancA.get(hash) || []));
  }

  const best = common.filter((hash) => !dominated.has(hash));
  best.sort((x, y) => {
    const tx = readCommit(repoRoot, x).author.timestamp;
    const ty = readCommit(repoRoot, y).author.timestamp;
    return ty - tx || (x < y ? -1 : 1);
  });
  return best[0];
}

// ---------------------------------------------------------------------------
// Snapshot: working tree -> commit, no staging required
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILE_MB = 100;
const skippedByRepo = new Map();

/** Files the last scan left out because they exceed the size limit. */
export function getSkippedFiles(repoRoot) {
  return skippedByRepo.get(repoRoot) || [];
}

const isGone = (err) => err.code === 'ENOENT' || err.code === 'ENOTDIR';

const deferredByRepo = new Map();

/** How many files the last scan postponed because they were still being written. */
export function getDeferredCount(repoRoot) {
  return deferredByRepo.get(repoRoot) || 0;
}

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {string} repoRoot
 * @param {{ quietMs?: number }} [options] Files modified within this window are left for the next scan.
 */
async function snapshotNow(repoRoot, { quietMs = 0 } = {}) {
  const head = getHeadInfo(repoRoot);
  if (!head.isBranch) {
    throw new Error('fatal: auto-sync needs a branch checked out (HEAD is detached)');
  }
  if (!fs.existsSync(repoRoot)) {
    throw new Error(`fatal: folder not found: ${repoRoot}`);
  }

  const ig = createIgnoreFilter(repoRoot);
  const previous = readIndex(repoRoot);
  const headFiles = commitFiles(repoRoot, head.commitHash);
  const maxBytes = (getConfig(repoRoot).maxFileMB || DEFAULT_MAX_FILE_MB) * 1024 * 1024;
  const index = {};
  const skipped = [];
  const blockedDirs = [];
  let deferred = 0;
  let lastYield = Date.now();

  // A file we cannot read right now (open in another program, no permission, too large)
  // keeps its last synced version. It must never look like a deletion.
  const keepLastSynced = (rel, size = 0) => {
    if (headFiles[rel]) index[rel] = { hash: headFiles[rel], size, mtime: 0, mode: '100644' };
  };

  for (const rel of listWorktreeFiles(repoRoot, repoRoot, ig, (dir) => blockedDirs.push(dir))) {
    // Keep long scans from starving the HTTP server and UI messages in the same process.
    if (Date.now() - lastYield > 30) {
      await yieldToEventLoop();
      lastYield = Date.now();
    }
    if (!isSafeRelPath(rel)) continue;
    const full = path.join(repoRoot, rel);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (err) {
      if (!isGone(err)) keepLastSynced(rel);
      continue; // vanished while scanning
    }
    if (stat.size > maxBytes) {
      skipped.push({ path: rel, size: stat.size });
      keepLastSynced(rel, stat.size);
      continue;
    }
    const mtime = Math.floor(stat.mtimeMs);
    const cached = previous[rel];
    if (cached && cached.size === stat.size && cached.mtime === mtime) {
      index[rel] = cached;
      continue;
    }
    if (quietMs > 0 && Date.now() - stat.mtimeMs < quietMs) {
      deferred++; // still being written; pick it up on the next scan
      keepLastSynced(rel, stat.size);
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(full);
    } catch (err) {
      if (!isGone(err)) keepLastSynced(rel, stat.size);
      continue;
    }
    index[rel] = { hash: writeBlob(repoRoot, content), size: content.length, mtime, mode: '100644' };
  }

  // Folders we could not list, and names that cannot exist on this system, stay exactly as they were.
  for (const rel of Object.keys(headFiles)) {
    if (index[rel]) continue;
    if (!isSafeRelPath(rel) || blockedDirs.some((dir) => rel.startsWith(`${dir}/`))) keepLastSynced(rel);
  }
  skippedByRepo.set(repoRoot, skipped);
  deferredByRepo.set(repoRoot, deferred);

  const changed = new Set();
  for (const [rel, entry] of Object.entries(index)) {
    if (headFiles[rel] !== entry.hash) changed.add(rel);
  }
  for (const rel of Object.keys(headFiles)) {
    if (!index[rel]) changed.add(rel);
  }

  if (changed.size === 0) {
    writeIndex(repoRoot, index);
    return null;
  }

  const treeHash = buildTreeFromIndex(repoRoot, index);
  const device = getDeviceName(repoRoot);
  const config = getConfig(repoRoot);
  const names = [...changed].sort();
  const preview = names.slice(0, 3).join(', ') + (names.length > 3 ? ', ...' : '');
  const commitHash = writeCommit(repoRoot, {
    treeHash,
    parentHashes: head.commitHash ? [head.commitHash] : [],
    author: {
      name: device,
      email: config.user?.email || 'user@mysync.local',
      timestamp: Math.floor(Date.now() / 1000),
    },
    message: `sync: ${changed.size} file${changed.size === 1 ? '' : 's'} changed on ${device} (${preview})`,
  });

  updateBranchRef(repoRoot, head.branch, commitHash);
  writeIndex(repoRoot, index);
  return commitHash;
}

/**
 * Commits whatever changed in the working tree since HEAD. No add/commit needed.
 * @param {string} repoRoot
 * @param {{ quietMs?: number }} [options]
 * @returns {Promise<string|null>} New commit hash, or null if nothing changed.
 */
export function snapshot(repoRoot, options = {}) {
  return withLock(repoRoot, () => snapshotNow(repoRoot, options));
}

// ---------------------------------------------------------------------------
// Moving the working tree to another commit
// ---------------------------------------------------------------------------

/** Assumes the working tree matches HEAD (call snapshotNow first). */
function moveHeadTo(repoRoot, newHash, mergedFiles = null) {
  const head = getHeadInfo(repoRoot);
  const from = commitFiles(repoRoot, head.commitHash);
  const to = mergedFiles || commitFiles(repoRoot, newHash);

  for (const blob of new Set(Object.values(to))) {
    if (!fs.existsSync(getObjectPath(repoRoot, blob))) {
      throw new Error(`fatal: missing object ${blob}; fetch from the peer again`);
    }
  }

  // Fail before touching anything if a file we must change is open elsewhere (e.g. in Word).
  assertUnlocked(
    repoRoot,
    Object.keys(from).filter((rel) => isSafeRelPath(rel) && from[rel] !== to[rel]),
  );

  const index = {};

  // Deletions first so a file can turn into a directory (and back).
  for (const rel of Object.keys(from)) {
    if (to[rel] || !isSafeRelPath(rel)) continue;
    const full = path.join(repoRoot, rel);
    if (!fs.existsSync(full)) continue;
    preserveIfEdited(repoRoot, rel, from[rel]);
    fs.rmSync(full, { force: true });
    pruneEmptyDirs(repoRoot, full);
  }

  for (const [rel, blobHash] of Object.entries(to)) {
    if (!isSafeRelPath(rel)) {
      console.warn(`warning: ignoring unsafe path from peer: ${rel}`);
      continue;
    }
    const full = path.join(repoRoot, rel);
    if (from[rel] !== blobHash || !fs.existsSync(full)) {
      if (fs.existsSync(full)) preserveIfEdited(repoRoot, rel, from[rel]);
      writeFileAtomic(full, readBlob(repoRoot, blobHash));
    }
    const stat = fs.statSync(full);
    index[rel] = { hash: blobHash, size: stat.size, mtime: Math.floor(stat.mtimeMs), mode: '100644' };
  }

  updateBranchRef(repoRoot, head.branch, newHash);
  writeIndex(repoRoot, index);
}

/** Writes via a temp file so a crash never leaves a half-written file that would later sync as an edit. */
function writeFileAtomic(full, content) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.mysync-tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, full);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Throws an error with code 'ELOCKED' if any of these files cannot be modified right now.
 * Callers treat it as "try again later", not as a failure.
 */
function assertUnlocked(repoRoot, rels) {
  for (const rel of rels) {
    let fd;
    try {
      fd = fs.openSync(path.join(repoRoot, rel), 'r+');
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') continue;
      const locked = new Error(`file is open in another program or read-only: ${rel}`);
      locked.code = 'ELOCKED';
      locked.file = rel;
      throw locked;
    }
    fs.closeSync(fd);
  }
}

/** If the user edited a file in the instant before we overwrite it, keep their version beside it. */
function preserveIfEdited(repoRoot, rel, expectedHash) {
  const full = path.join(repoRoot, rel);
  let content;
  try {
    content = fs.readFileSync(full);
  } catch {
    return;
  }
  if (expectedHash && hashObject('blob', content).hash === expectedHash) return;
  const hash = writeBlob(repoRoot, content);
  const keep = path.join(repoRoot, conflictPath(rel, hash));
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.writeFileSync(keep, content);
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Three-way merge at file granularity. Never discards data: when both sides
 * changed a file, the newer commit keeps the path and the other version is
 * saved as `<name>.conflict-<hash><ext>`. The result is symmetric, so two
 * devices merging each other's heads produce the same tree.
 */
export function mergeFileMaps(base, ours, theirs, oursWins) {
  const files = {};
  const conflicts = [];

  for (const rel of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const b = base[rel];
    const o = ours[rel];
    const t = theirs[rel];
    let result;

    if (o === t) result = o;
    else if (o === b) result = t;
    else if (t === b) result = o;
    else if (o === undefined) result = t; // deleted here, edited there: keep the edit
    else if (t === undefined) result = o;
    else {
      const winner = oursWins ? o : t;
      const loser = oursWins ? t : o;
      result = winner;
      files[conflictPath(rel, loser)] = loser;
      conflicts.push(rel);
    }

    if (result !== undefined) files[rel] = result;
  }

  // A path that is a file on one side and a directory on the other cannot coexist.
  const dirs = new Set();
  for (const rel of Object.keys(files)) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const rel of Object.keys(files)) {
    if (dirs.has(rel)) {
      files[conflictPath(rel, files[rel])] = files[rel];
      delete files[rel];
      conflicts.push(rel);
    }
  }

  return { files, conflicts };
}

function filesToIndex(files) {
  const index = {};
  for (const [rel, hash] of Object.entries(files)) {
    index[rel] = { hash, mode: '100644' };
  }
  return index;
}

/**
 * Brings `theirHash` into the current branch: fast-forward when possible,
 * otherwise a deterministic merge commit. All objects must already be local.
 * @returns {Promise<{ action: 'up-to-date'|'fast-forward'|'merged', conflicts: string[], commitHash: string }>}
 */
export function integrate(repoRoot, theirHash) {
  return withLock(repoRoot, async () => {
    await snapshotNow(repoRoot);
    const head = getHeadInfo(repoRoot);
    const ours = head.commitHash;

    if (ours === theirHash || (ours && isAncestor(repoRoot, theirHash, ours))) {
      return { action: 'up-to-date', conflicts: [], commitHash: ours };
    }

    if (!ours || isAncestor(repoRoot, ours, theirHash)) {
      moveHeadTo(repoRoot, theirHash);
      return { action: 'fast-forward', conflicts: [], commitHash: theirHash };
    }

    const baseHash = findMergeBase(repoRoot, ours, theirHash);
    const ourCommit = readCommit(repoRoot, ours);
    const theirCommit = readCommit(repoRoot, theirHash);
    const oursWins =
      ourCommit.author.timestamp !== theirCommit.author.timestamp
        ? ourCommit.author.timestamp > theirCommit.author.timestamp
        : ours > theirHash;

    const { files, conflicts } = mergeFileMaps(
      commitFiles(repoRoot, baseHash),
      commitFiles(repoRoot, ours),
      commitFiles(repoRoot, theirHash),
      oursWins,
    );

    const parents = [ours, theirHash].sort();
    const mergeHash = writeCommit(repoRoot, {
      treeHash: buildTreeFromIndex(repoRoot, filesToIndex(files)),
      parentHashes: parents,
      author: {
        name: 'mysync',
        email: 'merge@mysync.local',
        timestamp: Math.max(ourCommit.author.timestamp, theirCommit.author.timestamp),
      },
      message: `merge ${parents[0].slice(0, 7)} and ${parents[1].slice(0, 7)}`,
    });

    moveHeadTo(repoRoot, mergeHash, files);
    return { action: 'merged', conflicts, commitHash: mergeHash };
  });
}

/**
 * Server side of a push: accept `hash` as the new head of `branch` only if it
 * fast-forwards this device, then update the working tree to match.
 * @returns {Promise<'ok'|'diverged'>}
 */
export function receive(repoRoot, branch, hash) {
  return withLock(repoRoot, async () => {
    const head = getHeadInfo(repoRoot);
    if (!head.isBranch || head.branch !== branch) {
      updateBranchRef(repoRoot, branch, hash);
      return 'ok';
    }

    await snapshotNow(repoRoot);
    const ours = getHeadInfo(repoRoot).commitHash;
    if (ours === hash || (ours && isAncestor(repoRoot, hash, ours))) return 'ok';
    if (!ours || isAncestor(repoRoot, ours, hash)) {
      moveHeadTo(repoRoot, hash);
      return 'ok';
    }
    return 'diverged';
  });
}

/**
 * Hub side of a push: a hub has no working tree, so it only moves the ref
 * when the new commit descends from the current one.
 * @returns {Promise<'ok'|'diverged'>}
 */
export function receiveBare(repoRoot, branch, hash) {
  return withLock(repoRoot, () => {
    const refPath = path.join(repoRoot, GDIF_DIR, 'refs', 'heads', branch);
    const current = fs.existsSync(refPath) ? fs.readFileSync(refPath, 'utf8').trim() : null;
    if (current && (current === hash || isAncestor(repoRoot, hash, current))) return 'ok';
    if (current && !isAncestor(repoRoot, current, hash)) return 'diverged';
    updateBranchRef(repoRoot, branch, hash);
    return 'ok';
  });
}
