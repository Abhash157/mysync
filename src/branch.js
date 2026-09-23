import fs from 'node:fs';
import path from 'node:path';
import { MYSYNC_DIR, getHeadInfo, setHead, updateBranchRef } from './repo.js';
import { readCommit, readBlob } from './objects.js';
import { flattenTree } from './commit.js';
import { readIndex, writeIndex } from './staging.js';
import { getStatus } from './status.js';

/**
 * Lists all local branches.
 * @param {string} repoRoot
 * @returns {Array<{ name: string, isCurrent: boolean, commitHash: string }>}
 */
export function listBranches(repoRoot) {
  const headsDir = path.join(repoRoot, MYSYNC_DIR, 'refs', 'heads');
  if (!fs.existsSync(headsDir)) {
    return [];
  }

  const headInfo = getHeadInfo(repoRoot);
  const files = fs.readdirSync(headsDir);

  return files.map((fileName) => {
    const commitHash = fs.readFileSync(path.join(headsDir, fileName), 'utf8').trim();
    return {
      name: fileName,
      isCurrent: headInfo.isBranch && headInfo.branch === fileName,
      commitHash,
    };
  });
}

/**
 * Creates a new branch pointing to HEAD commit.
 * @param {string} repoRoot
 * @param {string} branchName
 */
export function createBranch(repoRoot, branchName) {
  if (!branchName || !/^[a-zA-Z0-9._-]+$/.test(branchName)) {
    throw new Error(`fatal: '${branchName}' is not a valid branch name.`);
  }

  const headsDir = path.join(repoRoot, MYSYNC_DIR, 'refs', 'heads');
  const targetBranchFile = path.join(headsDir, branchName);

  if (fs.existsSync(targetBranchFile)) {
    throw new Error(`fatal: A branch named '${branchName}' already exists.`);
  }

  const headInfo = getHeadInfo(repoRoot);
  if (!headInfo.commitHash) {
    throw new Error('fatal: Not a valid object name: \'HEAD\'. Cannot create branch without commits.');
  }

  updateBranchRef(repoRoot, branchName, headInfo.commitHash);
}

/**
 * Deletes a branch.
 * @param {string} repoRoot
 * @param {string} branchName
 */
export function deleteBranch(repoRoot, branchName) {
  const headInfo = getHeadInfo(repoRoot);
  if (headInfo.isBranch && headInfo.branch === branchName) {
    throw new Error(`fatal: Cannot delete branch '${branchName}' checked out at '${repoRoot}'`);
  }

  const branchPath = path.join(repoRoot, MYSYNC_DIR, 'refs', 'heads', branchName);
  if (!fs.existsSync(branchPath)) {
    throw new Error(`error: branch '${branchName}' not found.`);
  }

  fs.unlinkSync(branchPath);
}

/**
 * Checks out a branch or a commit.
 * @param {string} repoRoot
 * @param {string} target branch name or commit hash
 * @param {object} [options]
 * @param {boolean} [options.create=false] Create and switch to new branch
 */
export function checkout(repoRoot, target, { create = false } = {}) {
  const branchPath = path.join(repoRoot, MYSYNC_DIR, 'refs', 'heads', target);
  let targetCommitHash = null;
  let isTargetBranch = false;

  if (create) {
    createBranch(repoRoot, target);
    isTargetBranch = true;
    targetCommitHash = fs.readFileSync(branchPath, 'utf8').trim();
  } else if (fs.existsSync(branchPath)) {
    isTargetBranch = true;
    targetCommitHash = fs.readFileSync(branchPath, 'utf8').trim();
  } else {
    // Try resolving as commit hash
    try {
      const commit = readCommit(repoRoot, target);
      targetCommitHash = target;
    } catch {
      throw new Error(`error: pathspec '${target}' did not match any file(s) known to mysync`);
    }
  }

  // Get current tracked files from index
  const currentIndex = readIndex(repoRoot);

  // Read target tree files
  const targetCommit = readCommit(repoRoot, targetCommitHash);
  const targetFiles = flattenTree(repoRoot, targetCommit.treeHash);

  // Clean working tree files that exist in current index but NOT in target commit
  for (const filePath of Object.keys(currentIndex)) {
    if (!targetFiles[filePath]) {
      const fullPath = path.join(repoRoot, filePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
  }

  // Write all target files to working directory
  const newIndex = {};
  for (const [filePath, blobHash] of Object.entries(targetFiles)) {
    const fullPath = path.join(repoRoot, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const content = readBlob(repoRoot, blobHash);
    fs.writeFileSync(fullPath, content);

    const stat = fs.statSync(fullPath);
    newIndex[filePath] = {
      hash: blobHash,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs),
      mode: '100644',
    };
  }

  // Update index
  writeIndex(repoRoot, newIndex);

  // Update HEAD
  setHead(repoRoot, target, isTargetBranch);

  return {
    isBranch: isTargetBranch,
    target,
    commitHash: targetCommitHash,
  };
}

/**
 * Restores working tree files or index.
 * @param {string} repoRoot
 * @param {string[]} filePaths
 * @param {object} [options]
 * @param {boolean} [options.staged=false]
 */
export function restore(repoRoot, filePaths, { staged = false } = {}) {
  const index = readIndex(repoRoot);
  const headInfo = getHeadInfo(repoRoot);

  let headFiles = {};
  if (headInfo.commitHash) {
    const headCommit = readCommit(repoRoot, headInfo.commitHash);
    headFiles = flattenTree(repoRoot, headCommit.treeHash);
  }

  for (const targetPath of filePaths) {
    const relTarget = path.relative(repoRoot, path.resolve(repoRoot, targetPath)).split(path.sep).join('/');

    if (staged) {
      // Unstage: restore index entry from HEAD
      if (headFiles[relTarget]) {
        index[relTarget] = {
          ...index[relTarget],
          hash: headFiles[relTarget],
        };
      } else {
        delete index[relTarget];
      }
      writeIndex(repoRoot, index);
    } else {
      // Discard working tree changes: restore from index
      if (!index[relTarget]) {
        throw new Error(`error: pathspec '${targetPath}' did not match any file(s) known to mysync`);
      }
      const fullPath = path.join(repoRoot, relTarget);
      const content = readBlob(repoRoot, index[relTarget].hash);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
  }
}
