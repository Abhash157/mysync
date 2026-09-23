import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getHeadInfo } from './repo.js';
import { readIndex, listWorktreeFiles } from './staging.js';
import { readCommit } from './objects.js';
import { flattenTree } from './commit.js';
import { createIgnoreFilter, toPosix } from './ignore.js';

/**
 * Computes hash of raw file content with Git-style blob header.
 * @param {Buffer} buffer
 * @returns {string}
 */
function hashBlobContent(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return crypto.createHash('sha1').update(Buffer.concat([header, buffer])).digest('hex');
}

/**
 * Gathers complete status of repo comparing HEAD, Index, and Working Tree.
 * @param {string} repoRoot
 * @returns {{
 *   branch: string|null,
 *   isBranch: boolean,
 *   hasCommits: boolean,
 *   staged: { added: string[], modified: string[], deleted: string[] },
 *   unstaged: { modified: string[], deleted: string[] },
 *   untracked: string[]
 * }}
 */
export function getStatus(repoRoot) {
  const headInfo = getHeadInfo(repoRoot);
  const index = readIndex(repoRoot);
  const ig = createIgnoreFilter(repoRoot);

  let headFiles = {};
  if (headInfo.commitHash) {
    const headCommit = readCommit(repoRoot, headInfo.commitHash);
    headFiles = flattenTree(repoRoot, headCommit.treeHash);
  }

  // 1. Changes to be committed (Index vs HEAD)
  const staged = { added: [], modified: [], deleted: [] };
  for (const [filePath, entry] of Object.entries(index)) {
    if (!headFiles[filePath]) {
      staged.added.push(filePath);
    } else if (headFiles[filePath] !== entry.hash) {
      staged.modified.push(filePath);
    }
  }
  for (const headPath of Object.keys(headFiles)) {
    if (!index[headPath]) {
      staged.deleted.push(headPath);
    }
  }

  // 2. Changes not staged for commit (Working directory vs Index)
  const unstaged = { modified: [], deleted: [] };
  for (const [filePath, entry] of Object.entries(index)) {
    const fullPath = path.join(repoRoot, filePath);
    if (!fs.existsSync(fullPath)) {
      unstaged.deleted.push(filePath);
    } else {
      const content = fs.readFileSync(fullPath);
      const currentHash = hashBlobContent(content);
      if (currentHash !== entry.hash) {
        unstaged.modified.push(filePath);
      }
    }
  }

  // 3. Untracked files (Working directory files not in index)
  const allWorktreeFiles = listWorktreeFiles(repoRoot, repoRoot, ig);
  const untracked = allWorktreeFiles.filter((filePath) => !index[filePath] && !headFiles[filePath]);

  return {
    branch: headInfo.branch,
    isBranch: headInfo.isBranch,
    hasCommits: !!headInfo.commitHash,
    staged,
    unstaged,
    untracked,
  };
}

/**
 * Formats status object into human-readable string.
 * @param {ReturnType<typeof getStatus>} status
 * @returns {string}
 */
export function formatStatus(status) {
  const lines = [];

  if (status.isBranch) {
    lines.push(`On branch ${status.branch}`);
  } else {
    lines.push(`HEAD detached`);
  }

  if (!status.hasCommits) {
    lines.push('');
    lines.push('No commits yet');
  }

  const hasStaged =
    status.staged.added.length > 0 ||
    status.staged.modified.length > 0 ||
    status.staged.deleted.length > 0;

  if (hasStaged) {
    lines.push('');
    lines.push('Changes to be committed:');
    lines.push('  (use "mysync restore --staged <file>..." to unstage)');
    status.staged.added.forEach((f) => lines.push(`\t\x1b[32mnew file:   ${f}\x1b[0m`));
    status.staged.modified.forEach((f) => lines.push(`\t\x1b[32mmodified:   ${f}\x1b[0m`));
    status.staged.deleted.forEach((f) => lines.push(`\t\x1b[32mdeleted:    ${f}\x1b[0m`));
  }

  const hasUnstaged =
    status.unstaged.modified.length > 0 ||
    status.unstaged.deleted.length > 0;

  if (hasUnstaged) {
    lines.push('');
    lines.push('Changes not staged for commit:');
    lines.push('  (use "mysync add <file>..." to update what will be committed)');
    lines.push('  (use "mysync restore <file>..." to discard changes in working directory)');
    status.unstaged.modified.forEach((f) => lines.push(`\t\x1b[31mmodified:   ${f}\x1b[0m`));
    status.unstaged.deleted.forEach((f) => lines.push(`\t\x1b[31mdeleted:    ${f}\x1b[0m`));
  }

  if (status.untracked.length > 0) {
    lines.push('');
    lines.push('Untracked files:');
    lines.push('  (use "mysync add <file>..." to include in what will be committed)');
    status.untracked.forEach((f) => lines.push(`\t\x1b[31m${f}\x1b[0m`));
  }

  if (!hasStaged && !hasUnstaged && status.untracked.length === 0) {
    if (status.hasCommits) {
      lines.push('nothing to commit, working tree clean');
    } else {
      lines.push('');
      lines.push('nothing to commit (create/copy files and use "mysync add" to track)');
    }
  }

  return lines.join('\n');
}
