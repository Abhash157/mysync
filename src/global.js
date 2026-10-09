import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Per-user settings shared by every workspace on this machine (e.g. the default hub). */
function globalPath() {
  return process.env.MYSYNC_GLOBAL_CONFIG || path.join(os.homedir(), '.mysync-global.json');
}

export function readGlobal() {
  try {
    return JSON.parse(fs.readFileSync(globalPath(), 'utf8'));
  } catch {
    return {};
  }
}

export function writeGlobal(data) {
  fs.writeFileSync(globalPath(), JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** @returns {{ url: string, secret?: string }|null} */
export function getDefaultHub() {
  return readGlobal().hub || null;
}

export function setDefaultHub(url, secret = null) {
  const data = readGlobal();
  data.hub = { url: url.replace(/\/+$/, '') };
  if (secret) data.hub.secret = secret;
  writeGlobal(data);
}

export function clearDefaultHub() {
  const data = readGlobal();
  delete data.hub;
  writeGlobal(data);
}
