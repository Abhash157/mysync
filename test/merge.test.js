import assert from 'node:assert';
import { merge3, hasConflictMarkers, decodeText } from '../src/merge.js';

const names = { older: 'desk', newer: 'laptop' };
const run = (base, a, b) => merge3(base, a, b, names);

// Different lines combine without a conflict.
assert.deepStrictEqual(run('a\nb\nc\nd\n', 'A\nb\nc\nd\n', 'a\nb\nc\nD\n'), { text: 'A\nb\nc\nD\n', conflicted: false });
// The same change on both sides is not a conflict.
assert.deepStrictEqual(run('a\nb\n', 'a\nB\n', 'a\nB\n'), { text: 'a\nB\n', conflicted: false });
// The same line changed differently stays in the file, older first.
const clash = run('a\nb\nc\n', 'a\ndesk\nc\n', 'a\nlaptop\nc\n');
assert.strictEqual(clash.text, 'a\n<<<<<<< OLDER - desk (mysync)\ndesk\n=======\nlaptop\n>>>>>>> NEWER - laptop (mysync)\nc\n');
assert(clash.conflicted && hasConflictMarkers(Buffer.from(clash.text)));
// No common ancestor, no final newline: shared lines stay outside the markers.
assert.strictEqual(
  run('', 'title\nx', 'title\ny').text,
  'title\n<<<<<<< OLDER - desk (mysync)\nx\n=======\ny\n>>>>>>> NEWER - laptop (mysync)\n',
);
// Windows line endings are preserved.
assert.strictEqual(run('a\r\n', 'b\r\n', 'c\r\n').text.split('\r\n').length, 6);
// Binary content is left for a conflict copy.
assert.strictEqual(decodeText(Buffer.from([80, 75, 0, 1])), null);
assert.strictEqual(decodeText(Buffer.from([0xff, 0xfe, 0x41])), null);

// Random edits: when only one side changes, the result is exactly that side; and
// two sides editing separate halves always combine.
let seed = 7;
const rand = (n) => (seed = (seed * 48271) % 2147483647) % n;
const edit = (lines) => {
  const out = [...lines];
  for (let i = rand(4); i >= 0; i--) out.splice(rand(out.length + 1), rand(3), ...Array.from({ length: rand(3) }, () => `${rand(5)}\n`));
  return out;
};
for (let i = 0; i < 2000; i++) {
  const base = Array.from({ length: rand(12) }, () => `${rand(5)}\n`);
  const next = edit(base).join('');
  assert.strictEqual(run(base.join(''), next, base.join('')).text, next);
  assert.strictEqual(run(base.join(''), base.join(''), next).text, next);

  const top = Array.from({ length: 1 + rand(8) }, () => `${rand(5)}\n`);
  const bottom = Array.from({ length: 1 + rand(8) }, () => `${rand(5)}\n`);
  const t = edit(top).join('');
  const b = edit(bottom).join('');
  const wall = 'w1\nw2\n';
  assert.deepStrictEqual(
    run(top.join('') + wall + bottom.join(''), t + wall + bottom.join(''), top.join('') + wall + b),
    { text: t + wall + b, conflicted: false },
  );
}

console.log('All merge tests passed successfully!');
