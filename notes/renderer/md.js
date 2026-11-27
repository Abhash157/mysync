// A small markdown renderer: headings, emphasis, code, quotes, callouts, tables, lists, to-dos, tags, links and [[wikilinks]].
// Everything is HTML-escaped first, so note content can never inject markup.
(() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s, resolve) {
    const keep = [];
    const hold = (h) => '\u0000' + (keep.push(h) - 1) + '\u0000';
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, (_, c) => hold('<code>' + c + '</code>'));
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, alias) => {
      t = t.trim();
      return hold(`<a class="wl${resolve(t) ? '' : ' new'}" data-t="${t}">${alias || t}</a>`);
    });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, t, u) => hold(`<a href="${u}">${t}</a>`));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => p + hold(`<a href="${u}">${u}</a>`));
    s = s.replace(/(^|\s)#([\p{L}_\/-][\p{L}\p{N}_\/-]*)/gu, (_, p, t) => p + hold(`<a class="tag" data-tag="${t}">#${t}</a>`));
    s = s.replace(/==(.+?)==/g, '<mark>$1</mark>');
    s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => '<strong>' + (a || b) + '</strong>');
    s = s.replace(/\*([^*\s][^*]*?)\*/g, '<em>$1</em>');
    s = s.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Held pieces can sit inside one another (a tag inside a link), so restore until none are left.
    const restore = (x) => x.replace(/\u0000(\d+)\u0000/g, (_, i) => restore(keep[i]));
    return restore(s);
  }

  const LI = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
  const QUOTE = /^\s{0,3}>/;
  const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const FENCE = /^(```|~~~)/;
  const HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const blockStart = (l) => FENCE.test(l) || HEAD.test(l) || HR.test(l) || QUOTE.test(l) || LI.test(l);
  const RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const tableAt = (L, i, end) => i + 1 < end && L[i].includes('|') && L[i + 1].includes('|') && RULE.test(L[i + 1]);
  const CALLOUT = /^\[!([\w-]+)\][+-]?\s*(.*)$/;

  const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

  function table(L, i, end, resolve) {
    const align = cells(L[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : ''));
    const row = (line, tag) => {
      const parts = cells(line);
      return '<tr>' + align.map((a, k) => `<${tag}${a ? ` class="${a}"` : ''}>${inline(parts[k] || '', resolve)}</${tag}>`).join('') + '</tr>';
    };
    const head = cells(L[i]);
    while (align.length < head.length) align.push('');
    let j = i + 2;
    let body = '';
    while (j < end && L[j].trim() && L[j].includes('|')) body += row(L[j++], 'td');
    return [`<table><thead>${row(L[i], 'th')}</thead><tbody>${body}</tbody></table>`, j];
  }

  function list(items, k, resolve) {
    const base = items[k].ind;
    const tag = items[k].ord ? 'ol' : 'ul';
    let h = items[k].num > 1 ? `<${tag} start="${items[k].num}">` : `<${tag}>`;
    while (k < items.length && items[k].ind >= base) {
      const x = items[k++];
      let body = inline(x.txt, resolve);
      let cls = '';
      if (x.chk !== undefined) {
        const on = x.chk !== ' ';
        body = `<input type="checkbox" data-l="${x.idx}"${on ? ' checked' : ''}> <span>${body}</span>`;
        cls = ` class="task${on ? ' done' : ''}"`;
      }
      h += `<li${cls}>${body}`;
      if (k < items.length && items[k].ind > base) {
        const sub = list(items, k, resolve);
        h += sub[0];
        k = sub[1];
      }
      h += '</li>';
    }
    return [h + `</${tag}>`, k];
  }

  function blocks(L, i, end, resolve) {
    let out = '';
    while (i < end) {
      const ln = L[i];
      if (!ln.trim()) { i++; continue; }
      let m;
      if ((m = ln.match(FENCE))) {
        const buf = [];
        let j = i + 1;
        while (j < end && !L[j].startsWith(m[1])) buf.push(L[j++]);
        out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
        i = j + 1;
      } else if ((m = ln.match(HEAD))) {
        out += `<h${m[1].length} data-l="${i}">${inline(m[2], resolve)}</h${m[1].length}>`;
        i++;
      } else if (HR.test(ln)) {
        out += '<hr>';
        i++;
      } else if (QUOTE.test(ln)) {
        const Q = L.slice();
        let j = i;
        while (j < end && QUOTE.test(L[j])) { Q[j] = L[j].replace(/^\s{0,3}>\s?/, ''); j++; }
        const call = Q[i].match(CALLOUT);
        if (call) {
          const kind = call[1].toLowerCase();
          const title = call[2] || kind[0].toUpperCase() + kind.slice(1);
          out += `<div class="callout ${kind}"><div class="callout-title">${inline(title, resolve)}</div>${blocks(Q, i + 1, j, resolve)}</div>`;
        } else out += '<blockquote>' + blocks(Q, i, j, resolve) + '</blockquote>';
        i = j;
      } else if (tableAt(L, i, end)) {
        const [html, j] = table(L, i, end, resolve);
        out += html;
        i = j;
      } else if (LI.test(ln)) {
        const items = [];
        let j = i;
        while (j < end && (m = L[j].match(LI))) {
          items.push({ ind: m[1].replace(/\t/g, '    ').length, ord: /\d/.test(m[2]), num: parseInt(m[2], 10), chk: m[3], txt: m[4], idx: j });
          j++;
        }
        for (let k = 0; k < items.length; ) {
          const [h, next] = list(items, k, resolve);
          out += h;
          k = next;
        }
        i = j;
      } else {
        const buf = [ln];
        let j = i + 1;
        while (j < end && L[j].trim() && !blockStart(L[j]) && !tableAt(L, j, end)) buf.push(L[j++]);
        out += '<p>' + buf.map((x) => inline(x, resolve)).join('<br>') + '</p>';
        i = j;
      }
    }
    return out;
  }

  const render = (src, resolve = () => true) => {
    const L = src.replace(/\r\n?/g, '\n').split('\n');
    return blocks(L, 0, L.length, resolve);
  };

  // Flip the checkbox on line `n` of the source text.
  const toggle = (src, n) => {
    const L = src.split('\n');
    L[n] = L[n].replace(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/, (_, a, c, b) => a + (c === ' ' ? 'x' : ' ') + b);
    return L.join('\n');
  };

  // Headings with their line numbers, ignoring anything inside code fences.
  const headings = (src) => {
    const out = [];
    let fence = null;
    src.split('\n').forEach((l, n) => {
      l = l.replace(/\r$/, '');
      if (fence) { if (l.startsWith(fence)) fence = null; return; }
      const f = l.match(FENCE);
      if (f) { fence = f[1]; return; }
      const m = l.match(HEAD);
      if (m) out.push({ level: m[1].length, text: m[2], line: n });
    });
    return out;
  };

  window.md = { render, inline: (s, resolve = () => true) => inline(s, resolve), toggle, headings, esc };
})();
