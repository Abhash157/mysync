import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { listBranches } from './branch.js';
import { updateBranchRef, GDIF_DIR } from './repo.js';

/**
 * Gets path to object in .gdif/objects/
 * @param {string} repoRoot
 * @param {string} hash
 * @returns {string}
 */
function getObjectPath(repoRoot, hash) {
  const dir = hash.slice(0, 2);
  const file = hash.slice(2);
  return path.join(repoRoot, GDIF_DIR, 'objects', dir, file);
}

/**
 * Starts an HTTP server to serve the repository.
 * @param {string} repoRoot
 * @param {number} port
 */
export function serve(repoRoot, port = 3000) {
  const server = http.createServer((req, res) => {
    // CORS headers for convenience
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    const parseBody = () =>
      new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      });

    // GET /info/refs -> { "main": "hash1", "feature": "hash2" }
    if (req.method === 'GET' && req.url === '/info/refs') {
      try {
        const branches = listBranches(repoRoot);
        const refs = {};
        for (const b of branches) {
          refs[b.name] = b.commitHash;
        }
        return sendJson(200, refs);
      } catch (err) {
        return sendJson(500, { error: err.message });
      }
    }

    // POST /objects/fetch -> { hashes: string[] } -> { objects: { hash: base64 } }
    if (req.method === 'POST' && req.url === '/objects/fetch') {
      return parseBody().then(({ hashes }) => {
        const objects = {};
        for (const hash of hashes) {
          const objPath = getObjectPath(repoRoot, hash);
          if (fs.existsSync(objPath)) {
            objects[hash] = fs.readFileSync(objPath).toString('base64');
          }
        }
        sendJson(200, { objects });
      }).catch(e => sendJson(400, { error: e.message }));
    }

    // POST /objects/push -> { objects: { hash: base64 } }
    if (req.method === 'POST' && req.url === '/objects/push') {
      return parseBody().then(({ objects }) => {
        for (const [hash, base64Data] of Object.entries(objects)) {
          const objPath = getObjectPath(repoRoot, hash);
          if (!fs.existsSync(objPath)) {
            fs.mkdirSync(path.dirname(objPath), { recursive: true });
            fs.writeFileSync(objPath, Buffer.from(base64Data, 'base64'));
          }
        }
        sendJson(200, { success: true });
      }).catch(e => sendJson(400, { error: e.message }));
    }

    // POST /refs/heads/:branch -> { commitHash: string }
    if (req.method === 'POST' && req.url.startsWith('/refs/heads/')) {
      const branchName = req.url.slice('/refs/heads/'.length);
      return parseBody().then(({ commitHash }) => {
        if (!commitHash || !branchName) {
          return sendJson(400, { error: 'Invalid branch or commitHash' });
        }
        // In a real VCS we'd check if it's a fast-forward. For simplicity, just update.
        updateBranchRef(repoRoot, branchName, commitHash);
        sendJson(200, { success: true });
      }).catch(e => sendJson(400, { error: e.message }));
    }

    sendJson(404, { error: 'Not found' });
  });

  server.listen(port, () => {
    console.log(`gdif server listening on port ${port}`);
    console.log(`To clone: gdif clone http://<your-ip>:${port} my-repo`);
  });
}
