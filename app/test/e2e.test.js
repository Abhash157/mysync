// Drives the real MySync window (Electron) the way a person would, with a command-line
// peer on the other side. Screenshots land in test/shots/ for eyeballing.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const cliPath = path.resolve(appDir, '..', 'bin', 'cli.js');
const shotsDir = path.join(here, 'shots');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mysync-e2e-'));
const dirA = path.join(sandbox, 'Notes');
const dirB = path.join(sandbox, 'LaptopNotes');
const dirC = path.join(sandbox, 'Photos');
const dirD = path.join(sandbox, 'JoinedPhotos');
const dirCloud = path.join(sandbox, 'MyCloud');
const dirE = path.join(sandbox, 'CloudLaptop');
const dirF = path.join(sandbox, 'Recipes');
const dirG = path.join(sandbox, 'RecipesHere');
const dataDir = path.join(sandbox, 'appdata');

const env = {
  ...process.env,
  MYSYNC_APP_DATA: dataDir,
  MYSYNC_APP_TEST: '1',
  MYSYNC_ENGINE_PORT: '3091',
  MYSYNC_DISCOVERY_PORT: '41888',
  MYSYNC_GLOBAL_CONFIG: path.join(sandbox, 'global.json'),
  MYSYNC_AUTHOR_NAME: 'Laptop',
  MYSYNC_CLOUD_INTERVAL_MS: '1000',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
const cli = (args, cwd) => execFileSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8', stdio: 'pipe' });
const children = [];
const spawnCli = (args, cwd) => {
  const p = spawn(process.execPath, [cliPath, ...args], { cwd, env, stdio: 'ignore' });
  children.push(p);
  return p;
};

async function until(check, what, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      if (await check()) return;
    } catch (err) {
      last = err;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for: ${what}${last ? ` (${last.message})` : ''}`);
}

fs.rmSync(shotsDir, { recursive: true, force: true });
fs.mkdirSync(shotsDir, { recursive: true });
for (const d of [dirA, dirB, dirC, dirD, dirCloud, dirF]) fs.mkdirSync(d, { recursive: true });
fs.rmdirSync(dirB);
fs.rmdirSync(dirD);

let app = null;
let page = null;
const shot = (name) => page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
const text = () => page.locator('body').innerText();
const pickNext = (folder) =>
  app.evaluate(({ dialog }, p) => {
    globalThis.__pick = p;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__pick] });
  }, folder);

async function launch() {
  // MYSYNC_APP_EXE runs the packaged build (dist/win-unpacked/MySync.exe) instead of the source tree.
  const packaged = process.env.MYSYNC_APP_EXE;
  app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { executablePath: electronPath, args: [appDir], env });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.waitForLoadState('domcontentloaded');
}

console.log('Running MySync app end-to-end test suite...\n');

try {
  await launch();

  console.log('1. First run shows a welcome step, then the empty state...');
  await page.getByText('Welcome to MySync').waitFor();
  await shot('01-onboarding');
  await page.fill('#ob-name', 'Desk PC');
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByRole('heading', { name: 'Keep your folders in sync' }).waitFor();
  await shot('02-welcome');

  console.log('2. Syncing a folder shows an invite code...');
  fs.writeFileSync(path.join(dirA, 'todo.txt'), 'buy milk\n');
  await pickNext(dirA);
  await page.getByRole('button', { name: /Sync a folder from this PC/ }).click();
  await page.getByRole('heading', { name: 'Now syncing “Notes”' }).waitFor();
  const code = (await page.locator('#invite-code').innerText()).trim();
  assert(code.startsWith('mys1.'), 'invite code is shown');
  await page.getByRole('button', { name: 'Copy' }).click();
  await page.getByText('Copied').waitFor();
  await shot('03-share');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByText('Not shared with another device yet').first().waitFor();
  await shot('04-folder-alone');

  console.log('3. A second device joins from the command line and edits flow both ways...');
  await until(() => exists(dirA, '.mysync/refs/heads/main'), 'first snapshot of the new folder');
  cli(['join', code, dirB, '--device', 'Laptop']);
  assert.strictEqual(read(dirB, 'todo.txt'), 'buy milk\n');
  spawnCli(['watch', '-p', '3092', '-i', '1'], dirB);
  await page.locator('.chip.ok', { hasText: 'Online' }).first().waitFor({ timeout: 30000 });
  await until(async () => (await text()).includes('Up to date'), 'status says up to date');
  fs.writeFileSync(path.join(dirB, 'from-laptop.txt'), 'hello desk\n');
  await until(() => exists(dirA, 'from-laptop.txt'), 'laptop -> desk');
  fs.writeFileSync(path.join(dirA, 'from-desk.txt'), 'hello laptop\n');
  await until(() => exists(dirB, 'from-desk.txt'), 'desk -> laptop');
  await page.getByText('Received changes').first().waitFor();
  await shot('05-folder-synced');

  console.log('4. A conflict is reported in the window, with both versions kept...');
  children.splice(0).forEach((p) => p.kill());
  await sleep(800);
  fs.writeFileSync(path.join(dirA, 'todo.txt'), 'desk version\n');
  await sleep(1300);
  fs.writeFileSync(path.join(dirB, 'todo.txt'), 'laptop version\n');
  spawnCli(['watch', '-p', '3092', '-i', '1'], dirB);
  await page.getByText('changed on two devices').first().waitFor({ timeout: 40000 });
  const both = (dir) => exists(dir, 'todo.txt') && ['<<<<<<<', 'desk version', 'laptop version'].every((s) => read(dir, 'todo.txt').includes(s));
  await until(() => both(dirA) && both(dirB), 'both devices hold both versions');
  await shot('06-conflict');

  console.log('5. Joining another folder from the window with a pasted code...');
  fs.writeFileSync(path.join(dirC, 'holiday.txt'), 'beach\n');
  cli(['init'], dirC);
  spawnCli(['watch', '-p', '3093', '-i', '1'], dirC);
  await until(() => {
    try { return cli(['invite', '-p', '3093'], dirC).includes('mys1.'); } catch { return false; }
  }, 'second workspace ready');
  const inviteC = cli(['invite', '-p', '3093'], dirC).match(/mys1\.\S+/)[0];
  await pickNext(dirD);
  await page.getByRole('button', { name: /Join a folder$/ }).first().click();
  await page.fill('#join-code', inviteC);
  await page.getByText('Invite code recognized').waitFor();
  await page.getByRole('button', { name: 'Change...' }).click();
  await until(async () => (await page.inputValue('#join-dest')) === dirD, 'destination chosen');
  await shot('07-join');
  await page.getByRole('button', { name: 'Join folder' }).click();
  await page.getByRole('heading', { name: 'JoinedPhotos' }).waitFor({ timeout: 30000 });
  await until(() => exists(dirD, 'holiday.txt'), 'files arrive in the joined folder');
  assert.strictEqual(read(dirD, 'holiday.txt'), 'beach\n');
  await shot('08-joined');

  console.log('6. A bad invite code gives a friendly message and leaves nothing behind...');
  const ghostDir = path.join(sandbox, 'ShouldNotExist');
  await pickNext(ghostDir);
  await page.getByRole('button', { name: /Join a folder$/ }).first().click();
  await page.fill('#join-code', 'mys1.AAAA');
  await page.getByText('does not look like a MySync invite code').waitFor();
  await page.getByRole('button', { name: 'Change...' }).click();
  await page.getByRole('button', { name: 'Join folder' }).click();
  await page.getByRole('alert').getByText(/not a valid mysync invite code/i).waitFor();
  assert(!fs.existsSync(ghostDir), 'no folder was created');
  await shot('09-join-error');
  await page.getByRole('button', { name: 'Cancel' }).click();

  console.log('7. Settings: rename this PC and connect an internet server...');
  const hubDir = path.join(sandbox, 'hubdata');
  spawnCli(['hub', 'serve', '-p', '3095', '-d', hubDir, '--secret', 'pw'], sandbox);
  await sleep(1200);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.fill('#set-device', 'Office PC');
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await page.getByText('Saved', { exact: true }).waitFor();
  await page.fill('#hub-url', 'http://127.0.0.1:3095');
  await page.fill('#hub-secret', 'pw');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save', exact: true }).nth(1).click();
  await page.getByText('Internet server saved').waitFor();
  await shot('10-settings');

  console.log('8. A folder can be put online and its code then includes the internet server...');
  await page.locator('.nav-item', { hasText: 'Notes' }).click();
  await page.getByRole('button', { name: 'Add another device' }).click();
  await page.fill('#pub-name', 'e2e-notes');
  await page.getByRole('button', { name: 'Put online' }).click();
  await page.getByText('also available over the internet as').waitFor({ timeout: 30000 });
  assert(fs.existsSync(path.join(hubDir, 'e2e-notes', '.mysync')), 'the hub stores the workspace');
  assert(!fs.existsSync(path.join(hubDir, 'e2e-notes', 'from-desk.txt')), 'the hub only keeps a bare copy');
  await shot('11-share-online');
  await page.getByRole('button', { name: 'Done' }).click();
  await until(async () => (await text()).includes('Internet server'), 'hub shows as a device');

  console.log('9. Cloud storage: connect a cloud folder, keep a folder in it, and join from it...');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect cloud storage' }).click();
  await page.getByRole('heading', { name: 'Connect cloud storage' }).waitFor();
  await pickNext(dirCloud);
  await page.getByRole('button', { name: 'Choose...' }).click();
  await page.getByText('Connected MyCloud').waitFor();
  await page.locator('.card', { hasText: 'Cloud storage' }).getByText('MyCloud', { exact: true }).waitFor();
  await shot('12-cloud-settings');

  await page.locator('.nav-item', { hasText: 'Notes' }).click();
  await page.getByRole('button', { name: 'Add another device' }).click();
  await page.fill('#cloud-name', 'e2e-cloud');
  await page.getByRole('button', { name: 'Keep in cloud' }).click();
  await page.getByText('Also kept in').waitFor({ timeout: 30000 });
  await shot('13-share-cloud');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('.row', { hasText: 'MyCloud' }).getByText('Connected', { exact: true }).waitFor({ timeout: 30000 });
  const cloudId = Object.keys(JSON.parse(fs.readFileSync(env.MYSYNC_GLOBAL_CONFIG, 'utf8')).cloud.accounts)[0];
  cli(['cloud', 'join', cloudId, 'e2e-cloud', dirE]);
  assert.strictEqual(read(dirE, 'from-desk.txt'), read(dirA, 'from-desk.txt'), 'another device gets the folder from the cloud');
  fs.writeFileSync(path.join(dirE, 'via-cloud.txt'), 'through the cloud\n');
  cli(['sync'], dirE);
  await until(() => exists(dirA, 'via-cloud.txt'), 'a change made through the cloud reaches the window');

  fs.writeFileSync(path.join(dirF, 'recipe.txt'), 'pancakes\n');
  cli(['init'], dirF);
  cli(['cloud', 'link', cloudId, 'e2e-recipes'], dirF);
  await pickNext(dirG);
  await page.getByRole('button', { name: /Join a folder$/ }).first().click();
  await page.getByRole('button', { name: 'From cloud storage' }).click();
  await page.getByText('e2e-recipes').waitFor();
  assert.strictEqual(await page.locator('input[name="cloud-ws"][value="e2e-cloud"]').count(), 0, 'folders already here are not offered');
  await page.getByRole('button', { name: 'Change...' }).click();
  await until(async () => (await page.inputValue('#join-dest')) === dirG, 'destination chosen');
  await shot('14-join-cloud');
  await page.getByRole('button', { name: 'Join folder' }).click();
  await page.getByRole('heading', { name: 'RecipesHere' }).waitFor({ timeout: 30000 });
  await until(() => exists(dirG, 'recipe.txt'), 'files arrive from the cloud');
  await page.locator('.nav-item', { hasText: 'Notes' }).click();

  console.log('10. Pausing stops changes in both directions until resumed...');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByText('Paused', { exact: true }).first().waitFor();
  fs.writeFileSync(path.join(dirB, 'while-paused.txt'), 'later\n');
  await sleep(3500);
  assert(!exists(dirA, 'while-paused.txt'), 'nothing arrives while paused');
  await shot('15-paused');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await until(() => exists(dirA, 'while-paused.txt'), 'arrives after resume');

  console.log('11. If the sync engine crashes it restarts by itself and syncing carries on...');
  await app.evaluate(({ app: electronApp }) => electronApp.mysyncTest.getHost().proc.kill());
  fs.writeFileSync(path.join(dirB, 'after-crash.txt'), 'still works\n');
  await until(() => exists(dirA, 'after-crash.txt'), 'syncing resumes after the engine restarts', 45000);
  await until(async () => (await page.locator('.nav-item', { hasText: 'Notes' }).innerText()).includes('Up to date'), 'status recovers');

  console.log('12. Stopping sync keeps the files...');
  await page.locator('.nav-item', { hasText: 'JoinedPhotos' }).click();
  await page.getByRole('button', { name: 'Stop syncing this folder' }).click();
  await page.getByText('Stop syncing “JoinedPhotos”?').waitFor();
  await shot('16-remove');
  await page.getByRole('button', { name: 'Stop syncing', exact: true }).click();
  await page.locator('.nav-item', { hasText: 'JoinedPhotos' }).waitFor({ state: 'detached' });
  assert(exists(dirD, 'holiday.txt'), 'files remain');

  console.log('13. After a restart, folders are remembered and a vanished folder is flagged, not re-created...');
  await app.close();
  children.splice(0).forEach((p) => p.kill());
  fs.renameSync(dirA, `${dirA}-moved`);
  await sleep(1500);
  await launch();
  await page.locator('.nav-item', { hasText: 'Notes' }).waitFor({ timeout: 20000 });
  assert.strictEqual(await page.getByText('Welcome to MySync').count(), 0, 'no welcome step the second time');
  await page.getByText('This folder cannot be found').first().waitFor();
  assert(!fs.existsSync(dirA), 'the missing folder was not re-created');
  await shot('17-missing-folder');

  console.log('\nAll app end-to-end tests passed successfully! [13/13]');
} catch (err) {
  try { if (page) await shot('failure'); } catch { /* window may be gone */ }
  console.error(err);
  process.exitCode = 1;
} finally {
  try { await app?.close(); } catch { /* already closed */ }
  children.splice(0).forEach((p) => p.kill());
  await sleep(500);
  fs.rmSync(sandbox, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
