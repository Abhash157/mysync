import fs from 'node:fs';
import path from 'node:path';
import { listPeers, getOrCreateFolderId, getOrCreateDeviceId, getOrCreateToken } from './repo.js';
import { createIgnoreFilter, isPathIgnored } from './ignore.js';
import { snapshot, getDeviceName } from './auto.js';
import { syncAll, adoptDiscoveredPeer } from './sync.js';
import { startDiscovery } from './discovery.js';
import { serve } from './server.js';

function stamp() {
  return new Date().toLocaleTimeString();
}

/**
 * Keeps this folder in sync with every configured peer, hands-free:
 * edits are committed automatically, peers are pulled/pushed on a short
 * interval, and (unless disabled) incoming pushes are accepted over HTTP.
 * @param {string} repoRoot
 * @param {{ port?: number, host?: string, serve?: boolean, interval?: number, debounce?: number }} [options]
 * @returns {{ stop: () => void, syncNow: () => Promise<void> }}
 */
export function watch(repoRoot, { port = 3000, host = '0.0.0.0', serve: runServer = true, discover = true, interval = 3, debounce = 500 } = {}) {
  const log = (msg) => console.log(`[${stamp()}] ${msg}`);
  const peerState = new Map(); // name -> last reported status
  let running = false;
  let again = false;
  let stopped = false;

  async function cycle() {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        try {
          const hash = await snapshot(repoRoot);
          if (hash) log(`saved local changes (${hash.slice(0, 7)})`);
        } catch (err) {
          log(`snapshot failed: ${err.message}`);
        }

        if (listPeers(repoRoot).length === 0) continue;
        for (const result of await syncAll(repoRoot)) {
          if (!result.ok) {
            if (peerState.get(result.name) !== result.error) {
              log(`${result.name}: offline, will keep retrying (${result.error})`);
            }
            peerState.set(result.name, result.error);
            continue;
          }
          if (peerState.get(result.name) !== 'ok') log(`${result.name}: connected`);
          peerState.set(result.name, 'ok');
          if (result.pulled !== 'up-to-date') log(`${result.name}: received changes (${result.pulled})`);
          if (result.pushed) log(`${result.name}: sent changes`);
          for (const file of result.conflicts) {
            log(`conflict in ${file}: newest kept, other version saved as ${file}.conflict-*`);
          }
        }
      } while (again && !stopped);
    } finally {
      running = false;
    }
  }

  let timer = null;
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(cycle, debounce);
  };

  const ig = createIgnoreFilter(repoRoot);
  let watcher = null;
  try {
    watcher = fs.watch(repoRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return trigger();
      const rel = filename.split(path.sep).join('/');
      if (!isPathIgnored(rel, ig)) trigger();
    });
    watcher.on('error', () => {});
  } catch {
    log('file watching unavailable here; falling back to polling');
  }

  const poll = setInterval(cycle, interval * 1000);

  let server = null;
  if (runServer) {
    server = serve(repoRoot, port, host, { onChange: () => {} });
  }

  let discovery = null;
  if (discover) {
    getOrCreateToken(repoRoot);
    const recentlyFailed = new Map(); // url -> time, so a stranger's packets can't make us spam requests
    discovery = startDiscovery({
      announce: runServer
        ? () => ({
            folderId: getOrCreateFolderId(repoRoot),
            deviceId: getOrCreateDeviceId(repoRoot),
            device: getDeviceName(repoRoot),
            port,
          })
        : () => null,
      onPeer: async (msg, address) => {
        if (msg.folderId !== getOrCreateFolderId(repoRoot)) return;
        const key = `${address}:${msg.port}`;
        if (Date.now() - (recentlyFailed.get(key) || 0) < 30_000) return;
        try {
          if (await adoptDiscoveredPeer(repoRoot, msg, address)) {
            log(`found ${msg.device} at ${key} on the network`);
            cycle();
          } else if (!listPeers(repoRoot).some((p) => p.url === `http://${key}`)) {
            recentlyFailed.set(key, Date.now());
          }
        } catch {
          recentlyFailed.set(key, Date.now());
        }
      },
    });
  }

  log(`watching ${repoRoot} as '${getDeviceName(repoRoot)}' (${listPeers(repoRoot).length} peer(s))`);
  cycle();

  return {
    syncNow: cycle,
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
      discovery?.stop();
      server?.close();
    },
  };
}
