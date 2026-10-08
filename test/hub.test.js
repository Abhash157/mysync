import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../bin/cli.js');
const sandbox = path.resolve(__dirname, 'sandbox_hub');
const [HUB, A, B, C] = ['hub', 'A', 'B', 'C'].map((n) => path.join(sandbox, n));
const env = {
  ...process.env,
  MYSYNC_AUTHOR_NAME: 'Test',
  MYSYNC_AUTHOR_EMAIL: 't@mysync.local',
  MYSYNC_GLOBAL_CONFIG: path.join(sandbox, 'global.json'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (args, cwd) => execFileSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8', stdio: 'pipe' });
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
const procs = [];
const spawnCli = (args, cwd) => {
  const p = spawn(process.execPath, [cliPath, ...args], { cwd, env, stdio: 'ignore' });
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
for (const d of [HUB, A, B, C]) fs.mkdirSync(d, { recursive: true });

console.log('Running mysync hub (remote) test suite...\n');

try {
  spawnCli(['hub', 'serve', '-p', '3061', '-d', path.join(HUB, 'data'), '--secret', 'hubsecret'], HUB);
  await until(async () => true, 'hub start');
  await until(() => { try { cli(['hub', 'show'], HUB); return true; } catch { return false; } }, 'cli ready');
  await sleep(800);

  console.log('1. Publishing without the hub secret is refused...');
  cli(['hub', 'set', 'http://127.0.0.1:3061'], A);
  cli(['init'], A);
  fs.writeFileSync(path.join(A, 'hello.txt'), 'hello from A\n');
  assert.throws(() => cli(['publish', 'proj'], A), (e) => /secret/.test(String(e.stderr)));

  console.log('2. Publish a workspace by name...');
  cli(['hub', 'set', 'http://127.0.0.1:3061', '--secret', 'hubsecret'], A);
  const out = cli(['publish', 'proj'], A);
  const code = out.match(/mysync join (mys1\.\S+)/)[1];
  assert(!exists(path.join(HUB, 'data', 'proj'), 'hello.txt'), 'hub keeps a bare copy, no working files');

  console.log('3. Another device joins with just the invite code (A is not running)...');
  cli(['join', code, 'B'], sandbox);
  assert.strictEqual(read(B, 'hello.txt'), 'hello from A\n');

  console.log('4. Live sync through the hub in both directions...');
  spawnCli(['watch', '--no-serve', '--no-discover', '-i', '1'], A);
  spawnCli(['watch', '--no-serve', '--no-discover', '-i', '1'], B);
  fs.writeFileSync(path.join(A, 'a-new.txt'), 'from A\n');
  await until(() => exists(B, 'a-new.txt'), 'A -> hub -> B');
  fs.writeFileSync(path.join(B, 'b-new.txt'), 'from B\n');
  await until(() => exists(A, 'b-new.txt'), 'B -> hub -> A');

  console.log('5. Join by workspace name only...');
  const token = JSON.parse(read(A, '.mysync/config.json')).token;
  cli(['hub', 'set', 'http://127.0.0.1:3061'], C);
  cli(['join', 'proj', 'C', '--token', token], sandbox);
  assert.strictEqual(read(C, 'b-new.txt'), 'from B\n');
  assert.throws(() => cli(['join', 'proj', 'X', '--token', 'wrong-token-wrong-token'], sandbox));

  console.log('6. A taken name is not hijacked...');
  const other = path.join(sandbox, 'other');
  fs.mkdirSync(other);
  cli(['hub', 'set', 'http://127.0.0.1:3061', '--secret', 'hubsecret'], other);
  cli(['init'], other);
  assert.throws(() => cli(['publish', 'proj'], other), (e) => /already taken/.test(String(e.stderr)));

  console.log('\nAll hub tests passed successfully! [6/6]');
} finally {
  for (const p of procs) p.kill();
  await sleep(300);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
