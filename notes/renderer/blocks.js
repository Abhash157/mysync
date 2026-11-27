// Editing helpers for tables and lists. They work on arrays of lines and touch no DOM.
(() => {
  const TABLE = /^\s*\|/;
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const isRule = (row) => row.every((c) => /^:?-+:?$/.test(c));
  const columnAt = (line, ch) => Math.max(0, (line.slice(0, ch).match(/(?<!\\)\|/g) || []).length - 1);

  // Applies `action` to the table around line `i`, with the caret at column `ch`, and re-aligns it.
  // Returns { start, end, out, line, from, to }: lines [start, end) become `out`, and the caret
  // selects [from, to) of out[line].
  function table(lines, i, ch, action) {
    if (!TABLE.test(lines[i] || '')) return null;
    let start = i, end = i + 1;
    while (start > 0 && TABLE.test(lines[start - 1])) start--;
    while (end < lines.length && TABLE.test(lines[end])) end++;

    const indent = lines[start].match(/^\s*/)[0];
    const rows = lines.slice(start, end).map(cells);
    let r = i - start;
    let c = columnAt(lines[i], ch);
    let n = Math.max(...rows.map((x) => x.length));
    for (const row of rows) while (row.length < n) row.push('');
    if (rows.length < 2 || !isRule(rows[1])) {
      rows.splice(1, 0, Array(n).fill('---'));
      if (r > 0) r++;
    }
    c = Math.min(c, n - 1);
    const blank = () => Array(n).fill('');
    const addRow = (at) => rows.splice(at, 0, blank());

    if (action === 'next') {
      if (++c >= n) { c = 0; r++; }
      if (r === 1) r = 2;
      if (r >= rows.length) addRow(r);
    } else if (action === 'prev') {
      if (--c < 0) { c = n - 1; r--; }
      if (r === 1) r = 0;
      if (r < 0) { r = 0; c = 0; }
    } else if (action === 'enter') {
      // Enter on an empty last row leaves the table.
      if (r >= 2 && r === rows.length - 1 && rows[r].every((x) => !x)) {
        return { start: i, end: i + 1, out: [''], line: 0, from: 0, to: 0 };
      }
      r = Math.max(r + 1, 2);
      if (r >= rows.length) addRow(r);
    } else if (action === 'rowBelow') {
      r = Math.max(r + 1, 2);
      addRow(r);
    } else if (action === 'delRow') {
      if (r >= 2) { rows.splice(r, 1); r = Math.min(r, rows.length - 1); if (r === 1) r = 0; }
    } else if (action === 'colRight') {
      c++;
      n++;
      rows.forEach((row, k) => row.splice(c, 0, k === 1 ? '---' : ''));
    } else if (action === 'delCol' && n > 1) {
      rows.forEach((row) => row.splice(c, 1));
      n--;
      c = Math.min(c, n - 1);
    }

    const widths = Array.from({ length: n }, (_, k) => Math.max(3, ...rows.map((row, j) => (j === 1 ? 0 : row[k].length))));
    const rule = (cell, w) => {
      const left = cell.startsWith(':'), right = cell.endsWith(':') && cell.length > 1;
      return (left ? ':' : '') + '-'.repeat(w - left - right) + (right ? ':' : '');
    };
    const out = rows.map((row, j) => `${indent}| ${row.map((cell, k) => (j === 1 ? rule(cell, widths[k]) : cell.padEnd(widths[k]))).join(' | ')} |`);
    const from = indent.length + 2 + widths.slice(0, c).reduce((sum, w) => sum + w + 3, 0);
    return { start, end, out, line: r, from, to: from + (r === 1 ? 0 : rows[r][c].length) };
  }

  const ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)/;

  // Renumbers the ordered items of the list containing line `i`. Nested lists start at 1.
  function renumber(lines, i) {
    const inList = (l) => l !== undefined && (ITEM.test(l) || /^\s+\S/.test(l));
    if (!inList(lines[i])) return lines;
    let start = i, end = i + 1;
    while (inList(lines[start - 1])) start--;
    while (inList(lines[end])) end++;
    const out = lines.slice();
    const next = []; // [indent, following number]
    for (let k = start; k < end; k++) {
      const m = out[k].match(ITEM);
      if (!m) continue;
      const depth = m[1].replace(/\t/g, '    ').length;
      while (next.length && next[next.length - 1][0] > depth) next.pop();
      const top = next[next.length - 1];
      const same = top && top[0] === depth;
      if (m[2]) { if (same) next.pop(); continue; }
      const num = same ? top[1] : top ? 1 : +m[3];
      if (same) top[1] = num + 1;
      else next.push([depth, num + 1]);
      out[k] = `${m[1]}${num}${m[4]}${m[5]}${out[k].slice(m[0].length)}`;
    }
    return out;
  }

  window.blocks = { table, renumber, TABLE };
})();
