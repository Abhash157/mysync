import fs from 'node:fs';
import path from 'node:path';
import { MYSYNC_DIR } from './repo.js';
import { writeBlob } from './objects.js';
import { createIgnoreFilter, isPathIgnored, toPosix } from './ignore.js';

/**
 * Gets path to the index file.
 * @param {string} repoRoot
 * @returns {string}
 */
export function getIndexPath(repoRoot) {
  return path.join(repoRoot, MYSYNC_DIR, 'index');
}

/**
 * Reads the staging index.
 * @param {string} repoRoot
 * @returns {Record<string, { hash: string, size: number, mtime: number, mode: string }>}
 */
export function readIndex(repoRoot) {
  const indexPath = getIndexPath(repoRoot);
  if (!fs.existsSync(indexPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Writes the staging index.
 * @param {string} repoRoot
 * @param {Record<string, { hash: string, size: number, mtime: number, mode: string }>} index
 */
export function writeIndex(repoRoot, index) {
  const indexPath = getIndexPath(repoRoot);
  // Sort keys for deterministic output
  const sorted = Object.keys(index).sort().reduce((acc, key) => {
    acc[key] = index[key];
    return acc;
  }, {});
  fs.writeFileSync(indexPath, JSON.stringify(sorted, null, 2), 'utf8');
}

/**
 * Recursively scans directory returning list of relative POSIX paths.
 * @param {string} dir
 * @param {string} repoRoot
 * @param {import('ignore').Ignore} ig
 * @returns {string[]}
 */
export function listWorktreeFiles(dir, repoRoot, ig) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = toPosix(path.relative(repoRoot, fullPath));

    if (isPathIgnored(relPath, ig)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...listWorktreeFiles(fullPath, repoRoot, ig));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }

  return files;
}

/**
 * Stages a single file or directory.
 * @param {string} repoRoot
 * @param {string} targetInput
 * @returns {string[]} List of staged file paths
 */
export function stage(repoRoot, targetInput) {
  const ig = createIgnoreFilter(repoRoot);
  const index = readIndex(repoRoot);
  const stagedPaths = [];

  const absTarget = path.resolve(repoRoot, targetInput);
  const relTarget = toPosix(path.relative(repoRoot, absTarget));

  if (!fs.existsSync(absTarget)) {
    // Check if target was previously in index (file deletion stage)
    if (index[relTarget]) {
      delete index[relTarget];
      stagedPaths.push(relTarget);
      writeIndex(repoRoot, index);
      return stagedPaths;
    }
    throw new Error(`fatal: pathspec '${targetInput}' did not match any files`);
  }

  const stat = fs.statSync(absTarget);
  let filesToStage = [];

  if (stat.isDirectory()) {
    filesToStage = listWorktreeFiles(absTarget, repoRoot, ig);

    // Also check for tracked files in index that were deleted from this directory
    for (const trackedPath of Object.keys(index)) {
      if (relTarget === '' || trackedPath.startsWith(relTarget + '/')) {
        const fullTracked = path.join(repoRoot, trackedPath);
        if (!fs.existsSync(fullTracked)) {
          delete index[trackedPath];
          stagedPaths.push(trackedPath);
        }
      }
    }
  } else if (stat.isFile()) {
    if (isPathIgnored(relTarget, ig)) {
      return [];
    }
    filesToStage = [relTarget];
  }

  for (const relPath of filesToStage) {
    const fullPath = path.join(repoRoot, relPath);
    const content = fs.readFileSync(fullPath);
    const fileStat = fs.statSync(fullPath);
    const hash = writeBlob(repoRoot, content);

    index[relPath] = {
      hash,
      size: fileStat.size,
      mtime: Math.floor(fileStat.mtimeMs),
      mode: '100644',
    };
    stagedPaths.push(relPath);
  }

  writeIndex(repoRoot, index);
  return stagedPaths;
}

/**
 * Unstages a path from index.
 * @param {string} repoRoot
 * @param {string} targetInput
 * @param {Record<string, string>|null} headFiles Map of relPath -> blobHash in HEAD
 */
export function unstage(repoRoot, targetInput, headFiles = null) {
  const index = readIndex(repoRoot);
  const absTarget = path.resolve(repoRoot, targetInput);
  const relTarget = toPosix(path.relative(repoRoot, absTarget));

  let matched = false;

  for (const filePath of Object.keys(index)) {
    if (filePath === relTarget || relTarget === '' || filePath.startsWith(relTarget + '/')) {
      matched = true;
      if (headFiles && headFiles[filePath]) {
        // Reset to HEAD state
        index[filePath].hash = headFiles[filePath];
      } else {
        delete index[filePath];
      }
    }
  }

  if (matched) {
    writeIndex(repoRoot, index);
  }
}
