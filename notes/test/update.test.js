import assert from 'node:assert';
import { newer } from '../src/update.js';

const release = (tag_name, extra) => ({ tag_name, html_url: 'https://github.com/x/' + tag_name, ...extra });
const list = [release('app-v9.0.0'), release('notes-v0.2.0'), release('notes-v0.10.0'), release('notes-v1.0.0', { draft: true })];

assert.strictEqual(newer(list, '0.1.0').version, '0.10.0'); // numbers, not text; MySync and drafts skipped
assert.strictEqual(newer(list, '0.10.0'), null);
assert.strictEqual(newer([], '0.1.0'), null);

console.log('notes update: ok');
