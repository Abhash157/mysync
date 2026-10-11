// Three real MyNotes windows on one machine.
//   A (Desktop) turns sync on.
//   B (Laptop) finds A on the network, asks to join, A clicks Allow: no code is copied anywhere.
//   C (Tablet) is declined once, then joins with the invite code (the fallback for other networks).
// Screenshots land in test/shots/.
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

const dirs = { A: path.join(sandbox, 'A-notes'), B: path.join(sandbox, 'B-notes'), C: path.join(sandbox, 'C-notes') };
fs.mkdirSync(dirs.A);
fs.writeFileSync(path.join(dirs.A, 'Hello.md'), '# From A\n');
const names = { A: 'Desktop', B: 'Laptop', C: 'Tablet' };

async function launch(id, port) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.resolve(here, '..')],
    env: {
      ...process.env,
      MYNOTES_USER_DATA: path.join(sandbox, id + '-data'),
      MYNOTES_VAULT: dirs[id],
      MYNOTES_DEVICE_NAME: names[id],
      MYNOTES_ENGINE_PORT: String(port),
      MYSYNC_DISCOVERY_PORT: '41999',
      MYSYNC_GLOBAL_CONFIG: path.join(sandbox, id + '-global.json'),
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('#tree .row');
  return { app, page, id };
}
async function until(fn, what, ms = 40000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (await fn()) return; } catch {} await sleep(150); }
  throw new Error('timed out: ' + what);
}
// Electron keeps listing exited utility processes, so check the process itself is still alive.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const engines = async (x) => (await x.app.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.name === 'MySync engine').map((m) => m.pid))).filter(alive).length;
const text = (x, sel) => x.page.locator(sel).first().textContent();
const exists = (id, f) => fs.existsSync(path.join(dirs[id], f));
const read = (id, f) => fs.readFileSync(path.join(dirs[id], f), 'utf8');

