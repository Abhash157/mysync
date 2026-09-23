import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';

const DEFAULT_IGNORES = [
  '.gdif',
  '.gdif/**',
  '.git',
  '.git/**',
  'node_modules',
  'node_modules/**',
];

/**
 * Creates an ignore filter configured with default patterns and .gdifignore (if present).
 * @param {string} repoRoot
 * @returns {import('ignore').Ignore}
 */
export function createIgnoreFilter(repoRoot) {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES);

  const ignoreFilePath = path.join(repoRoot, '.gdifignore');
  if (fs.existsSync(ignoreFilePath)) {
    const content = fs.readFileSync(ignoreFilePath, 'utf8');
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    ig.add(lines);
  }

  return ig;
}

/**
 * Normalizes relative path to POSIX format (forward slashes).
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Checks if a relative path should be ignored.
 * @param {string} relPath
 * @param {import('ignore').Ignore} ig
 * @returns {boolean}
 */
export function isPathIgnored(relPath, ig) {
  const posixPath = toPosix(relPath);
  if (!posixPath || posixPath === '.') return false;
  return ig.ignores(posixPath);
}
