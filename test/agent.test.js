import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Agent,
  join,
  snapshot,
  initRepo,
  getHeadInfo,
  getConfig,
  writeConfig,
  getOrCreateToken,
  getSkippedFiles,
  getDeferredCount,
  isValidWindowsPath,
  isSafeRelPath,
  validateWorkspaceRoot,
  estimateFolder,
  flattenTree,
  readCommit,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandbox = path.resolve(__dirname, 'sandbox_agent');
const d = (name) => path.join(sandbox, name);
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (check()) return; } catch { /* keep waiting */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

fs.rmSync(sandbox, { recursive: true, force: true });
for (const n of ['A1', 'A2', 'B1', 'B2', 'plain']) fs.mkdirSync(d(n), { recursive: true });

console.log('Running mysync agent test suite...\n');

const agents = [];
try {
  console.log('1. Two folders share one server and stay isolated...');
  const agentA = new Agent({ port: 3071, discover: false, interval: 1, debounce: 100 });
  const agentB = new Agent({ port: 3072, discover: false, interval: 1, debounce: 100 });
  agents.push(agentA, agentB);
  await agentA.start();
  await agentB.start();
  assert.strictEqual(agentA.port, 3071);

  fs.writeFileSync(path.join(d('A1'), 'hello.txt'), 'hello from A1\n');
  fs.writeFileSync(path.join(d('A2'), 'other.txt'), 'only in A2\n');
  const wsA1 = agentA.addWorkspace(d('A1'));
  const wsA2 = agentA.addWorkspace(d('A2'));
  await until(() => getHeadInfo(d('A1')).commitHash && getHeadInfo(d('A2')).commitHash, 'initial snapshots');
  assert.notStrictEqual(wsA1.folderId, wsA2.folderId);

  await join(`http://127.0.0.1:3071/f/${wsA1.folderId}`, d('B1'), { token: getOrCreateToken(d('A1')) });
  await join(`http://127.0.0.1:3071/f/${wsA2.folderId}`, d('B2'), { token: getOrCreateToken(d('A2')) });
  const wsB1 = agentB.addWorkspace(d('B1'));
  const wsB2 = agentB.addWorkspace(d('B2'));
  assert.strictEqual(read(d('B1'), 'hello.txt'), 'hello from A1\n');
  assert(!exists(d('B1'), 'other.txt'), 'B1 must not see A2 content');
  assert.strictEqual(read(d('B2'), 'other.txt'), 'only in A2\n');

  console.log('2. Edits flow both ways and the folder reports a calm status...');
  fs.writeFileSync(path.join(d('A1'), 'from-a.txt'), 'a\n');
  await until(() => exists(d('B1'), 'from-a.txt'), 'A1 -> B1');
  fs.writeFileSync(path.join(d('B1'), 'from-b.txt'), 'b\n');
  await until(() => exists(d('A1'), 'from-b.txt'), 'B1 -> A1');
  assert(!exists(d('A2'), 'from-a.txt') && !exists(d('A2'), 'from-b.txt'), 'A2 stays isolated');
  await until(() => wsB1.snapshot().state === 'synced', 'B1 synced status');
  const snap = wsB1.snapshot();
  assert.strictEqual(snap.peers.length, 1);
  assert.strictEqual(snap.peers[0].online, true);
  assert(snap.activity.some((a) => /Received changes/.test(a.text)), 'activity feed records received changes');
  assert.strictEqual(wsA2.snapshot().state, 'alone', 'A2 has no peers configured on its side');

  console.log('3. Pausing a folder stops incoming changes until resumed...');
  wsA1.pause();
  fs.writeFileSync(path.join(d('B1'), 'while-paused.txt'), 'p\n');
  await until(() => wsB1.snapshot().peers[0].online === false, 'B1 notices A1 paused');
  assert(/paused/i.test(wsB1.snapshot().peers[0].error));
  assert(!exists(d('A1'), 'while-paused.txt'));
  wsA1.resume();
  await until(() => exists(d('A1'), 'while-paused.txt'), 'delivered after resume');
  await until(() => wsB1.snapshot().state === 'synced', 'B1 recovers');

  console.log('4. A read-only (open elsewhere) file is never clobbered, and sync catches up later...');
  const locked = path.join(d('B1'), 'hello.txt');
  fs.chmodSync(locked, 0o444);
  fs.writeFileSync(path.join(d('A1'), 'hello.txt'), 'edited on A1\n');
  await until(() => wsB1.snapshot().state === 'waiting', 'B1 waits for the locked file');
  assert.strictEqual(fs.readFileSync(locked, 'utf8'), 'hello from A1\n', 'locked file untouched');
  assert(exists(d('B1'), 'from-a.txt'), 'nothing was deleted');
  fs.chmodSync(locked, 0o666);
  await until(() => fs.readFileSync(locked, 'utf8') === 'edited on A1\n', 'update lands once unlocked');
  await until(() => wsB1.snapshot().state === 'synced', 'B1 synced again');

  console.log('5. Removing a folder stops syncing but leaves files alone...');
  assert(agentB.removeWorkspace(d('B2')));
  fs.writeFileSync(path.join(d('A2'), 'late.txt'), 'late\n');
  await sleep(2500);
  assert(!exists(d('B2'), 'late.txt'));
  assert(exists(d('B2'), 'other.txt'));
  assert.strictEqual(agentB.list().length, 1);

  console.log('6. Quiet period, size limit, and unreadable files are safe...');
  initRepo(d('plain'));
  fs.writeFileSync(path.join(d('plain'), 'fresh.txt'), 'just written');
  assert.strictEqual(await snapshot(d('plain'), { quietMs: 60_000 }), null, 'a file written a moment ago waits');
  assert.strictEqual(getDeferredCount(d('plain')), 1);
  assert(await snapshot(d('plain')), 'and is saved once it has settled');

  const config = getConfig(d('plain'));
  config.maxFileMB = 0.01;
  writeConfig(d('plain'), config);
  fs.writeFileSync(path.join(d('plain'), 'big.bin'), Buffer.alloc(50_000, 1));
  assert.strictEqual(await snapshot(d('plain')), null);
  assert.deepStrictEqual(getSkippedFiles(d('plain')).map((f) => f.path), ['big.bin']);
  fs.writeFileSync(path.join(d('plain'), 'fresh.txt'), Buffer.alloc(50_000, 2)); // grows past the limit
  assert.strictEqual(await snapshot(d('plain')), null, 'an oversized edit is not committed');
  const tree = flattenTree(d('plain'), readCommit(d('plain'), getHeadInfo(d('plain')).commitHash).treeHash);
  assert(tree['fresh.txt'], 'the last synced version of the file is kept, not deleted');
  assert(!tree['big.bin'], 'a file that was never small is simply not synced');

  console.log('7. Windows file-name rules and folder safety checks...');
  assert(isValidWindowsPath('docs/report 2024.txt'));
  for (const bad of ['a:b.txt', 'CON.txt', 'dir/nul', 'x.', 'y ', 'what?.txt', 'a<b>', 'q"r']) {
    assert(!isValidWindowsPath(bad), `${bad} is not a legal Windows name`);
  }
  if (process.platform === 'win32') assert(!isSafeRelPath('notes/a:b.txt'));
  assert(!isSafeRelPath('../escape.txt'));
  assert(!isSafeRelPath('.mysync/config.json'));

  assert.throws(() => validateWorkspaceRoot(path.parse(process.cwd()).root), /whole drive/);
  assert.throws(() => validateWorkspaceRoot(os.homedir()), /inside your user folder/);
  assert.throws(() => validateWorkspaceRoot(path.dirname(os.homedir())), /inside your user folder/);
  assert.throws(() => validateWorkspaceRoot(d('does-not-exist')), /does not exist/);
  fs.mkdirSync(path.join(d('A1'), 'inner'));
  assert.throws(() => validateWorkspaceRoot(path.join(d('A1'), 'inner'), [d('A1')]), /already synced/);
  assert.throws(() => validateWorkspaceRoot(sandbox, [d('A1')]), /already synced/);
  assert.throws(() => validateWorkspaceRoot(d('A1'), [d('A1')]), /already being synced/);

  fs.writeFileSync(path.join(d('plain'), 'x.txt'), '12345');
  const est = estimateFolder(d('plain'));
  assert(est.files >= 2 && est.bytes >= 50_000 && !est.truncated);

  console.log('\nAll agent tests passed successfully! [7/7]');
} finally {
  for (const a of agents) a.stop();
  await sleep(200);
  fs.rmSync(sandbox, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
