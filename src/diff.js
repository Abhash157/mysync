import fs from 'node:fs';
import path from 'node:path';
import { readIndex } from './staging.js';
import { readBlob, readCommit } from './objects.js';
import { flattenTree } from './commit.js';
import { getHeadInfo } from './repo.js';

/**
 * Computes the Longest Common Subsequence of two arrays of strings.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{ type: 'common'|'add'|'del', line: string }>}
 */
function computeDiffLines(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (a[i] === b[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Backtrack
  let i = m;
  let j = n;
  const result = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'common', line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', line: b[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      result.unshift({ type: 'del', line: a[i - 1] });
      i--;
    }
  }

  return result;
}

/**
 * Creates unified diff format string between oldContent and newContent.
 * @param {string} filePath
 * @param {string} oldContent
 * @param {string} newContent
 * @param {object} [options]
 * @param {number} [options.context=3]
 * @returns {string} Unified diff string, or empty string if identical
 */
export function createUnifiedDiff(filePath, oldContent, newContent, { context = 3 } = {}) {
  if (oldContent === newContent) {
    return '';
  }

  const oldLines = oldContent ? oldContent.split(/\r?\n/) : [];
  const newLines = newContent ? newContent.split(/\r?\n/) : [];

  const diffLines = computeDiffLines(oldLines, newLines);

  // Identify changed line indices
  const changes = [];
  diffLines.forEach((item, index) => {
    if (item.type !== 'common') {
      changes.push(index);
    }
  });

  if (changes.length === 0) {
    return '';
  }

  // Group into hunks with context
  const hunks = [];
  let currentHunk = null;

  for (let idx = 0; idx < diffLines.length; idx++) {
    const isNearChange = changes.some((c) => Math.abs(c - idx) <= context);
    if (isNearChange) {
      if (!currentHunk) {
        currentHunk = [];
      }
      currentHunk.push({ ...diffLines[idx], idx });
    } else if (currentHunk) {
      hunks.push(currentHunk);
      currentHunk = null;
    }
  }
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  const output = [
    `\x1b[1mdiff --gdif a/${filePath} b/${filePath}\x1b[0m`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  for (const hunk of hunks) {
    const delCount = hunk.filter((h) => h.type !== 'add').length;
    const addCount = hunk.filter((h) => h.type !== 'del').length;

    output.push(`\x1b[36m@@ -1,${delCount} +1,${addCount} @@\x1b[0m`);

    for (const item of hunk) {
      if (item.type === 'common') {
        output.push(` ${item.line}`);
      } else if (item.type === 'del') {
        output.push(`\x1b[31m-${item.line}\x1b[0m`);
      } else if (item.type === 'add') {
        output.push(`\x1b[32m+${item.line}\x1b[0m`);
      }
    }
  }

  return output.join('\n');
}

/**
 * Computes repository diffs.
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {boolean} [options.staged=false] Diff staged vs HEAD
 * @param {string} [options.filePath] Specific file filter
 * @returns {string} Combined diff output
 */
export function getRepoDiff(repoRoot, { staged = false, filePath = null } = {}) {
  const index = readIndex(repoRoot);
  const headInfo = getHeadInfo(repoRoot);

  let headFiles = {};
  if (headInfo.commitHash) {
    const headCommit = readCommit(repoRoot, headInfo.commitHash);
    headFiles = flattenTree(repoRoot, headCommit.treeHash);
  }

  const diffOutputs = [];

  if (staged) {
    // Compare Index vs HEAD
    const allFiles = new Set([...Object.keys(index), ...Object.keys(headFiles)]);
    for (const file of Array.from(allFiles).sort()) {
      if (filePath && file !== filePath) continue;

      const oldHash = headFiles[file];
      const newEntry = index[file];

      if (oldHash !== (newEntry ? newEntry.hash : undefined)) {
        const oldContent = oldHash ? readBlob(repoRoot, oldHash).toString('utf8') : '';
        const newContent = newEntry ? readBlob(repoRoot, newEntry.hash).toString('utf8') : '';
        const diff = createUnifiedDiff(file, oldContent, newContent);
        if (diff) diffOutputs.push(diff);
      }
    }
  } else {
    // Compare Working Tree vs Index
    for (const [file, entry] of Object.entries(index)) {
      if (filePath && file !== filePath) continue;

      const fullPath = path.join(repoRoot, file);
      const oldContent = readBlob(repoRoot, entry.hash).toString('utf8');
      let newContent = '';

      if (fs.existsSync(fullPath)) {
        newContent = fs.readFileSync(fullPath, 'utf8');
      }

      const diff = createUnifiedDiff(file, oldContent, newContent);
      if (diff) diffOutputs.push(diff);
    }
  }

  return diffOutputs.join('\n\n');
}
