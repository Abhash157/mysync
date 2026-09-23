import { readIndex } from './staging.js';
import { writeTree, readTree, writeCommit, readCommit } from './objects.js';
import { getHeadInfo, updateBranchRef, setHead, getConfig } from './repo.js';

/**
 * Builds a hierarchical tree object structure from flat index and returns the root tree hash.
 * @param {string} repoRoot
 * @param {Record<string, { hash: string, mode: string }>} index
 * @returns {string} Root tree hash
 */
export function buildTreeFromIndex(repoRoot, index) {
  // Construct intermediate directory tree node hierarchy
  const rootNode = { dirs: {}, files: {} };

  for (const [filePath, entry] of Object.entries(index)) {
    const parts = filePath.split('/');
    let current = rootNode;

    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      if (!current.dirs[dirName]) {
        current.dirs[dirName] = { dirs: {}, files: {} };
      }
      current = current.dirs[dirName];
    }

    const fileName = parts[parts.length - 1];
    current.files[fileName] = entry;
  }

  function writeNode(node) {
    const entries = [];

    // Process subdirectories first
    for (const [dirName, subNode] of Object.entries(node.dirs)) {
      const subTreeHash = writeNode(subNode);
      entries.push({
        mode: '040000',
        type: 'tree',
        hash: subTreeHash,
        name: dirName,
      });
    }

    // Process files
    for (const [fileName, fileEntry] of Object.entries(node.files)) {
      entries.push({
        mode: fileEntry.mode || '100644',
        type: 'blob',
        hash: fileEntry.hash,
        name: fileName,
      });
    }

    return writeTree(repoRoot, entries);
  }

  return writeNode(rootNode);
}

/**
 * Flattens a tree object into a map of relative POSIX file paths to blob hashes.
 * @param {string} repoRoot
 * @param {string|null} treeHash
 * @param {string} [prefix='']
 * @returns {Record<string, string>} Map of relPath -> blobHash
 */
export function flattenTree(repoRoot, treeHash, prefix = '') {
  if (!treeHash) return {};

  const result = {};
  const entries = readTree(repoRoot, treeHash);

  for (const entry of entries) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === 'blob') {
      result[entryPath] = entry.hash;
    } else if (entry.type === 'tree') {
      const subEntries = flattenTree(repoRoot, entry.hash, entryPath);
      Object.assign(result, subEntries);
    }
  }

  return result;
}

/**
 * Creates a new commit from the staging index.
 * @param {string} repoRoot
 * @param {string} message
 * @param {{ name?: string, email?: string }} [authorOverride]
 * @returns {{ commitHash: string, treeHash: string, branch: string|null, message: string }}
 */
export function createCommit(repoRoot, message, authorOverride = {}) {
  if (!message || !message.trim()) {
    throw new Error('fatal: Aborting commit due to empty commit message.');
  }

  const index = readIndex(repoRoot);
  const headInfo = getHeadInfo(repoRoot);
  const parentHash = headInfo.commitHash;

  const rootTreeHash = buildTreeFromIndex(repoRoot, index);

  // Check if changes exist compared to parent commit
  if (parentHash) {
    const parentCommit = readCommit(repoRoot, parentHash);
    if (parentCommit.treeHash === rootTreeHash) {
      throw new Error('nothing to commit, working tree clean');
    }
  } else if (Object.keys(index).length === 0) {
    throw new Error('nothing to commit, working tree clean');
  }

  const config = getConfig(repoRoot);
  const author = {
    name: authorOverride.name || config.user?.name || 'gdif-user',
    email: authorOverride.email || config.user?.email || 'user@gdif.local',
    timestamp: Math.floor(Date.now() / 1000),
  };

  const commitHash = writeCommit(repoRoot, {
    treeHash: rootTreeHash,
    parentHash,
    author,
    message,
  });

  if (headInfo.isBranch && headInfo.branch) {
    updateBranchRef(repoRoot, headInfo.branch, commitHash);
  } else {
    setHead(repoRoot, commitHash, false);
  }

  return {
    commitHash,
    treeHash: rootTreeHash,
    branch: headInfo.branch,
    message: message.trim(),
  };
}
