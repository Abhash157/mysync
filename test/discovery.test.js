import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../bin/cli.js');
const sandbox = path.resolve(__dirname, 'sandbox_discovery');
const [A, B, C] = ['A', 'B', 'C'].map((n) => path.join(sandbox, n));
const env = {
  ...process.env,
  MYSYNC_AUTHOR_NAME: 'Test',
  MYSYNC_AUTHOR_EMAIL: 't@mysync.local',
  MYSYNC_DISCOVERY_PORT: '41877',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (args, cwd) => execFileSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8', stdio: 'pipe' });
const config = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.mysync', 'config.json'), 'utf8'));
const procs = [];
const daemon = (cwd, port) => {
  const p = spawn(process.execPath, [cliPath, 'watch', '-p', String(port), '-i', '1'], { cwd, env, stdio: 'ignore' });
  procs.push(p);
  return p;
};

async function until(check, what, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (check()) return; } catch { /* keep waiting */ }
    await sleep(200);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

fs.rmSync(sandbox, { recursive: true, force: true });
for (const d of [A, B, C]) fs.mkdirSync(d, { recursive: true });

console.log('Running mysync LAN discovery test suite...\n');

try {
  cli(['init'], A);
  fs.writeFileSync(path.join(A, 'hello.txt'), 'hi\n');
  daemon(A, 3051);
  await until(() => config(A).token, 'A token');
  const token = config(A).token;

  console.log('1. B joins A by URL, C joins with "auto" and no address...');
  await until(() => { try { cli(['join', 'http://127.0.0.1:3051', '--token', token], B); return true; } catch { return false; } }, 'B join');
  daemon(B, 3052);
  await until(() => {
    try { cli(['join', 'auto', '--token', token], C); return true; } catch { return false; }
  }, 'C join auto');
  daemon(C, 3053);
  assert.strictEqual(fs.readFileSync(path.join(C, 'hello.txt'), 'utf8'), 'hi\n');
  assert.strictEqual(config(B).folderId, config(A).folderId, 'folder id is shared');
  assert.strictEqual(config(C).token, token, 'token is shared');

  console.log('2. Devices find each other without being told...');
  await until(() => [A, B, C].every((d) => Object.keys(config(d).remotes || {}).length >= 2), 'full mesh');

  console.log('3. B and C keep syncing after A disappears...');
  procs[0].kill();
  await sleep(500);
  fs.writeFileSync(path.join(C, 'from-c.txt'), 'c says hi\n');
  await until(() => fs.existsSync(path.join(B, 'from-c.txt')), 'C -> B without A');

  console.log('4. A wrong token finds nothing...');
  fs.mkdirSync(path.join(sandbox, 'X'));
  assert.throws(() => cli(['join', 'auto', '--token', 'wrong'], path.join(sandbox, 'X')), (e) => /no nearby device/.test(String(e.stderr)));

  console.log('\nAll discovery tests passed successfully! [4/4]');
} finally {
  for (const p of procs) p.kill();
  await sleep(300);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
