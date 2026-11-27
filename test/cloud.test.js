import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startWebDav, startGoogleDrive, startOneDrive, approveSignIn } from './cloud-mocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../bin/cli.js');
const sandbox = path.resolve(__dirname, 'sandbox_cloud');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });

const gdrive = await startGoogleDrive();
const onedrive = await startOneDrive();
const webdav = await startWebDav({ user: 'alice', pass: 's3cret' });

Object.assign(process.env, {
  MYSYNC_AUTHOR_NAME: 'Test',
  MYSYNC_AUTHOR_EMAIL: 't@mysync.local',
  MYSYNC_GLOBAL_CONFIG: path.join(sandbox, 'global.json'),
  MYSYNC_CLOUD_INTERVAL_MS: '500',
  ...gdrive.env,
  ...onedrive.env,
});
const E = await import('../src/index.js');

const dir = (name) => {
  const p = path.join(sandbox, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const head = (root) => E.getHeadInfo(root).commitHash;
const files = (root) => fs.readdirSync(root).filter((f) => f !== '.mysync').sort();
const cli = (args, cwd) => execFileSync(process.execPath, [cliPath, ...args], { cwd, env: process.env, encoding: 'utf8', stdio: 'pipe' });

/** Sync every device in turn until nobody sends anything new. */
async function settle(roots, remote, maxRounds = 8) {
  for (let round = 0; round < maxRounds; round++) {
    let activity = false;
    for (const root of roots) {
      const result = await E.syncPeer(root, remote);
      if (result.pushed || result.pulled !== 'up-to-date') activity = true;
    }
    if (!activity) return round;
  }
  throw new Error('devices did not converge');
}

function newRepo(name, content = {}) {
  const root = dir(name);
  E.initRepo(root);
  const config = E.getConfig(root);
  config.device = name;
  E.writeConfig(root, config);
  for (const [rel, text] of Object.entries(content)) write(root, rel, text);
  return root;
}

console.log('Running mysync cloud test suite...\n');

try {
  // -------------------------------------------------------------------------
  console.log('1. A folder kept in the cloud by a desktop app: link, then join from another device...');
  const cloudDir = dir('OneDrive-ish');
  const folder = await E.addCloudAccount('folder', { path: cloudDir });
  assert.strictEqual(folder.provider, 'folder');
  assert(E.listCloudAccounts().some((a) => a.id === folder.id));
  const remote = E.cloudRemoteName(folder.id);

  const A = newRepo('A', { 'hello.txt': 'hello from A\n', 'docs/plan.md': '# plan\n' });
  const linked = await E.linkCloud(A, folder.id, 'Project Notes');
  assert.strictEqual(linked.name, 'project-notes');
  assert(linked.created);
  assert(fs.existsSync(path.join(cloudDir, 'MySync', 'project-notes', 'workspace.json')));
  assert(!exists(path.join(cloudDir, 'MySync', 'project-notes'), 'hello.txt'), 'the cloud copy holds objects, not loose files');

  const listed = await E.listCloudWorkspaces(folder.id);
  assert.deepStrictEqual(listed.map((w) => w.name), ['project-notes']);
  assert.deepStrictEqual(listed[0].devices.map((d) => d.device), ['A']);

  const B = newRepo('B', { 'from-b.txt': 'B was here first\n' });
  await E.joinCloud(folder.id, 'project-notes', B, { device: 'B' });
  assert.strictEqual(read(B, 'hello.txt'), 'hello from A\n');
  assert.strictEqual(read(B, 'docs/plan.md'), '# plan\n');
  assert.strictEqual(read(B, 'from-b.txt'), 'B was here first\n', 'files already in the folder are kept');
  assert.strictEqual(E.getConfig(B).folderId, E.getConfig(A).folderId);
  assert.strictEqual(E.getConfig(B).token, E.getConfig(A).token, 'joined devices share the token, so they also sync on the LAN');

  await settle([A, B], remote);
  assert.strictEqual(read(A, 'from-b.txt'), 'B was here first\n');
  assert.strictEqual(head(A), head(B));

  // -------------------------------------------------------------------------
  console.log('2. Edits and deletes travel both ways, and a quiet round sends nothing...');
  write(A, 'hello.txt', 'edited on A\n');
  fs.rmSync(path.join(B, 'docs'), { recursive: true });
  await settle([A, B], remote);
  assert.strictEqual(read(B, 'hello.txt'), 'edited on A\n');
  assert(!exists(A, 'docs/plan.md'), 'delete on B reached A');
  const quiet = await E.syncPeer(A, remote);
  assert.deepStrictEqual([quiet.pulled, quiet.pushed], ['up-to-date', false]);

  // -------------------------------------------------------------------------
  console.log('3. Three devices edit at once (same file too) and converge on one identical history...');
  const C = newRepo('C');
  await E.joinCloud(folder.id, 'project-notes', C, { device: 'C' });
  await settle([A, B, C], remote);
  write(A, 'shared.txt', 'A version\n');
  write(B, 'shared.txt', 'B version\n');
  write(C, 'c-only.txt', 'C\n');
  write(A, 'a-only.txt', 'A\n');
  await E.snapshot(A);
  await E.snapshot(B);
  await E.snapshot(C);
  // Everyone uploads before anyone reads, the worst case for merging.
  await Promise.all([A, B, C].map((r) => E.syncPeer(r, remote)));
  const rounds = await settle([A, B, C], remote);
  assert.strictEqual(head(A), head(B));
  assert.strictEqual(head(B), head(C));
  assert(rounds <= 3, `converged in ${rounds} extra rounds`);
  for (const r of [A, B, C]) {
    assert.deepStrictEqual(files(r), files(A));
    assert.strictEqual(read(r, 'c-only.txt'), 'C\n');
    assert.strictEqual(read(r, 'a-only.txt'), 'A\n');
  }
  const shared = read(A, 'shared.txt');
  assert(shared.includes('<<<<<<<') && shared.includes('A version\n') && shared.includes('B version\n'), 'both edits are kept in the file');
  assert(!files(A).some((f) => f.includes('.conflict-')));

  // -------------------------------------------------------------------------
  console.log('4. Changes still uploading from another device are waited for, not treated as errors...');
  write(A, 'late.txt', 'arrives late\n');
  await E.syncPeer(A, remote);
  const objectsDir = path.join(cloudDir, 'MySync', 'project-notes', 'objects');
  const blob = E.hashObject('blob', Buffer.from('arrives late\n')).hash;
  const hidden = path.join(sandbox, 'hidden-object');
  fs.renameSync(path.join(objectsDir, blob), hidden);
  await assert.rejects(E.syncPeer(B, remote), (err) => err.code === 'ECLOUDPARTIAL');
  assert(!exists(B, 'late.txt'));
  fs.renameSync(hidden, path.join(objectsDir, blob));
  await E.syncPeer(B, remote);
  assert.strictEqual(read(B, 'late.txt'), 'arrives late\n');

  console.log('5. A damaged object in the cloud is refused...');
  write(A, 'tampered.txt', 'original\n');
  await E.syncPeer(A, remote);
  const tamperedHash = E.hashObject('blob', Buffer.from('original\n')).hash;
  const goodBytes = fs.readFileSync(path.join(objectsDir, tamperedHash));
  fs.writeFileSync(path.join(objectsDir, tamperedHash), Buffer.from('not an object'));
  await assert.rejects(E.syncPeer(B, remote), (err) => err.code === 'ECLOUDPARTIAL');
  fs.writeFileSync(path.join(objectsDir, tamperedHash), goodBytes);
  await settle([A, B, C], remote);
  assert.strictEqual(read(C, 'tampered.txt'), 'original\n');

  // -------------------------------------------------------------------------
  console.log('6. A name used by another folder is not taken over; push/pull refuse cloud remotes...');
  const Other = newRepo('Other', { 'x.txt': 'x\n' });
  await assert.rejects(E.linkCloud(Other, folder.id, 'project-notes'), (err) => err.code === 'ECLOUDTAKEN');
  await assert.rejects(E.push(A, remote), /two-way sync/);
  const relink = await E.linkCloud(A, folder.id, 'project-notes');
  assert.strictEqual(relink.created, false, 're-linking the same folder is fine');

  console.log('7. Unlinking stops syncing through the cloud but leaves its copy...');
  assert(E.unlinkCloud(C, folder.id));
  assert(!E.getPeer(C, remote));
  assert(fs.existsSync(path.join(cloudDir, 'MySync', 'project-notes', 'workspace.json')));

  // -------------------------------------------------------------------------
  console.log('8. The Agent (what the app and `watch` run) syncs through the cloud by itself...');
  const agent = new E.Agent({ serve: false, discover: false, interval: 1 });
  await agent.start();
  const wsA = agent.addWorkspace(A);
  const wsB = agent.addWorkspace(B);
  write(A, 'live.txt', 'live through the cloud\n');
  wsA.requestScan();
  const until = async (check, what, timeout = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  await until(() => exists(B, 'live.txt'), 'A -> cloud -> B through the agent');
  const peer = wsB.snapshot().peers.find((p) => p.name === remote);
  assert.strictEqual(peer.kind, 'cloud');
  assert.strictEqual(peer.label, folder.label);
  await until(() => wsB.snapshot().state === 'synced', 'B shows up to date');
  agent.stop();

  // -------------------------------------------------------------------------
  console.log('9. WebDAV (Nextcloud, NAS...): wrong password is refused, right one syncs...');
  await assert.rejects(E.addCloudAccount('webdav', { url: webdav.url, username: 'alice', password: 'nope' }), (err) => err.code === 'ECLOUDAUTH');
  const dav = await E.addCloudAccount('webdav', { url: webdav.url, username: 'alice', password: 's3cret' });
  assert(!JSON.stringify(E.listCloudAccounts()).includes('s3cret'), 'passwords never leave the engine');
  const D1 = newRepo('D1', { 'a b & c.txt': 'odd name\n', 'nested/deep/file.txt': 'deep\n' });
  await E.linkCloud(D1, dav.id, 'dav-test');
  const D2 = newRepo('D2');
  await E.joinCloud(dav.id, 'dav-test', D2);
  assert.strictEqual(read(D2, 'a b & c.txt'), 'odd name\n');
  assert.strictEqual(read(D2, 'nested/deep/file.txt'), 'deep\n');
  write(D2, 'back.txt', 'back\n');
  await settle([D1, D2], E.cloudRemoteName(dav.id));
  assert.strictEqual(read(D1, 'back.txt'), 'back\n');

  // -------------------------------------------------------------------------
  console.log('10. Google Drive: browser sign-in, paging, token refresh and big-file uploads...');
  await assert.rejects(E.connectCloudAccount('gdrive'), (err) => err.code === 'ENOCLIENT');
  E.setCloudApp('gdrive', { clientId: 'g-client', clientSecret: 'g-secret' });
  const flow = await E.connectCloudAccount('gdrive');
  const authUrl = new URL(flow.url);
  assert.strictEqual(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(authUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.strictEqual(await approveSignIn(flow.url), 200);
  const g = await flow.done;
  assert.strictEqual(g.detail, 'me@example.com');

  const G1 = newRepo('G1', { 'readme.txt': 'drive\n' });
  for (let i = 0; i < 60; i++) write(G1, `many/file-${i}.txt`, `file ${i}\n`); // more than one page of listing
  const big = crypto.randomBytes(6 * 1024 * 1024); // incompressible, so the object is > 5 MB
  fs.writeFileSync(path.join(G1, 'big.bin'), big);
  await E.linkCloud(G1, g.id, 'drive-test');
  assert(gdrive.stats.resumable >= 1, 'large objects use a resumable upload');

  gdrive.tokens.revokeAccess(); // an hour later...
  const G2 = newRepo('G2');
  await E.joinCloud(g.id, 'drive-test', G2);
  assert(gdrive.tokens.refreshes >= 1, 'the expired token was refreshed silently');
  assert(fs.readFileSync(path.join(G2, 'big.bin')).equals(big));
  assert.strictEqual(read(G2, 'many/file-59.txt'), 'file 59\n');
  write(G2, 'readme.txt', 'edited on G2\n');
  await settle([G1, G2], E.cloudRemoteName(g.id));
  assert.strictEqual(read(G1, 'readme.txt'), 'edited on G2\n');
  assert(gdrive.stats.patch >= 1, 'head files are updated in place, not duplicated');
  const heads = [...gdrive.files.values()].filter((f) => f.name.endsWith('.json') && f.name !== 'workspace.json');
  assert.strictEqual(heads.length, 2, 'one head file per device');

  console.log('11. A cancelled sign-in saves nothing...');
  const before = E.listCloudAccounts().length;
  const flow2 = await E.connectCloudAccount('gdrive');
  const url2 = new URL(flow2.url);
  const deny = new URL(url2.searchParams.get('redirect_uri'));
  deny.searchParams.set('error', 'access_denied');
  deny.searchParams.set('state', url2.searchParams.get('state'));
  await fetch(deny);
  await assert.rejects(flow2.done, /cancelled/);
  assert.strictEqual(E.listCloudAccounts().length, before);

  // -------------------------------------------------------------------------
  console.log('12. OneDrive: app folder, upload sessions in 320 KiB multiples, rotating refresh tokens...');
  E.setCloudApp('onedrive', { clientId: 'ms-client' });
  const msFlow = await E.connectCloudAccount('onedrive');
  assert.strictEqual(new URL(new URL(msFlow.url).searchParams.get('redirect_uri')).hostname, 'localhost');
  await approveSignIn(msFlow.url);
  const ms = await msFlow.done;
  assert.strictEqual(ms.detail, 'me@outlook.com');

  const O1 = newRepo('O1', { 'note.txt': 'onedrive\n' });
  for (let i = 0; i < 55; i++) write(O1, `bulk/${i}.txt`, `bulk ${i}\n`);
  const big2 = crypto.randomBytes(12 * 1024 * 1024);
  fs.writeFileSync(path.join(O1, 'video.bin'), big2);
  await E.linkCloud(O1, ms.id, 'od-test');
  assert(onedrive.stats.sessions >= 1);
  assert(onedrive.stats.chunks.length >= 2, 'big files go up in several chunks');

  const rtBefore = JSON.parse(fs.readFileSync(process.env.MYSYNC_GLOBAL_CONFIG, 'utf8')).cloud.accounts[ms.id].refreshToken;
  onedrive.tokens.revokeAccess();
  const O2 = newRepo('O2');
  await E.joinCloud(ms.id, 'od-test', O2);
  const rtAfter = JSON.parse(fs.readFileSync(process.env.MYSYNC_GLOBAL_CONFIG, 'utf8')).cloud.accounts[ms.id].refreshToken;
  assert.notStrictEqual(rtAfter, rtBefore, 'the rotated refresh token was saved');
  assert(fs.readFileSync(path.join(O2, 'video.bin')).equals(big2));
  assert.strictEqual(read(O2, 'bulk/54.txt'), 'bulk 54\n');
  assert.deepStrictEqual((await E.listCloudWorkspaces(ms.id)).map((w) => w.name), ['od-test']);

  // -------------------------------------------------------------------------
  console.log('13. CLI: list, link and join through a cloud folder...');
  const cliCloud = dir('cli-cloud');
  const out = cli(['cloud', 'add', 'folder', cliCloud], sandbox);
  const cliId = /as '([^']+)'/.exec(out)[1];
  assert(cli(['cloud', 'list'], sandbox).includes(cliId));
  const P = newRepo('P', { 'p.txt': 'from the cli\n' });
  assert(cli(['cloud', 'link', cliId, 'cli-ws'], P).includes("Stored as 'cli-ws'"));
  cli(['cloud', 'join', cliId, 'cli-ws', 'Q'], sandbox);
  assert.strictEqual(read(path.join(sandbox, 'Q'), 'p.txt'), 'from the cli\n');
  assert(cli(['cloud', 'workspaces', cliId], sandbox).includes('cli-ws'));
  write(path.join(sandbox, 'Q'), 'q.txt', 'q\n');
  cli(['sync'], path.join(sandbox, 'Q'));
  cli(['sync'], P);
  assert.strictEqual(read(P, 'q.txt'), 'q\n');
  assert.throws(() => cli(['cloud', 'link', 'nope'], P), (e) => /no cloud account/.test(String(e.stderr)));
  cli(['cloud', 'remove', cliId], sandbox);
  assert(!cli(['cloud', 'list'], sandbox).includes(cliId));

  console.log('\nAll cloud tests passed!');
} finally {
  gdrive.server.close();
  onedrive.server.close();
  webdav.server.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
}
process.exit(0);
