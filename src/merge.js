/**
 * Line-level three-way merge, like git: edits to different lines combine silently, and
 * edits to the same lines are kept inside the file between conflict markers.
 *
 * Everything here is deterministic: two devices merging the same pair of versions
 * must produce byte-identical files.
 */

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_EDITS = 3000; // beyond this a file is treated as rewritten

/** Marks the markers as ours, so a synced file that already contains git markers is not reported. */
export const MARKER_TAG = '(mysync)';
const MARKED = /^<{7} .*\(mysync\)\r?$/m;

/** True when the content still holds an unresolved conflict written by mysync. */
export function hasConflictMarkers(content) {
  return MARKED.test(content.toString('utf8'));
}

/** The text of a buffer, or null when it is binary or too large to merge line by line. */
export function decodeText(content) {
  if (content.length > MAX_TEXT_BYTES || content.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    return null;
  }
}

const splitLines = (text) => (text ? text.split(/(?<=\n)/) : []);

/** Myers diff. Returns changed regions as { start, end, from, to }: a[start,end) became b[from,to). */
function diffLines(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 && m === 0) return [];
  const whole = [{ start: head, end: head + n, from: head, to: head + m }];
  if (n === 0 || m === 0) return whole;

  const max = Math.min(n + m, MAX_EDITS);
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[head + x] === b[head + y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(max - d, max + d + 1));
  }
  if (found < 0) return whole;

  // Walk back through the trace collecting the lines both sides share.
  const matches = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]; // diagonals -(d-1)..(d-1)
    const at = (k) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const startX = down ? prevX : prevX + 1;
    while (x > startX) matches.push([--x, --y]);
    x = prevX;
    y = prevX - prevK;
  }
  while (x > 0 && y > 0) matches.push([--x, --y]);
  matches.reverse();
  matches.push([n, m]);

  const hunks = [];
  let ai = 0;
  let bi = 0;
  for (const [i, j] of matches) {
    if (i > ai || j > bi) hunks.push({ start: head + ai, end: head + i, from: head + bi, to: head + j });
    ai = i + 1;
    bi = j + 1;
  }
  return hunks;
}

const sameLines = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);

/** The lines one side has for base[start,end), given that side's hunks inside the range. */
function regionOf(base, side, hunks, start, end) {
  const out = [];
  let at = start;
  for (const hunk of hunks) {
    out.push(...base.slice(at, hunk.start), ...side.slice(hunk.from, hunk.to));
    at = hunk.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

/**
 * @param {string} baseText Common ancestor ('' when there is none).
 * @param {string} olderText
 * @param {string} newerText
 * @param {{ older?: string, newer?: string }} [names] Device names for the marker lines.
 * @returns {{ text: string, conflicted: boolean }}
 */
export function merge3(baseText, olderText, newerText, names = {}) {
  const base = splitLines(baseText);
  const older = splitLines(olderText);
  const newer = splitLines(newerText);
  const eol = /\r\n/.test(newerText) ? '\r\n' : '\n';

  const changes = [
    ...diffLines(base, older).map((h) => ({ ...h, side: 0 })),
    ...diffLines(base, newer).map((h) => ({ ...h, side: 1 })),
  ].sort((x, y) => x.start - y.start || x.end - y.end || x.side - y.side);

  const out = [];
  let at = 0;
  let conflicted = false;
  const label = (kind, name) => `${kind}${name ? ` - ${name}` : ''} ${MARKER_TAG}`;
  const closed = (lines) => (lines.length && !lines.at(-1).endsWith('\n') ? [...lines.slice(0, -1), lines.at(-1) + eol] : lines);

  for (let i = 0; i < changes.length; ) {
    const start = changes[i].start;
    let end = changes[i].end;
    const group = [changes[i++]];
    // Changes that overlap or touch must be decided together.
    while (i < changes.length && changes[i].start <= end) {
      end = Math.max(end, changes[i].end);
      group.push(changes[i++]);
    }
    out.push(...base.slice(at, start));
    at = end;

    const olderHunks = group.filter((h) => h.side === 0);
    const newerHunks = group.filter((h) => h.side === 1);
    const a = regionOf(base, older, olderHunks, start, end);
    const b = regionOf(base, newer, newerHunks, start, end);

    if (!olderHunks.length) out.push(...b);
    else if (!newerHunks.length || sameLines(a, b)) out.push(...a);
    else {
      // Lines both sides agree on stay outside the markers.
      let pre = 0;
      while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
      let post = 0;
      while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
      conflicted = true;
      out.push(
        ...a.slice(0, pre),
        `<<<<<<< ${label('OLDER', names.older)}${eol}`,
        ...closed(a.slice(pre, a.length - post)),
        `=======${eol}`,
        ...closed(b.slice(pre, b.length - post)),
        `>>>>>>> ${label('NEWER', names.newer)}${eol}`,
        ...a.slice(a.length - post),
      );
    }
  }
  out.push(...base.slice(at));
  return { text: out.join(''), conflicted };
}
