import assert from 'node:assert';
import { fold, COPY } from '../src/fold.js';

const block = (older, newer) => `<<<<<<< OLDER - conflict copy (mysync)\n${older}=======\n${newer}>>>>>>> NEWER - current note (mysync)\n`;

assert.strictEqual('Plan.conflict-91dc097.md'.match(COPY)[1], 'Plan');
assert.strictEqual(fold('a\nb\n', ['a\nb\n']), 'a\nb\n');
assert.strictEqual(fold('a\nnew\nc\n', ['a\nold\nc\n']), `a\n${block('old\n', 'new\n')}c\n`);
// Lines only the note has, and empty to-dos in a copy, need no choice.
assert.strictEqual(fold('- [ ] milk\n- [ ] eggs\n', ['- [ ] \n']), '- [ ] milk\n- [ ] eggs\n');
// Several copies of the same place become one block, never nested ones.
assert.strictEqual(fold('t\nnow\n', ['t\none\n', 't\ntwo\n', 't\none\n']), `t\n${block('one\ntwo\n', 'now\n')}`);
// Text only a copy has is offered back.
assert.strictEqual(fold('a\nc\n', ['a\nb\nc\n']), `a\n${block('b\n', '')}c\n`);
assert.ok(fold('a\r\nx\r\n', ['a\r\ny\r\n']).split('\r\n').length > 5);

console.log('notes fold: ok');
