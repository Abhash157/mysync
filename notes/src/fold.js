// Older versions of sync kept the losing side of a conflict as a separate file,
// "name.conflict-1a2b3c4.md". This folds such copies back into "name.md" as red / green blocks.
//
// The note itself holds the newer text and the copies the older one. Lines only the note has are
// kept as they are; only places where a copy says something the note does not are marked.
// The result depends on the file contents alone, so devices folding the same files agree.

export const COPY = /^(.*)\.conflict-[0-9a-f]{7}\.md$/i;

// A blank line or an empty bullet / to-do holds nothing worth asking about.
const hollow = (line) => !line.replace(/^\s*(?:(?:[-*+>]|\d+[.)])\s*)?(?:\[[ xX]?\])?/, '').trim();
const key = (line) => line.trimEnd();

// Pairs of line numbers [i, j] that a and b have in common, in order.
function common(a, b) {
  const len = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      len[i][j] = key(a[i]) === key(b[j]) ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  const out = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (key(a[i]) === key(b[j])) out.push([i++, j++]);
    else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return out;
}

// Both lists in one, shared lines once.
function union(a, b) {
  const out = [];
  let i = 0, j = 0;
  for (const [x, y] of [...common(a, b), [a.length, b.length]]) {
    out.push(...a.slice(i, x), ...b.slice(j, y));
    if (x < a.length) out.push(a[x]);
    i = x + 1;
    j = y + 1;
  }
  return out;
}

/**
 * @param {string} current Text of the note.
 * @param {string[]} copies Texts of its conflict copies, in a fixed order.
 * @returns {string} The note, with a conflict block wherever a copy differs.
 */
export function fold(current, copies) {
  const eol = /\r\n/.test(current) ? '\r\n' : '\n';
  const split = (text) => (text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []);
  const note = split(current);

  // Every place a copy differs: note lines [start, end) against that copy's `lines`.
  const changes = [];
  copies.forEach((text, n) => {
    const old = split(text);
    let i = 0, j = 0;
    for (const [x, y] of [...common(note, old), [note.length, old.length]]) {
      const lines = old.slice(j, y);
      if (lines.some((l) => !hollow(l))) changes.push({ start: i, end: x, n, lines });
      i = x + 1;
      j = y + 1;
    }
  });
  if (!changes.length) return current;
  changes.sort((a, b) => a.start - b.start || a.end - b.end || a.n - b.n);

  const out = [];
  let at = 0;
  for (let k = 0; k < changes.length; ) {
    const { start } = changes[k];
    let { end } = changes[k];
    const group = [changes[k++]];
    while (k < changes.length && changes[k].start <= end) {
      end = Math.max(end, changes[k].end);
      group.push(changes[k++]);
    }
    // What each copy says for the whole region.
    const versions = [...new Set(group.map((c) => c.n))].sort((a, b) => a - b).map((n) => {
      const lines = [];
      let from = start;
      for (const c of group.filter((x) => x.n === n)) {
        lines.push(...note.slice(from, c.start), ...c.lines);
        from = c.end;
      }
      return [...lines, ...note.slice(from, end)];
    });
    out.push(
      ...note.slice(at, start),
      '<<<<<<< OLDER - conflict copy (mysync)',
      ...versions.reduce(union),
      '=======',
      ...note.slice(start, end),
      '>>>>>>> NEWER - current note (mysync)',
    );
    at = end;
  }
  out.push(...note.slice(at));
  return out.join(eol) + (/\n$/.test(current) ? eol : '');
}
