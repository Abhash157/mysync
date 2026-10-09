import { listPeers } from './repo.js';
import { Agent } from './agent.js';
import { buildInvite } from './invite.js';

const stamp = () => new Date().toLocaleTimeString();

/**
 * Keeps one folder in sync with every configured peer, hands-free (the CLI's
 * `mysync watch`). This is the multi-folder Agent running a single folder that is
 * also served at the server root, so older `join http://ip:port` URLs keep working.
 * @param {string} repoRoot
 * @param {{ port?: number, host?: string, serve?: boolean, discover?: boolean, interval?: number, debounce?: number }} [options]
 * @returns {{ stop: () => void, syncNow: () => Promise<void> }}
 */
export function watch(repoRoot, { port = 3000, host = '0.0.0.0', serve: runServer = true, discover = true, interval = 3, debounce = 500 } = {}) {
  const log = (msg) => console.log(`[${stamp()}] ${msg}`);

  const agent = new Agent({
    port,
    host,
    portTries: 1, // the CLI listens exactly where it was told to
    serve: runServer,
    discover,
    interval,
    debounce,
    rootWorkspace: repoRoot,
  });

  agent.on('activity', ({ text }) => log(text));
  agent.on('server', ({ port: bound, error }) => {
    if (error) {
      log(`cannot accept incoming connections on port ${port}: ${error}. Still syncing out to peers.`);
      return;
    }
    log(`listening on port ${bound}`);
    console.log(`Invite code (same network or internet): ${buildInvite(repoRoot, bound)}`);
    console.log('On another device: mysync join <invite code>   (on the same network: mysync join auto --token <token>)');
  });

  const ws = agent.addWorkspace(repoRoot, { validate: false });
  agent.start().then(() => {
    log(`watching ${repoRoot} as '${ws.deviceName}' (${listPeers(repoRoot).length} peer(s))`);
  });

  return {
    syncNow: () => ws.syncNow(),
    stop: () => agent.stop(),
  };
}
