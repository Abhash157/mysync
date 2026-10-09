import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hostPath = path.resolve(here, '..', 'src', 'engine-host.mjs');
const sandbox = path.resolve(here, 'sandbox_host');
const dirA = path.join(sandbox, 'A', 'Notes');
const dirB = path.join(sandbox, 'B', 'Notes');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const exists = (dir, f) => fs.existsSync(path.join(dir, f));

async function until(check, what, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await check()) return; } catch { /* keep waiting */ }
    await sleep(150);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const hosts = [];
function startHost(name) {
  const child = fork(hostPath, [], {
    env: { ...process.env, MYSYNC_DISCOVERY_PORT: '41999', MYSYNC_GLOBAL_CONFIG: path.join(sandbox, `${name}-global.json`) },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const pending = new Map();
  const events = [];
  let nextId = 1;
  child.on('message', (msg) => {
    if (msg.event) return events.push(msg);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  const api = {
    child,
    events,
    call: (cmd, args = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (msg) => (msg.ok ? resolve(msg.result) : reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }))));
        child.send({ id, cmd, args });
      }),
    latest: (root) => [...events].reverse().find((e) => e.event === 'update' && e.data.root === path.resolve(root))?.data,
  };
  hosts.push(child);
  return api;
}

fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(dirA, { recursive: true });
fs.mkdirSync(dirB, { recursive: true });
fs.rmdirSync(dirB); // B's folder is created by "join"

console.log('Running MySync engine-host (app backend) test suite...\n');

try {
  const A = startHost('A');
  const B = startHost('B');
  const initA = await A.call('init', { deviceName: 'Desk PC', port: 3081 });
  const initB = await B.call('init', { deviceName: 'Laptop', port: 3082 });
  assert.strictEqual(initA.port, 3081);
  assert.strictEqual(initB.port, 3082);

  console.log('1. Adding a folder returns a status snapshot and rejects bad choices politely...');
  fs.writeFileSync(path.join(dirA, 'todo.txt'), 'buy milk\n');
  const inspected = await A.call('inspectFolder', { root: dirA });
  assert(inspected.estimate.files >= 1);
  await assert.rejects(A.call('addFolder', { root: os.homedir() }), (e) => e.code === 'EUSER' && /user folder/.test(e.message));
  await assert.rejects(A.call('addFolder', { root: path.parse(sandbox).root }), (e) => /whole drive/.test(e.message));
  const added = await A.call('addFolder', { root: dirA });
  assert.strictEqual(added.name, 'Notes');
  assert.strictEqual(added.deviceName, 'Desk PC');
  await assert.rejects(A.call('addFolder', { root: dirA }), /already being synced/);

  console.log('2. Another PC joins with just the invite code...');
  const { code } = await A.call('invite', { root: dirA });
  assert(code.startsWith('mys1.'));
  const info = await B.call('inspectInvite', { code });
  assert(info.valid && info.lanCount >= 1);
  assert.strictEqual((await B.call('inspectInvite', { code: 'nonsense' })).valid, false);
  await assert.rejects(B.call('joinFolder', { code: 'mys1.AAAA', dest: dirB }), /not a valid mysync invite/);
  assert(!exists(sandbox, 'B/Notes'), 'a failed join leaves no stray folder behind');

  const joined = await B.call('joinFolder', { code, dest: dirB });
  assert.strictEqual(joined.deviceName, 'Laptop');
  await until(() => exists(dirB, 'todo.txt'), 'initial download');
  assert.strictEqual(read(dirB, 'todo.txt'), 'buy milk\n');
  await until(() => B.latest(dirB)?.state === 'synced', 'B reports synced');

  console.log('3. Edits flow both ways and devices find each other on the LAN...');
  fs.writeFileSync(path.join(dirB, 'from-laptop.txt'), 'hi\n');
  await until(() => exists(dirA, 'from-laptop.txt'), 'B -> A');
  fs.writeFileSync(path.join(dirA, 'todo.txt'), 'buy milk and eggs\n');
  await until(() => read(dirB, 'todo.txt') === 'buy milk and eggs\n', 'A -> B');
  await until(async () => (await A.call('list'))[0].peers.some((p) => p.label === 'Laptop' && p.online), 'A discovers Laptop');
  assert((await A.call('list'))[0].activity.length > 0);

  console.log('4. Pause, resume and rename the device...');
  await A.call('pause', { root: dirA });
  assert.strictEqual((await A.call('list'))[0].state, 'paused');
  await A.call('resume', { root: dirA });
  await A.call('setDeviceName', { name: 'Office PC' });
  assert.strictEqual((await A.call('list'))[0].deviceName, 'Office PC');
  await assert.rejects(A.call('setDeviceName', { name: '   ' }), /name/);

  console.log('5. Stopping sync keeps the files...');
  assert.strictEqual(await B.call('removeFolder', { root: dirB }), true);
  assert.strictEqual((await B.call('list')).length, 0);
  assert(exists(dirB, 'todo.txt'));
  fs.writeFileSync(path.join(dirA, 'after.txt'), 'x\n');
  await sleep(2500);
  assert(!exists(dirB, 'after.txt'), 'no more updates after removal');

  console.log('6. A remembered folder that vanished is reported, never silently re-created...');
  const ghost = path.join(sandbox, 'B', 'Ghost');
  const restored = await B.call('restore', { folders: [{ root: ghost, paused: false }] });
  const ghostSnap = restored.find((f) => f.root === path.resolve(ghost));
  assert.strictEqual(ghostSnap.state, 'attention');
  assert.strictEqual(ghostSnap.missing, true);
  assert(!fs.existsSync(ghost), 'the missing folder was not re-created');

  console.log('7. Internet-server settings are validated...');
  assert.strictEqual(await A.call('getHub'), null);
  await assert.rejects(A.call('setHub', { url: 'ftp://nope' }), /http/);
  assert.deepStrictEqual(await A.call('setHub', { url: 'https://hub.example.com/', secret: 's' }), { url: 'https://hub.example.com', hasSecret: true });
  assert.strictEqual((await A.call('testHub', { url: 'http://127.0.0.1:9' })).ok, false);
  assert.strictEqual(await A.call('setHub', { url: '' }), null);

  console.log('\nAll engine-host tests passed successfully! [7/7]');
} finally {
  for (const h of hosts) h.kill();
  await sleep(300);
  fs.rmSync(sandbox, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