const A = await launch('A', 3110);
const B = await launch('B', 3120);
const C = await launch('C', 3130);
const all = [A, B, C];
try {
  // sync is off, and nothing extra runs until it is needed
  assert.match(await text(A, '#syncBtn'), /Sync off/);
  assert.equal(await engines(A), 0, 'no sync engine process while sync is off');

  // A: turn sync on
  await A.page.locator('#syncBtn').click();
  await A.page.locator('button', { hasText: 'Start syncing this folder' }).click();
  await until(async () => (await A.page.locator('#icode').inputValue()).length > 20, 'invite code exists');
  const code = await A.page.locator('#icode').inputValue();
  await until(async () => /Not shared|Up to date|Syncing/.test(await text(A, '#syncBtn')), 'status in bar');
  await A.page.screenshot({ path: path.join(shots, '4-sync-on.png') });
  await A.page.keyboard.press('Escape');

  // B: the join screen lists A without anything being typed or pasted
  await B.page.locator('#syncBtn').click();
  await B.page.locator('button', { hasText: 'Join notes from another device' }).click();
  await B.page.locator('#near .devs > div', { hasText: 'Desktop' }).waitFor({ timeout: 30000 });
  assert.equal(await engines(B), 1, 'the engine runs while the join screen looks for devices');

  // closing the screen without joining switches the engine off again, and reopening finds A again
  await B.page.keyboard.press('Escape');
  await until(async () => (await engines(B)) === 0, 'engine stops when the join screen is closed');
  await B.page.locator('#syncBtn').click();
  await B.page.locator('button', { hasText: 'Join notes from another device' }).click();
  await B.page.locator('#near .devs > div', { hasText: 'Desktop' }).waitFor({ timeout: 30000 });
  await B.page.screenshot({ path: path.join(shots, '5-sync-nearby.png') });

  // B asks; A is shown a prompt with the same code and clicks Allow
  await B.page.locator('#near .devs > div', { hasText: 'Desktop' }).locator('button', { hasText: 'Join' }).click();
  await B.page.locator('#sbody .code').waitFor();
  const codeB = (await text(B, '#sbody .code')).trim();
  assert.match(codeB, /^\d{4}$/);
  await A.page.locator('#pair:not([hidden])').waitFor();
  assert.match(await text(A, '#pair'), /Laptop/);
  assert.equal((await text(A, '#pair .code')).trim(), codeB, 'both screens show the same code');
  await A.page.screenshot({ path: path.join(shots, '6-sync-allow.png') });
  await B.page.screenshot({ path: path.join(shots, '6-sync-wait.png') });
  await A.page.locator('#pair button[data-p=allow]').click();
  await A.page.locator('#pair').waitFor({ state: 'hidden' });

  await until(() => exists('B', 'Hello.md'), 'A note arrived in B');
  assert.equal(read('B', 'Hello.md'), '# From A\n');
  await until(async () => (await B.page.locator('#tree .lbl').allTextContents()).includes('Hello'), 'B tree shows it');
  assert.ok(!exists('B', 'Welcome.md'), 'untouched welcome note was not kept');
  assert.match(await text(B, '#syncBtn'), /Up to date|Syncing|Not shared/);

  // both directions
  fs.writeFileSync(path.join(dirs.A, 'Todo.md'), '- [ ] ship it\n');
  await until(() => exists('B', 'Todo.md'), 'A -> B');
  fs.writeFileSync(path.join(dirs.B, 'Reply.md'), 'got it\n');
  await until(() => exists('A', 'Reply.md'), 'B -> A');

  // the sync screen shows the other device as online
  await A.page.locator('#syncBtn').click();
  await until(async () => /online/.test(await text(A, '#sdyn')), 'peer online in A');
  await A.page.screenshot({ path: path.join(shots, '7-sync-status.png') });
  await A.page.keyboard.press('Escape');

  // C: declined by A ...
  await C.page.locator('#syncBtn').click();
  await C.page.locator('button', { hasText: 'Join notes from another device' }).click();
  await C.page.locator('#near .devs > div', { hasText: 'Desktop' }).locator('button', { hasText: 'Join' }).click();
  await A.page.locator('#pair:not([hidden])').waitFor();
  assert.match(await text(A, '#pair'), /Tablet/);
  await A.page.locator('#pair button[data-p=deny]').click();
  await until(async () => /said no/.test(await text(C, '#sbody')), 'C is told no');
  await C.page.screenshot({ path: path.join(shots, '8-sync-declined.png') });
  assert.ok(!exists('C', 'Hello.md'), 'a declined device gets nothing');

  // ... and joins with the invite code instead
  await C.page.locator('button', { hasText: 'Back' }).click();
  await C.page.locator('summary', { hasText: 'invite code' }).click();
  await C.page.locator('#jcode').fill(code);
  await until(async () => !(await C.page.locator('#jgo').isDisabled()), 'code accepted');
  await C.page.locator('#jgo').click();
  await until(() => exists('C', 'Hello.md'), 'code join works');
  assert.equal(await engines(C), 1, 'and the engine stays on once sync is on');

  // stopping sync leaves the files, turns the indicator off and stops the engine
  await A.page.locator('#syncBtn').click();
  await A.page.locator('button', { hasText: 'Stop syncing this folder' }).click();
  await A.page.locator('button', { hasText: 'Click again' }).click();
  await until(async () => /Sync off/.test(await text(A, '#syncBtn')), 'sync off after stop');
  assert.ok(exists('A', 'Todo.md'));
  await until(async () => (await engines(A)) === 0, 'engine stopped');

  console.log('notes sync: ok');
} catch (err) {
  for (const x of all) await x.page.screenshot({ path: path.join(shots, `sync-failure-${x.id}.png`) }).catch(() => {});
  throw err;
} finally {
  for (const x of all) await x.app.close().catch(() => {});
  fs.rmSync(sandbox, { recursive: true, force: true });
}
