import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  version: 1,
  deviceName: null,
  onboarded: false,
  autoStart: true,
  trayHintShown: false,
  folders: [],
};

/** Tiny JSON settings file. Writes are atomic so a crash never leaves it half-written. */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS, folders: [] };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        ...DEFAULTS,
        ...parsed,
        folders: Array.isArray(parsed.folders)
          ? parsed.folders.filter((f) => f && typeof f.root === 'string').map((f) => ({ root: f.root, paused: !!f.paused }))
          : [],
      };
    } catch {
      // First run, or an unreadable file: start from defaults.
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  hasFolder(root) {
    return this.data.folders.some((f) => f.root === root);
  }

  addFolder(root) {
    if (!this.hasFolder(root)) {
      this.data.folders.push({ root, paused: false });
      this.save();
    }
  }

  removeFolder(root) {
    this.data.folders = this.data.folders.filter((f) => f.root !== root);
    this.save();
  }

  setPaused(root, paused) {
    const folder = this.data.folders.find((f) => f.root === root);
    if (folder) {
      folder.paused = !!paused;
      this.save();
    }
  }
}
