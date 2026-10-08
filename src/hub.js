import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { initRepo, getConfig, writeConfig, GDIF_DIR } from './repo.js';
import { handleSyncRequest, tokenMatches } from './server.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const FOLDER_RE = /^[0-9a-f]{16}$/;

export const isValidWorkspaceName = (name) => NAME_RE.test(name);

/**
 * Runs a hub: an always-reachable meeting point that stores many named
 * workspaces as bare copies (no working folder). Devices behind NAT sync
 * through it using the normal protocol under /w/<name>/.
 * Put it behind HTTPS (e.g. Caddy, nginx, a tunnel) when exposing it to the internet.
 * @param {{ dir: string, port?: number, host?: string, secret?: string|null }} options
 * @returns {http.Server}
 */
export function runHub({ dir, port = 8080, host = '0.0.0.0', secret = null }) {
  const baseDir = path.resolve(dir);
  fs.mkdirSync(baseDir, { recursive: true });

  const server = http.createServer((req, res) => {
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.method === 'GET' && req.url === '/health') return sendJson(200, { ok: true, hub: true });

    const match = req.url.match(/^\/w\/([^/?]+)(\/.*)$/);
    if (!match || !NAME_RE.test(match[1])) return sendJson(404, { error: 'Not found' });
    const [, name, rest] = match;
    const root = path.join(baseDir, name);

    if (req.method === 'POST' && rest === '/create') {
      if (secret && !tokenMatches(String(req.headers['x-hub-secret'] || ''), secret)) {
        return sendJson(403, { error: 'this hub needs its secret to create workspaces (mysync hub set <url> --secret ...)' });
      }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return sendJson(400, { error: 'bad request' }); }
        if (!TOKEN_RE.test(body.token || '') || !FOLDER_RE.test(body.folderId || '')) {
          return sendJson(400, { error: 'bad token or folder id' });
        }
        try {
          fs.mkdirSync(root); // atomic: fails if the name is taken
        } catch (err) {
          if (err.code === 'EEXIST') return sendJson(409, { error: 'workspace name already exists' });
          return sendJson(500, { error: err.message });
        }
        initRepo(root);
        const config = getConfig(root);
        config.token = body.token;
        config.folderId = body.folderId;
        config.device = 'hub';
        writeConfig(root, config);
        sendJson(201, { created: name });
      });
      return;
    }

    if (!fs.existsSync(path.join(root, GDIF_DIR))) return sendJson(404, { error: 'no such workspace' });
    const token = getConfig(root).token;
    handleSyncRequest(req, res, rest, { repoRoot: root, token, bare: true });
  });

  server.listen(port, host, () => {
    console.log(`mysync hub listening on ${host}:${port}, storing workspaces in ${baseDir}`);
    if (!secret) console.log('warning: no --secret set, so anyone who can reach this port can create workspaces');
  });
  return server;
}
