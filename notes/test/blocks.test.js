// The table, list and markdown helpers, without a window.
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

const window = {};
const context = vm.createContext({ window });
for (const f of ['md.js', 'blocks.js']) vm.runInContext(fs.readFileSync(new URL(`../renderer/${f}`, import.meta.url), 'utf8'), context);
const { md, blocks } = window;
const plain = (x) => JSON.parse(JSON.stringify(x)); // arrays from the other context

// Tab in the last cell adds a row; Enter on an empty last row leaves the table.
let r = blocks.table(['| a | b |', '|:--|--:|', '| long value | 2 |'], 2, 15, 'next');
assert.deepStrictEqual(plain(r.out), ['| a          |   b |'.replace('|   b |', '| b   |'), '| :--------- | --: |', '| long value | 2   |', '|            |     |']);
assert.strictEqual(r.line, 3);
r = blocks.table(r.out, 3, 2, 'enter');
assert.deepStrictEqual(plain([r.start, r.end, r.out]), [3, 4, ['']]);
// Columns can be added and removed.
r = blocks.table(['| a | b |', '| --- | --- |'], 0, 2, 'colRight');
assert.strictEqual(r.out[0], '| a   |     | b   |');
assert.strictEqual(blocks.table(r.out, 0, r.from, 'delCol').out[0], '| a   | b   |');
assert.strictEqual(blocks.table(['plain'], 0, 0, 'next'), null);

// Ordered lists renumber, nested ones from 1; bullets are left alone.
assert.deepStrictEqual(
  plain(blocks.renumber(['3. a', '3. b', '   7. c', '9. d', '- e', '', '5. f'], 0)),
  ['3. a', '4. b', '   1. c', '5. d', '- e', '', '5. f'],
);

// Rendering.
const html = md.render('| A | B |\n|---|:-:|\n| 1 | x\\|y |\n\n> [!warning] Careful\n> body\n\n==hi== #tag/sub\n\n3. c');
assert(html.includes('<table><thead><tr><th>A</th><th class="center">B</th></tr></thead><tbody><tr><td>1</td><td class="center">x|y</td></tr></tbody></table>'));
assert(html.includes('<div class="callout warning"><div class="callout-title">Careful</div><p>body</p></div>'));
assert(html.includes('<mark>hi</mark>') && html.includes('data-tag="tag/sub"'));
assert(html.includes('<ol start="3">'));
// Note content never becomes markup.
assert(!md.render('| <img src=x> |\n|---|\n| <script> |\n\n> [!note] <b>').match(/<(img|script|b)\b/));
assert(!md.render('[#a](https://x.test) `#b` c#d').includes('data-tag="b"'));
assert.deepStrictEqual(plain(md.headings('# A\n```\n# no\n```\n## B')), [{ level: 1, text: 'A', line: 0 }, { level: 2, text: 'B', line: 4 }]);

console.log('notes blocks: ok');
