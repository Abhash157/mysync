import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../bin/cli.js');
const sandbox = path.resolve(__dirname, 'sandbox_auto');
const dirA = path.join(sandbox, 'A');
const dirB = path.join(sandbox, 'B');
const dirC = path.join(sandbox, 'C');
const env = { ...process.env, MYSYNC_AUTHOR_NAME: 'Test', MYSYNC_AUTHOR_EMAIL: 't@mysync.local' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (args, cwd) => execFileSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8' });
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const exists = (dir, f) => fs.existsSync(path.join(dir, f));

async function until(check, what, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (check()) return; } catch { /* keep waiting */ }
    await sleep(150);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const procs = [];
function daemon(cwd, port) {
  const p = spawn(process.execPath, [cliPath, 'watch', '-p', String(port), '-i', '1'], { cwd, env, stdio: 'ignore' });
  procs.push(p);
  return p;
}

fs.rmSync(sandbox, { recursive: true, force: true });
for (const d of [dirA, dirB, dirC]) fs.mkdirSync(d, { recursive: true });

console.log('Running mysync auto-sync test suite...\n');

try {
  // A is the first device and already has files.
  cli(['init'], dirA);
  fs.writeFileSync(path.join(dirA, 'notes.txt'), 'v1\n');
  fs.mkdirSync(path.join(dirA, 'sub'));
  fs.writeFileSync(path.join(dirA, 'sub', 'deep.txt'), 'deep\n');
  daemon(dirA, 3041);
  await until(() => fs.existsSync(path.join(dirA, '.mysync', 'config.json')) && JSON.parse(read(dirA, '.mysync/config.json')).token, 'A token');
  const token = JSON.parse(read(dirA, '.mysync/config.json')).token;

  console.log('1. B joins an existing folder that already has its own file...');
  fs.writeFileSync(path.join(dirB, 'only-on-b.txt'), 'b file\n');
  await until(() => { try { cli(['join', 'http://127.0.0.1:3041', '--token', token], dirB); return true; } catch { return false; } }, 'join');
  assert.strictEqual(read(dirB, 'notes.txt'), 'v1\n');
  assert.strictEqual(read(dirB, 'sub/deep.txt'), 'deep\n');
  daemon(dirB, 3042);
  await until(() => exists(dirA, 'only-on-b.txt'), 'B file reaches A (push into live folder)');

  console.log('2. Edit on A shows up on B with no commands...');
  fs.writeFileSync(path.join(dirA, 'notes.txt'), 'v2 from A\n');
  await until(() => read(dirB, 'notes.txt') === 'v2 from A\n', 'edit A->B');

  console.log('3. Edit on B shows up on A...');
  fs.writeFileSync(path.join(dirB, 'sub', 'new.txt'), 'made on B\n');
  await until(() => exists(dirA, 'sub/new.txt') && read(dirA, 'sub/new.txt') === 'made on B\n', 'edit B->A');

  console.log('4. Deletes propagate...');
  fs.rmSync(path.join(dirA, 'only-on-b.txt'));
  await until(() => !exists(dirB, 'only-on-b.txt'), 'delete A->B');

  console.log('5. Simultaneous edits to the same file keep both versions and converge...');
  procs[0].kill();
  procs[1].kill();
  await sleep(500);
  fs.writeFileSync(path.join(dirA, 'notes.txt'), 'A offline edit\n');
  await sleep(1100);
  fs.writeFileSync(path.join(dirB, 'notes.txt'), 'B offline edit\n');
  fs.writeFileSync(path.join(dirB, 'extra.txt'), 'extra\n');
  daemon(dirA, 3041);
  daemon(dirB, 3042);
  await until(() => exists(dirA, 'extra.txt'), 'merge propagated');
  await until(() => {
    const a = fs.readdirSync(dirA).filter((f) => f.startsWith('notes.conflict-')).sort();
    const b = fs.readdirSync(dirB).filter((f) => f.startsWith('notes.conflict-')).sort();
    return a.length === 1 && a.join() === b.join() && read(dirA, 'notes.txt') === read(dirB, 'notes.txt');
  }, 'identical conflict result on both devices');
  const texts = [read(dirA, 'notes.txt'), read(dirA, fs.readdirSync(dirA).find((f) => f.startsWith('notes.conflict-')))].sort();
  assert.deepStrictEqual(texts, ['A offline edit\n', 'B offline edit\n'], 'no data lost');

  console.log('6. A third device joins later and gets everything...');
  cli(['join', 'http://127.0.0.1:3042', '--token', JSON.parse(read(dirB, '.mysync/config.json')).token], dirC);
  assert.strictEqual(read(dirC, 'sub/new.txt'), 'made on B\n');
  assert(exists(dirC, 'extra.txt'));

  console.log('7. Wrong token is rejected...');
  const bad = await fetch('http://127.0.0.1:3041/info/refs', { headers: { Authorization: 'Bearer nope' } });
  assert.strictEqual(bad.status, 401);

  console.log('\nAll auto-sync tests passed successfully! [7/7]');
} finally {
  for (const p of procs) p.kill();
  await sleep(300);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
