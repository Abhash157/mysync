import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { GDIF_DIR } from './repo.js';

/**
 * Gets path to object in .gdif/objects/
 * @param {string} repoRoot
 * @param {string} hash
 * @returns {string}
 */
export function getObjectPath(repoRoot, hash) {
  const dir = hash.slice(0, 2);
  const file = hash.slice(2);
  return path.join(repoRoot, GDIF_DIR, 'objects', dir, file);
}

/**
 * Computes SHA-1 hash of data buffer with Git-style header.
 * @param {string} type 'blob' | 'tree' | 'commit'
 * @param {Buffer} contentBuffer
 * @returns {{ hash: string, objectData: Buffer }}
 */
export function hashObject(type, contentBuffer) {
  const header = Buffer.from(`${type} ${contentBuffer.length}\0`);
  const objectData = Buffer.concat([header, contentBuffer]);
  const hash = crypto.createHash('sha1').update(objectData).digest('hex');
  return { hash, objectData };
}

/**
 * Hashes and writes an object to the object database with zlib compression.
 * @param {string} repoRoot
 * @param {string} type 'blob' | 'tree' | 'commit'
 * @param {Buffer|string} content
 * @returns {string} The SHA-1 hash of the written object
 */
export function writeObject(repoRoot, type, content) {
  const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const { hash, objectData } = hashObject(type, contentBuffer);
  const targetPath = getObjectPath(repoRoot, hash);

  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const compressed = zlib.deflateSync(objectData);
    fs.writeFileSync(targetPath, compressed);
  }

  return hash;
}

/**
 * Reads and decompresses an object from the database.
 * @param {string} repoRoot
 * @param {string} hash
 * @returns {{ type: string, size: number, content: Buffer }}
 */
export function readObject(repoRoot, hash) {
  const objectPath = getObjectPath(repoRoot, hash);
  if (!fs.existsSync(objectPath)) {
    throw new Error(`fatal: Not a valid object name ${hash}`);
  }

  const compressed = fs.readFileSync(objectPath);
  const decompressed = zlib.inflateSync(compressed);

  const nullIndex = decompressed.indexOf(0);
  if (nullIndex === -1) {
    throw new Error(`fatal: Corrupt object ${hash}`);
  }

  const headerStr = decompressed.subarray(0, nullIndex).toString('utf8');
  const [type, sizeStr] = headerStr.split(' ');
  const size = parseInt(sizeStr, 10);
  const content = decompressed.subarray(nullIndex + 1);

  return { type, size, content };
}

/**
 * Writes a blob object for file content.
 * @param {string} repoRoot
 * @param {Buffer|string} content
 * @returns {string} Blob hash
 */
export function writeBlob(repoRoot, content) {
  return writeObject(repoRoot, 'blob', content);
}

/**
 * Reads a blob object as Buffer.
 * @param {string} repoRoot
 * @param {string} hash
 * @returns {Buffer}
 */
export function readBlob(repoRoot, hash) {
  const { type, content } = readObject(repoRoot, hash);
  if (type !== 'blob') {
    throw new Error(`Object ${hash} is a ${type}, not a blob`);
  }
  return content;
}

/**
 * Serializes and writes a tree object.
 * Entries: array of { mode: string, type: 'blob'|'tree', hash: string, name: string }
 * @param {string} repoRoot
 * @param {Array<{ mode: string, type: string, hash: string, name: string }>} entries
 * @returns {string} Tree hash
 */
export function writeTree(repoRoot, entries) {
  // Canonical sort by name
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.map((entry) => `${entry.mode} ${entry.type} ${entry.hash}\t${entry.name}`);
  const content = Buffer.from(lines.join('\n'), 'utf8');
  return writeObject(repoRoot, 'tree', content);
}

/**
 * Reads and parses a tree object.
 * @param {string} repoRoot
 * @param {string} treeHash
 * @returns {Array<{ mode: string, type: string, hash: string, name: string }>}
 */
export function readTree(repoRoot, treeHash) {
  const { type, content } = readObject(repoRoot, treeHash);
  if (type !== 'tree') {
    throw new Error(`Object ${treeHash} is a ${type}, not a tree`);
  }

  const text = content.toString('utf8').trim();
  if (!text) return [];

  return text.split('\n').map((line) => {
    const tabIndex = line.indexOf('\t');
    const meta = line.slice(0, tabIndex).split(' ');
    const name = line.slice(tabIndex + 1);
    return {
      mode: meta[0],
      type: meta[1],
      hash: meta[2],
      name,
    };
  });
}

/**
 * Writes a commit object.
 * @param {string} repoRoot
 * @param {{
 *   treeHash: string,
 *   parentHash?: string|null,
 *   author: { name: string, email: string, timestamp?: number },
 *   message: string
 * }} options
 * @returns {string} Commit hash
 */
export function writeCommit(repoRoot, { treeHash, parentHash = null, author, message }) {
  const timestamp = author.timestamp || Math.floor(Date.now() / 1000);
  const authorLine = `author ${author.name} <${author.email}> ${timestamp}`;
  const committerLine = `committer ${author.name} <${author.email}> ${timestamp}`;

  const lines = [`tree ${treeHash}`];
  if (parentHash) {
    lines.push(`parent ${parentHash}`);
  }
  lines.push(authorLine);
  lines.push(committerLine);
  lines.push('');
  lines.push(message.trim());
  lines.push('');

  const content = Buffer.from(lines.join('\n'), 'utf8');
  return writeObject(repoRoot, 'commit', content);
}

/**
 * Reads and parses a commit object.
 * @param {string} repoRoot
 * @param {string} commitHash
 * @returns {{
 *   treeHash: string,
 *   parentHash: string|null,
 *   author: { name: string, email: string, timestamp: number },
 *   message: string
 * }}
 */
export function readCommit(repoRoot, commitHash) {
  const { type, content } = readObject(repoRoot, commitHash);
  if (type !== 'commit') {
    throw new Error(`Object ${commitHash} is a ${type}, not a commit`);
  }

  const text = content.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const headerPart = headerEnd !== -1 ? text.slice(0, headerEnd) : text;
  const messagePart = headerEnd !== -1 ? text.slice(headerEnd + 2) : '';

  let treeHash = null;
  let parentHash = null;
  let author = { name: 'Unknown', email: 'unknown@gdif', timestamp: 0 };

  for (const line of headerPart.split('\n')) {
    if (line.startsWith('tree ')) {
      treeHash = line.slice(5).trim();
    } else if (line.startsWith('parent ')) {
      parentHash = line.slice(7).trim();
    } else if (line.startsWith('author ')) {
      const match = line.slice(7).match(/^(.*) <(.*)> (\d+)$/);
      if (match) {
        author = {
          name: match[1],
          email: match[2],
          timestamp: parseInt(match[3], 10),
        };
      }
    }
  }

  return {
    treeHash,
    parentHash,
    author,
    message: messagePart.trim(),
  };
}
