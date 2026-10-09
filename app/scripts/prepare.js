// Copies the sync engine (../src) into app/engine so the app is self-contained when packaged,
// and generates icons if they are missing. Runs before start / pack / dist / test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const srcDir = path.resolve(appDir, '..', 'src');
const outDir = path.join(appDir, 'engine');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const file of fs.readdirSync(srcDir)) {
  if (file.endsWith('.js')) fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
}
// So the copied .js files load as ES modules wherever the app is installed.
fs.writeFileSync(path.join(outDir, 'package.json'), '{ "type": "module" }\n');

if (!fs.existsSync(path.join(appDir, 'build', 'icon.ico'))) {
  spawnSync(process.execPath, [path.join(here, 'make-icons.js')], { stdio: 'inherit' });
}
// The window shows the logo as an image.
fs.copyFileSync(path.join(appDir, 'build', 'icon.png'), path.join(appDir, 'renderer', 'logo.png'));
console.log(`engine copied to ${outDir}`);
