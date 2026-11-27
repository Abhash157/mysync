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
  // first run: seeded vault, welcome note open for editing with working to-dos
  assert.ok(fs.existsSync(path.join(vault, 'Welcome.md')));
  await page.waitForSelector('#ed .cm-check');
  assert.equal(await page.locator('#ed .cm-check').count(), 3);
  assert.equal(await page.locator('#ed .cm-table').count(), 1);
  await page.screenshot({ path: path.join(shots, '1-welcome.png') });

  // tick a box -> written to the file
  await page.locator('#ed .cm-check').first().click();
  await until(() => /- \[x\] Try ticking/.test(file('Welcome.md')), 'checkbox saved');

  // new note, name it, type a to-do list with auto-continue
  await page.keyboard.press('Control+n');
  await page.waitForSelector('#title:focus');
  await page.keyboard.type('Groceries');
  await page.keyboard.press('Enter');
  await until(() => fs.existsSync(path.join(vault, 'Groceries.md')), 'renamed on disk');
  await page.waitForSelector('#ed .cm-content:focus');
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

  // a synced conflict shows both versions and one click keeps the chosen one
  fs.writeFileSync(path.join(vault, 'Groceries.md'), 'top\n<<<<<<< OLDER - desk (mysync)\nmilk\n=======\noat milk\n>>>>>>> NEWER - laptop (mysync)\nend\n');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('focus'));
  await page.waitForSelector('#merge .clash');
  assert.equal(await page.locator('#merge .older pre').textContent(), 'milk');
  assert.equal(await page.locator('#merge .newer pre').textContent(), 'oat milk');
  await page.screenshot({ path: path.join(shots, '4-conflict.png') });
  await page.locator('[data-keep=newer]').click();
  await until(() => file('Groceries.md') === 'top\noat milk\nend\n', 'conflict resolved on disk');
  assert.equal(await page.locator('#merge').isVisible(), false);

  // live preview: the note is formatted where you type, and to-dos tick in place
  await page.locator('[data-act=files]').first().click();
  await page.keyboard.press('Control+n');
  await page.waitForSelector('#title:focus');
  await page.keyboard.type('Plan');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#ed .cm-content:focus');
  await page.keyboard.type('# Plan\n- [ ] ship\n\n');
  await page.waitForSelector('#ed .cm-check');
  assert.equal(await page.locator('#view').isVisible(), false);
  assert.equal(await page.locator('#ed .cm-h1').textContent(), 'Plan'); // the # is hidden
  await page.locator('#ed .cm-check').click();
  await until(() => file('Plan.md').includes('- [x] ship'), 'ticked in live preview');
  await page.keyboard.press('Control+z');
  await until(() => file('Plan.md').includes('- [ ] ship'), 'tick undone');
  await page.locator('#ed .cm-check').click();

  // table: typed header, Tab builds and aligns it
  await page.locator('#ed .cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('| Name | Qty');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Apples');
  await page.keyboard.press('Tab');
  await page.keyboard.type('3');
  await until(() => file('Plan.md').includes('| Apples | 3'), 'table saved');
  assert.ok(file('Plan.md').includes('| Name   | Qty |\n| ------ | --- |'));
  assert.equal(await page.locator('#ed .cm-table td').count(), 2);
  // editing a cell rewrites the markdown
  await page.locator('#ed .cm-table td').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' | pears');
  await until(() => file('Plan.md').includes('| Apples \\| pears | 3'), 'cell edit saved');
  for (let i = 0; i < 8; i++) await page.keyboard.press('Backspace');
  await until(() => /\| Apples +\| 3/.test(file('Plan.md')), 'cell edit reverted');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#ed .cm-content:focus');

  // command palette, ordered list renumbering, callout, highlight and tag
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. one\ntwo');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('middle');
  await until(() => file('Plan.md').includes('1. one\n2. middle\n3. two'), 'list renumbered');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+p');
  await page.keyboard.type('callout');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Heads up');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n==hot== #urgent [[Ideas]]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#ed .cm-callout-title.note');
  assert.equal(await page.locator('#ed .cm-callout-title').textContent(), 'Heads up');
  assert.equal(await page.locator('#ed .cm-mark').textContent(), 'hot');
  assert.equal(await page.locator('#ed .cm-tag').textContent(), '#urgent');
  assert.equal(await page.locator('#ed .cm-wl').textContent(), 'Ideas');
  await page.screenshot({ path: path.join(shots, '5-live-preview.png') });

  // outline and backlinks
  await page.locator('[data-act=outline]').click();
  await until(async () => (await page.locator('#outline .row').first().textContent()) === 'Plan', 'outline lists headings');
  await page.locator('#ed .cm-wl').click();
  await until(async () => (await page.locator('#outline .row[data-p="Plan.md"]').count()) === 1, 'backlink listed');
  await page.screenshot({ path: path.join(shots, '6-outline.png') });

  // source mode shows the plain markdown
  await page.locator('.tab', { hasText: 'Plan' }).click();
  await page.keyboard.press('Control+Shift+E');
  assert.equal(await page.locator('#ed .cm-check, #ed .cm-table').count(), 0);
  assert.ok((await page.locator('#ed .cm-content').textContent()).includes('- [x] ship'));
  await page.keyboard.press('Control+Shift+E');
  await page.waitForSelector('#ed .cm-table');

  // conflict copies from older versions are folded into the note and removed
  fs.writeFileSync(path.join(vault, 'Trip.md'), 'go\nmonday\n');
  fs.writeFileSync(path.join(vault, 'Trip.conflict-91dc097.md'), 'go\nsunday\n');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('focus'));
  await until(() => !fs.existsSync(path.join(vault, 'Trip.conflict-91dc097.md')), 'copy removed');
  assert.match(file('Trip.md'), /OLDER - conflict copy \(mysync\)\nsunday\n=======\nmonday\n>>>>>>>/);

  // check for updates (GitHub and the dialog are stubbed)
  await app.evaluate(({ net, dialog, shell }) => {
    net.fetch = async () => new Response(JSON.stringify([{ tag_name: 'notes-v99.0.0', html_url: 'https://github.com/x/y' }]));
    dialog.showMessageBox = async () => ({ response: 0 });
    shell.openExternal = async (url) => { globalThis.opened = url; };
  });
  await page.locator('[data-act=update]').click();
  await until(async () => (await app.evaluate(() => globalThis.opened)) === 'https://github.com/x/y', 'download page opened');
  await app.evaluate(({ net }) => { net.fetch = async () => new Response('[]'); });
  await page.locator('[data-act=update]').click();
  await until(async () => /is up to date/.test(await page.locator('#toast').textContent()), 'up to date');

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
