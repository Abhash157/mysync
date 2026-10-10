// Drives the real MyNotes window the way a person would. Screenshots land in test/shots/.
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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mynotes-e2e-'));
const vault = path.join(sandbox, 'vault');
const env = { ...process.env, MYNOTES_USER_DATA: path.join(sandbox, 'data'), MYNOTES_VAULT: vault };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = (f) => fs.readFileSync(path.join(vault, f), 'utf8');

async function launch() {
  const app = await electron.launch({ executablePath: electronPath, args: [path.resolve(here, '..')], env });
  const page = await app.firstWindow();
  await page.waitForSelector('#tree .row');
  return { app, page };
}
async function until(fn, what) {
  for (let i = 0; i < 60; i++) { if (await fn()) return; await sleep(100); }
  throw new Error('timed out: ' + what);
}

let { app, page } = await launch();
try {
  // first run: seeded vault, welcome note open in reading view with working to-dos
  assert.ok(fs.existsSync(path.join(vault, 'Welcome.md')));
  await page.waitForSelector('#view input[type=checkbox]');
  assert.equal(await page.locator('#view input[type=checkbox]').count(), 3);
  await page.screenshot({ path: path.join(shots, '1-welcome.png') });

  // tick a box in reading view -> written to the file
  await page.locator('#view input[type=checkbox]').first().click();
  await until(() => /- \[x\] Try ticking/.test(file('Welcome.md')), 'checkbox saved');

  // new note, name it, type a to-do list with auto-continue
  await page.keyboard.press('Control+n');
  await page.waitForSelector('#title:focus');
  await page.keyboard.type('Groceries');
  await page.keyboard.press('Enter');
  await until(() => fs.existsSync(path.join(vault, 'Groceries.md')), 'renamed on disk');
  await page.waitForSelector('#ed:focus');
  await page.keyboard.type('# Shopping\n');
  await page.keyboard.press('Control+l');
  await page.keyboard.type('milk\neggs\n\n\nplain text with ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('bold');
  await until(() => file('Groceries.md').endsWith('**bold**'), 'typed text saved');
  assert.equal(file('Groceries.md'), '# Shopping\n- [ ] milk\n- [ ] eggs\n\nplain text with **bold**');

  // reading view renders it; ticking updates the source
  await page.keyboard.press('Control+e');
  assert.equal(await page.locator('#view h1').textContent(), 'Shopping');
  await page.locator('#view input[type=checkbox]').nth(1).click();
  await until(() => file('Groceries.md').includes('- [x] eggs'), 'second box saved');
  await page.screenshot({ path: path.join(shots, '2-groceries.png') });

  // wikilink creates a missing note
  await page.keyboard.press('Control+e');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n[[Ideas]]');
  await page.keyboard.press('Control+e');
  await page.locator('#view a.wl').click();
  await until(() => fs.existsSync(path.join(vault, 'Ideas.md')), 'wikilink created note');
  await until(async () => (await page.locator('#title').inputValue()) === 'Ideas', 'wikilink opened note');

  // quick switcher + search
  await page.keyboard.press('Control+o');
  await page.keyboard.type('groc');
  await page.keyboard.press('Enter');
  await until(async () => (await page.locator('#title').inputValue()) === 'Groceries', 'switcher opened note');
  await page.keyboard.press('Control+Shift+f');
  await page.keyboard.type('eggs');
  await page.waitForSelector('#results .hit');
  assert.equal(await page.locator('#results .hit b').first().textContent(), 'Groceries');

  // folder via context menu, then delete goes away from the tree
  await page.keyboard.press('Control+\\');
  await page.keyboard.press('Control+\\');
  await page.locator('[data-act=files]').first().click();
  await page.locator('#tree').click({ button: 'right', position: { x: 100, y: 300 } });
  await page.locator('#menu div', { hasText: 'New folder' }).click();
  await page.waitForSelector('#tree input');
  await page.keyboard.type('Projects');
  await page.keyboard.press('Enter');
  await until(() => fs.existsSync(path.join(vault, 'Projects')), 'folder created');

  // external edit is picked up on refocus
  fs.writeFileSync(path.join(vault, 'Groceries.md'), '# Changed outside\n');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('focus'));
  await until(async () => (await page.locator('#view').textContent()).includes('Changed outside'), 'external change loaded');
  await page.screenshot({ path: path.join(shots, '3-final.png') });

  // tabs are restored after a restart
  await sleep(500);
  await app.close();
  ({ app, page } = await launch());
  await page.waitForSelector('.tab');
  assert.ok((await page.locator('.tab').count()) >= 2);

  console.log('notes e2e: ok');
} catch (err) {
  await page.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {});
  throw err;
} finally {
  await app.close().catch(() => {});
  fs.rmSync(sandbox, { recursive: true, force: true });
}
