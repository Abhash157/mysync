import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { listBranches } from './branch.js';
import { getOrCreateToken, getOrCreateFolderId, getOrCreateDeviceId } from './repo.js';
import { getObjectPath, hashObject } from './objects.js';
import { receive, getDeviceName } from './auto.js';
import { makeProof } from './client.js';

const HASH_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[a-zA-Z0-9._-]+$/;
const MAX_BODY = 256 * 1024 * 1024;

function tokenMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Non-internal IPv4 addresses, for printing join instructions. */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

/**
 * Starts an HTTP server to serve the repository. Every request must carry the
 * repo's token. Ref updates for the checked-out branch only fast-forward and
 * update the working tree, so peers can push into a live folder safely.
 * @param {string} repoRoot
 * @param {number} port
 * @param {string} host
 * @param {{ onChange?: (info: { branch: string, hash: string }) => void, quiet?: boolean }} [options]
 * @returns {http.Server}
 */
export function serve(repoRoot, port = 3000, host = '0.0.0.0', { onChange, quiet = false } = {}) {
  const token = getOrCreateToken(repoRoot);

  const server = http.createServer((req, res) => {
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    // GET /whoami?nonce=... -> proves we hold the token without revealing it
    if (req.method === 'GET' && req.url.startsWith('/whoami?')) {
      const nonce = new URL(req.url, 'http://x').searchParams.get('nonce') || '';
      if (!/^[0-9a-f]{8,64}$/.test(nonce)) return sendJson(400, { error: 'bad nonce' });
      const folderId = getOrCreateFolderId(repoRoot);
      return sendJson(200, {
        folderId,
        device: getDeviceName(repoRoot),
        deviceId: getOrCreateDeviceId(repoRoot),
        proof: makeProof(token, nonce, folderId),
      });
    }

    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), token)) {
      return sendJson(401, { error: 'unauthorized: missing or wrong token' });
    }

    const parseBody = () =>
      new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            reject(new Error('request too large'));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { reject(e); }
        });
        req.on('error', reject);
      });

    // GET /info/refs -> { "main": "hash1", "feature": "hash2" }
    if (req.method === 'GET' && req.url === '/info/refs') {
      try {
        const refs = {};
        for (const b of listBranches(repoRoot)) {
          refs[b.name] = b.commitHash;
        }
        return sendJson(200, refs);
      } catch (err) {
        return sendJson(500, { error: err.message });
      }
    }

    // POST /objects/missing -> { hashes } -> { missing: hashes we do not have }
    if (req.method === 'POST' && req.url === '/objects/missing') {
      return parseBody().then(({ hashes }) => {
        const missing = hashes.filter((h) => HASH_RE.test(h) && !fs.existsSync(getObjectPath(repoRoot, h)));
        sendJson(200, { missing });
      }).catch((e) => sendJson(400, { error: e.message }));
    }

    // POST /objects/fetch -> { hashes: string[] } -> { objects: { hash: base64 } }
    if (req.method === 'POST' && req.url === '/objects/fetch') {
      return parseBody().then(({ hashes }) => {
        const objects = {};
        for (const hash of hashes) {
          if (!HASH_RE.test(hash)) continue;
          const objPath = getObjectPath(repoRoot, hash);
          if (fs.existsSync(objPath)) {
            objects[hash] = fs.readFileSync(objPath).toString('base64');
          }
        }
        sendJson(200, { objects });
      }).catch((e) => sendJson(400, { error: e.message }));
    }

    // POST /objects/push -> { objects: { hash: base64 } }
    if (req.method === 'POST' && req.url === '/objects/push') {
      return parseBody().then(({ objects }) => {
        for (const [hash, base64Data] of Object.entries(objects)) {
          if (!HASH_RE.test(hash)) throw new Error(`invalid object name ${hash}`);
          const objPath = getObjectPath(repoRoot, hash);
          if (fs.existsSync(objPath)) continue;

          // Never trust a peer: the bytes must really hash to the claimed name.
          const compressed = Buffer.from(base64Data, 'base64');
          const raw = zlib.inflateSync(compressed);
          const nul = raw.indexOf(0);
          const [type] = raw.subarray(0, nul).toString('utf8').split(' ');
          if (hashObject(type, raw.subarray(nul + 1)).hash !== hash) {
            throw new Error(`object ${hash} is corrupt`);
          }
          fs.mkdirSync(path.dirname(objPath), { recursive: true });
          fs.writeFileSync(objPath, compressed);
        }
        sendJson(200, { success: true });
      }).catch((e) => sendJson(400, { error: e.message }));
    }

    // POST /refs/heads/:branch -> { commitHash: string }
    if (req.method === 'POST' && req.url.startsWith('/refs/heads/')) {
      const branchName = req.url.slice('/refs/heads/'.length);
      return parseBody().then(async ({ commitHash }) => {
        if (!BRANCH_RE.test(branchName) || !HASH_RE.test(commitHash || '')) {
          return sendJson(400, { error: 'Invalid branch or commitHash' });
        }
        if (!fs.existsSync(getObjectPath(repoRoot, commitHash))) {
          return sendJson(400, { error: 'commit objects not uploaded yet' });
        }
        const outcome = await receive(repoRoot, branchName, commitHash);
        if (outcome === 'diverged') {
          return sendJson(409, { error: 'remote has diverged; pull first' });
        }
        onChange?.({ branch: branchName, hash: commitHash });
        sendJson(200, { success: true });
      }).catch((e) => sendJson(400, { error: e.message }));
    }

    sendJson(404, { error: 'Not found' });
  });

  server.listen(port, host, () => {
    if (quiet) return;
    console.log(`mysync server listening on ${host}:${port}`);
    console.log(`Token: ${token}`);
    for (const ip of lanAddresses()) {
      console.log(`To join: mysync join http://${ip}:${port} --token ${token}`);
    }
  });

  return server;
}
