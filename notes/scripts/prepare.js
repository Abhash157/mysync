// Copies the sync engine and its host process out of the MySync project so the notes app is
// self-contained when packaged. Runs before start / pack / dist / test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const engineSrc = path.resolve(root, '..', 'src');
const hostSrc = path.resolve(root, '..', 'app', 'src');

fs.rmSync(path.join(root, 'engine'), { recursive: true, force: true });
fs.rmSync(path.join(root, 'host'), { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'engine'), { recursive: true });
fs.mkdirSync(path.join(root, 'host'), { recursive: true });

for (const f of fs.readdirSync(engineSrc)) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(engineSrc, f), path.join(root, 'engine', f));
}
fs.writeFileSync(path.join(root, 'engine', 'package.json'), '{ "type": "module" }\n');
for (const f of ['engine-host.mjs', 'host-client.js']) fs.copyFileSync(path.join(hostSrc, f), path.join(root, 'host', f));
fs.writeFileSync(path.join(root, 'host', 'package.json'), '{ "type": "module" }\n');
console.log('engine copied');
