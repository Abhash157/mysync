// Finds the conflict markers sync leaves in a note, draws the two versions, and keeps the chosen one.
(() => {
  const START = /^<{7}(?: (.*?))?\r?\n?$/;
  const MID = /^={7}\r?\n?$/;
  const END = /^>{7}(?: (.*?))?\r?\n?$/;

  // Splits text into plain parts { text } and conflicts { older, newer, olderName, newerName, raw }.
  function parse(src) {
    const lines = src.split(/(?<=\n)/);
    const parts = [];
    let plain = '';
    const find = (re, from) => {
      for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
      return -1;
    };
    const name = (line, re) => (line.match(re)[1] || '').replace(/\s*\(mysync\)$/, '').replace(/^(OLDER|NEWER)( - )?/, '');
    for (let i = 0; i < lines.length; i++) {
      const mid = START.test(lines[i]) ? find(MID, i + 1) : -1;
      const end = mid < 0 ? -1 : find(END, mid + 1);
      if (end < 0) { plain += lines[i]; continue; }
      if (plain) parts.push({ text: plain });
      plain = '';
      parts.push({
        older: lines.slice(i + 1, mid),
        newer: lines.slice(mid + 1, end),
        olderName: name(lines[i], START),
        newerName: name(lines[end], END),
        raw: lines.slice(i, end + 1).join(''),
      });
      i = end;
    }
    if (plain) parts.push({ text: plain });
    return parts;
  }

  // Replaces the n-th conflict with the kept side(s).
  function resolve(src, n, keep) {
    let k = 0;
    return parse(src).map((p) => {
      if (!p.older) return p.text;
      if (k++ !== n) return p.raw;
      const kept = keep === 'older' ? p.older : keep === 'newer' ? p.newer : [...p.older, ...p.newer];
      return kept.join('');
    }).join('');
  }

  function render(parts) {
    const { esc } = window.md;
    const body = (lines) => (lines.length ? `<pre>${esc(lines.join('').replace(/\r?\n$/, ''))}</pre>` : '<div class="none">(removed)</div>');
    const side = (kind, label, who, lines) => `<div class="side ${kind}"><small>${label}${who ? ` · ${esc(who)}` : ''}</small>${body(lines)}</div>`;
    let n = 0;
    const html = parts.map((p) => {
      if (!p.older) return `<pre>${esc(p.text.replace(/\r?\n$/, ''))}</pre>`;
      const i = n++;
      const button = (keep, label) => `<button class="btn" data-keep="${keep}" data-n="${i}">${label}</button>`;
      return `<div class="clash">${side('older', 'Older', p.olderName, p.older)}${side('newer', 'Newer', p.newerName, p.newer)}<div class="row2">${button('older', 'Keep older')}${button('newer', 'Keep newer')}${button('both', 'Keep both')}</div></div>`;
    }).join('');
    return `<p class="intro">This note was changed on two devices. Choose what to keep, or <button class="btn" data-keep="edit">edit as text</button></p>${html}`;
  }

  window.conflicts = { parse, resolve, render };
})();
