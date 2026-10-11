// Two real MyNotes windows on one machine: A turns sync on and shows an invite code, B joins
// with it, and notes then flow both ways. Screenshots land in test/shots/.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mynotes-sync-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dirs = { A: path.join(sandbox, 'A-notes'), B: path.join(sandbox, 'B-notes') };
fs.mkdirSync(dirs.A);
fs.writeFileSync(path.join(dirs.A, 'Hello.md'), '# From A\n');

async function launch(name, port) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.resolve(here, '..')],
    env: {
      ...process.env,
      MYNOTES_USER_DATA: path.join(sandbox, name + '-data'),
      MYNOTES_VAULT: dirs[name],
      MYNOTES_ENGINE_PORT: String(port),
      MYSYNC_DISCOVERY_PORT: '41999',
      MYSYNC_GLOBAL_CONFIG: path.join(sandbox, name + '-global.json'),
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('#tree .row');
  return { app, page };
}
async function until(fn, what, ms = 40000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (await fn()) return; } catch {} await sleep(150); }
  throw new Error('timed out: ' + what);
}

const A = await launch('A', 3110);
const B = await launch('B', 3120);
try {
  // before sync is turned on the status says so, and no engine process exists yet
  assert.match(await A.page.locator('#syncBtn').textContent(), /Sync off/);

  // A: turn sync on, get an invite code
  await A.page.locator('#syncBtn').click();
  await A.page.locator('button', { hasText: 'Start syncing this folder' }).click();
  await until(async () => (await A.page.locator('#icode').inputValue()).length > 20, 'invite code shown');
  const code = await A.page.locator('#icode').inputValue();
  await A.page.screenshot({ path: path.join(shots, '4-sync-on.png') });
  await until(async () => /Not shared|Up to date|Syncing/.test(await A.page.locator('#syncBtn').textContent()), 'status in bar');
  await A.page.keyboard.press('Escape');

  // B: join with the code (its own seeded Welcome note must not clash)
  await B.page.locator('#syncBtn').click();
  await B.page.locator('button', { hasText: 'already sync notes' }).click();
  await B.page.locator('#jcode').fill(code);
  await until(async () => !(await B.page.locator('#jgo').isDisabled()), 'code accepted');
  await B.page.screenshot({ path: path.join(shots, '5-sync-join.png') });
  await B.page.locator('#jgo').click();
  await until(() => fs.existsSync(path.join(dirs.B, 'Hello.md')), 'A note arrived in B');
  assert.equal(fs.readFileSync(path.join(dirs.B, 'Hello.md'), 'utf8'), '# From A\n');
  await until(async () => (await B.page.locator('#tree .lbl').allTextContents()).includes('Hello'), 'B tree shows it');
  assert.ok(!fs.existsSync(path.join(dirs.B, 'Welcome.md')), 'untouched welcome note was not kept');

  // both directions
  fs.writeFileSync(path.join(dirs.A, 'Todo.md'), '- [ ] ship it\n');
  await until(() => fs.existsSync(path.join(dirs.B, 'Todo.md')), 'A -> B');
  fs.writeFileSync(path.join(dirs.B, 'Reply.md'), 'got it\n');
  await until(() => fs.existsSync(path.join(dirs.A, 'Reply.md')), 'B -> A');

  // the sync screen shows the other device as online
  await A.page.locator('#syncBtn').click();
  await until(async () => /online/.test(await A.page.locator('#sdyn').textContent()), 'peer online in A');
  await A.page.screenshot({ path: path.join(shots, '6-sync-status.png') });

  // stopping sync leaves the files and turns the indicator off
  await A.page.locator('button', { hasText: 'Stop syncing this folder' }).click();
  await A.page.locator('button', { hasText: 'Click again' }).click();
  await until(async () => /Sync off/.test(await A.page.locator('#syncBtn').textContent()), 'sync off after stop');
  assert.ok(fs.existsSync(path.join(dirs.A, 'Todo.md')));

  console.log('notes sync: ok');
} catch (err) {
  await A.page.screenshot({ path: path.join(shots, 'sync-failure-A.png') }).catch(() => {});
  await B.page.screenshot({ path: path.join(shots, 'sync-failure-B.png') }).catch(() => {});
  throw err;
} finally {
  await A.app.close().catch(() => {});
  await B.app.close().catch(() => {});
  fs.rmSync(sandbox, { recursive: true, force: true });
}
