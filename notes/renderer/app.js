(() => {
  const $ = (s) => document.querySelector(s);
  const api = window.api;
  const { esc } = window.md;

  const S = { vault: '', files: [], byName: new Map(), tabs: [], active: -1, open: new Set(), panel: 'files', side: true, sw: 260, preview: true };

  const P = {
    files: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
    folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    cloud: '<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 1 0 5 14.5 3.5 3.5 0 0 0 6.5 19z"/>',
    outline: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    command: '<path d="M4 17l6-5-6-5M12 19h8"/>',
    update: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    swap: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24">${P[k]}</svg>`;
  document.querySelectorAll('[data-i]').forEach((el) => (el.innerHTML = svg(el.dataset.i)));

  const base = (p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const cur = () => S.tabs[S.active];
  const modal = $('#modal'), mq = $('#mq');
  const view = $('#view'), title = $('#title'), pane = $('#pane'), merge = $('#merge');
  const ed = window.liveEditor.create($('#ed'), { resolve: (name) => resolveLink(name), follow: (link) => follow(link) });

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), 2600);
  }
  const guard = (fn) => async (...a) => {
    try { return await fn(...a); } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };

  // ---------------------------------------------------------------- files & tree

  function setFiles(files) {
    S.files = files;
    S.byName = new Map();
    for (const f of files) if (!f.d) {
      S.byName.set(base(f.p).toLowerCase(), f.p);
      S.byName.set(f.p.replace(/\.md$/i, '').toLowerCase(), f.p);
    }
    renderTree();
  }
  const refresh = async () => setFiles(await api.list());
  const resolveLink = (t) => S.byName.get(t.replace(/#.*$/, '').toLowerCase());

  function renderTree() {
    const root = { c: {} };
    for (const f of S.files) {
      let n = root;
      f.p.split('/').forEach((part, i, arr) => {
        const path = arr.slice(0, i + 1).join('/');
        n = n.c[part] ??= { n: part, p: path, d: i < arr.length - 1 || !!f.d, c: {} };
      });
    }
    const rows = (n, depth) => Object.values(n.c)
      .sort((a, b) => b.d - a.d || a.n.localeCompare(b.n, undefined, { numeric: true, sensitivity: 'base' }))
      .map((k) => {
        const open = S.open.has(k.p);
        const on = !k.d && cur() && cur().p === k.p;
        return `<div class="row${k.d ? ' dir' : ''}${on ? ' on' : ''}" data-p="${esc(k.p)}" data-d="${k.d ? 1 : 0}" style="padding-left:${6 + depth * 14}px">` +
          `<span class="chev${open ? ' o' : ''}">${k.d ? svg('chev') : ''}</span><span class="lbl">${esc(k.d ? k.n : k.n.replace(/\.md$/i, ''))}</span></div>` +
          (k.d && open ? rows(k, depth + 1) : '');
      }).join('');
    $('#tree').innerHTML = rows(root, 0) || '<div class="none">No notes yet. Press Ctrl+N.</div>';
  }

  $('#tree').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row || row.querySelector('input')) return;
    const p = row.dataset.p;
    if (row.dataset.d === '1') {
      S.open.has(p) ? S.open.delete(p) : S.open.add(p);
      renderTree();
      persist();
    } else openNote(p);
  });

  // ---------------------------------------------------------------- tabs & notes

  function renderTabs() {
    $('#tabs').innerHTML = S.tabs.map((t, i) =>
      `<div class="tab${i === S.active ? ' on' : ''}" data-i="${i}"><span class="t">${esc(base(t.p))}</span><span class="x">${svg('x')}</span></div>`).join('');
  }
  $('#tabs').addEventListener('mousedown', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const i = +tab.dataset.i;
    if (e.button === 1 || e.target.closest('.x')) { e.preventDefault(); closeTab(i); }
    else if (e.button === 0) activate(i);
  });

  async function openNote(p, line) {
    let i = S.tabs.findIndex((t) => t.p === p);
    if (i < 0) {
      const text = await api.read(p);
      S.tabs.push({ p, text, mode: 'edit', dirty: false });
      i = S.tabs.length - 1;
    }
    await activate(i);
    if (line != null) { cur().mode = 'edit'; show(); setCaret(line); }
  }
  const open = guard(openNote);

  async function activate(i) {
    await flush();
    S.active = i;
    for (let d = dirOf(cur().p); d; d = dirOf(d)) S.open.add(d);
    renderTabs();
    renderTree();
    show();
    persist();
  }

  async function closeTab(i) {
    if (i === S.active) await flush();
    const wasActive = i === S.active;
    S.tabs.splice(i, 1);
    if (!S.tabs.length) S.active = -1;
    else if (i < S.active) S.active--;
    else if (wasActive) S.active = Math.min(i, S.tabs.length - 1);
    renderTabs();
    renderTree();
    show();
    persist();
  }

  function show() {
    const t = cur();
    $('#page').hidden = !t;
    $('#empty').hidden = !!t;
    $('#stats').textContent = '';
    $('#mode').textContent = '';
    $('#previewBtn').hidden = true;
    drawOutline();
    if (!t) return;
    title.value = base(t.p);
    const parts = window.conflicts.parse(t.text);
    const clash = parts.some((x) => x.older);
    if (!clash) t.raw = false;
    const choosing = clash && !t.raw;
    $('#mode').textContent = choosing ? 'Resolving conflict' : t.mode === 'edit' ? 'Editing' : 'Reading';
    merge.hidden = !choosing;
    ed.hidden = choosing || t.mode !== 'edit';
    view.hidden = choosing || t.mode === 'edit';
    $('#previewBtn').hidden = choosing || t.mode !== 'edit';
    $('#previewBtn').classList.toggle('on', S.preview);
    $('#previewBtn').textContent = S.preview ? 'Live preview' : 'Source';
    if (choosing) {
      merge.innerHTML = window.conflicts.render(parts);
    } else if (t.mode === 'edit') {
      ed.setPreview(S.preview);
      ed.load(t.text);
      if (modal.hidden) ed.focus();
    }
    if (!view.hidden) drawView();
    stats();
  }

  function togglePreview() {
    const t = cur();
    if (!t) return;
    if (t.mode !== 'edit') { t.mode = 'edit'; S.preview = true; }
    else S.preview = !S.preview;
    show();
    persist();
  }
  $('#previewBtn').onclick = togglePreview;

  // Redraw the outline shortly after typing stops.
  let drawTimer;
  function redraw() {
    clearTimeout(drawTimer);
    drawTimer = setTimeout(drawOutline, 100);
  }

  function drawView() {
    const t = cur();
    const top = pane.scrollTop;
    const empty = 'Empty note. Double-click to edit.';
    view.innerHTML = window.md.render(t.text, resolveLink) || `<p style="color:var(--muted)">${empty}</p>`;
    pane.scrollTop = top;
  }

  function stats() {
    const t = cur();
    if (!t) return;
    const words = (t.text.match(/\S+/g) || []).length;
    $('#stats').textContent = `${words} word${words === 1 ? '' : 's'} · ${t.text.length} characters`;
  }

  function toggleMode() {
    const t = cur();
    if (!t) return;
    if (!merge.hidden) { t.raw = true; t.mode = 'edit'; }
    else if (t.raw) t.raw = false;
    else t.mode = t.mode === 'edit' ? 'read' : 'edit';
    show();
  }
  merge.addEventListener('click', (e) => {
    const b = e.target.closest('[data-keep]');
    if (!b) return;
    if (b.dataset.keep === 'edit') return toggleMode();
    const t = cur();
    t.text = window.conflicts.resolve(t.text, +b.dataset.n, b.dataset.keep);
    dirty();
    show();
  });
  $('#mode').onclick = toggleMode;
  view.addEventListener('dblclick', (e) => { if (cur().mode === 'read' && !e.target.closest('a, input')) toggleMode(); });

  // ---------------------------------------------------------------- saving

  let timer;
  function dirty() {
    const t = cur();
    t.dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  }
  async function flush() {
    clearTimeout(timer);
    for (const t of S.tabs) {
      if (!t.dirty) continue;
      t.dirty = false;
      try { await api.write(t.p, t.text); } catch (e) { t.dirty = true; toast('Could not save ' + base(t.p)); }
    }
  }
  addEventListener('beforeunload', flush);

  // ---------------------------------------------------------------- editor

  ed.onInput(() => { cur().text = ed.value; stats(); dirty(); redraw(); });
  $('#page').addEventListener('mousedown', (e) => {
    if (e.target === $('#page') && cur().mode === 'edit') { e.preventDefault(); ed.focus(); ed.setSelectionRange(ed.value.length); }
  });

  function setCaret(line) {
    const lines = ed.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line && i < lines.length; i++) pos += lines[i].length + 1;
    ed.focus();
    ed.setSelectionRange(pos, pos + (lines[line] || '').length);
    ed.reveal(pos);
  }

  const ins = (text) => { ed.focus(); ed.insert(text); };
  const replace = (a, b, text) => { ed.setSelectionRange(a, b); ins(text); };
  const lineStart = (pos) => ed.value.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = (pos) => { const i = ed.value.indexOf('\n', pos); return i < 0 ? ed.value.length : i; };
  const LIST = /^(\s*)(?:([-*+])|(\d+)([.)]))\s+(\[[ xX]\]\s+)?/;

  // The caret as { n: line number, ch: column }, plus the text split into lines.
  function where(pos = ed.selectionStart) {
    const before = ed.value.slice(0, pos).split('\n');
    return { lines: ed.value.split('\n'), n: before.length - 1, ch: before[before.length - 1].length };
  }
  const offset = (lines, n, ch) => lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0) + ch;

  function tableDo(action) {
    const { lines, n, ch } = where();
    const r = window.blocks.table(lines, n, ch, action);
    if (!r) return false;
    const from = offset(lines, r.start, 0), to = offset(lines, r.end - 1, lines[r.end - 1].length);
    const text = r.out.join('\n');
    if (ed.value.slice(from, to) !== text) replace(from, to, text);
    const at = offset(r.out, r.line, 0) + from;
    ed.setSelectionRange(at + r.from, at + r.to);
    ed.enterTable();
    return true;
  }

  function renumber() {
    const { lines, n, ch } = where();
    const out = window.blocks.renumber(lines, n);
    const changed = out.map((l, i) => i).filter((i) => out[i] !== lines[i]);
    if (!changed.length) return;
    const first = changed[0], last = changed[changed.length - 1];
    replace(offset(lines, first, 0), offset(lines, last, lines[last].length), out.slice(first, last + 1).join('\n'));
    const at = offset(out, n, Math.max(0, ch + out[n].length - lines[n].length));
    ed.setSelectionRange(at, at);
  }

  function moveLines(d) {
    const a = ed.selectionStart, b = ed.selectionEnd;
    const ls = lineStart(a), le = lineEnd(b);
    if (d < 0 ? ls === 0 : le === ed.value.length) return;
    const block = ed.value.slice(ls, le);
    const from = d < 0 ? lineStart(ls - 1) : ls;
    const to = d < 0 ? le : lineEnd(le + 1);
    const other = d < 0 ? ed.value.slice(from, ls - 1) : ed.value.slice(le + 1, to);
    replace(from, to, d < 0 ? `${block}\n${other}` : `${other}\n${block}`);
    const moved = d < 0 ? from : from + other.length + 1;
    ed.setSelectionRange(moved + (a - ls), moved + (b - ls));
  }

  // Adds `prefix` to every selected line, or takes it off again when all of them have it.
  function prefixLines(prefix, pattern) {
    const ls = lineStart(ed.selectionStart), le = lineEnd(ed.selectionEnd);
    const lines = ed.value.slice(ls, le).split('\n');
    const has = lines.every((l) => pattern.test(l));
    const out = lines.map((l, i) => {
      const bare = l.replace(/^(#{1,6}\s+|>\s?|\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/, '');
      return has ? bare : (typeof prefix === 'function' ? prefix(i) : prefix) + bare;
    }).join('\n');
    replace(ls, le, out);
  }

  function wrap(open, close = open) {
    const a = ed.selectionStart, b = ed.selectionEnd;
    ins(open + ed.value.slice(a, b) + close);
    if (a === b) ed.setSelectionRange(a + open.length, a + open.length);
  }

  // Puts a block on its own lines at the caret and selects `pick` inside it.
  function insertBlock(text, pick) {
    const a = ed.selectionStart;
    const before = ed.value.slice(0, a);
    const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    ins(lead + text + '\n');
    const at = a + lead.length + text.indexOf(pick);
    ed.setSelectionRange(at, at + pick.length);
  }

  const insertTable = () => { insertBlock('| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |', 'Column 1'); ed.enterTable(); };

  const editorKeys = (e) => {
    if (e.target.closest('.cm-table')) return; // table cells handle their own keys
    const c = e.ctrlKey || e.metaKey;
    const a = ed.selectionStart, b = ed.selectionEnd;

    if (e.altKey && !c && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveLines(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (!c && !e.altKey && !e.isComposing && window.blocks.TABLE.test(ed.value.slice(lineStart(a), lineEnd(a)))) {
      const action = e.key === 'Tab' ? (e.shiftKey ? 'prev' : 'next') : e.key === 'Enter' && !e.shiftKey && a > lineStart(a) ? 'enter' : null;
      if (action) { e.preventDefault(); tableDo(action); return; }
    }

    if (e.key === 'Enter' && !c && !e.shiftKey && !e.altKey && !e.isComposing && a === b) {
      const ls = lineStart(a);
      const m = ed.value.slice(ls, a).match(LIST);
      if (!m) return;
      e.preventDefault();
      if (!ed.value.slice(ls + m[0].length, lineEnd(a)).trim() && a === lineEnd(a)) { replace(ls, a, ''); return; }
      const marker = m[2] || `${+m[3] + 1}${m[4]}`;
      ins('\n' + m[1] + marker + ' ' + (m[5] ? '[ ] ' : ''));
      if (m[3]) renumber();
    } else if (e.key === 'Tab' && !c) {
      e.preventDefault();
      const ls = lineStart(a), le = lineEnd(b);
      const block = ed.value.slice(ls, le);
      if (a === b && !LIST.test(block) && !e.shiftKey) { ins('  '); return; }
      const out = block.split('\n').map((l) => (e.shiftKey ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l)).join('\n');
      replace(ls, le, out);
      if (a === b) { const p = Math.max(ls, a + out.length - block.length); ed.setSelectionRange(p, p); }
      else ed.setSelectionRange(ls, ls + out.length);
      if (a === b) renumber();
    } else if (c && !e.shiftKey && !e.altKey && 'bi'.includes(e.key.toLowerCase()) && e.key.length === 1) {
      e.preventDefault();
      wrap(e.key.toLowerCase() === 'b' ? '**' : '*');
    } else if (c && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      const ls = lineStart(a), le = lineEnd(a);
      const line = ed.value.slice(ls, le);
      let out;
      if (/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]\s?/.test(line)) {
        out = line.replace(/\[( |x|X)\]/, (_, ch) => (ch === ' ' ? '[x]' : '[ ]'));
      } else if (LIST.test(line)) {
        out = line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)/, '$1[ ] ');
      } else {
        out = line.replace(/^(\s*)/, '$1- [ ] ');
      }
      replace(ls, le, out);
    }
  };
  // Handled keys must not reach the editor (or the window shortcuts) as well.
  ed.dom.addEventListener('keydown', (e) => { editorKeys(e); if (e.defaultPrevented) e.stopPropagation(); }, true);

  // ---------------------------------------------------------------- reading view

  view.addEventListener('click', (e) => {
    const t = cur();
    const box = e.target.closest('input[type=checkbox]');
    if (box) {
      const top = pane.scrollTop;
      t.text = window.md.toggle(t.text, +box.dataset.l);
      dirty();
      drawView();
      pane.scrollTop = top;
      return;
    }
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains('tag')) follow({ tag: a.dataset.tag });
    else if (a.classList.contains('wl')) follow({ note: a.dataset.t });
    else follow({ url: a.getAttribute('href') });
  });

  function follow({ tag, note, url }) {
    if (tag) searchFor('#' + tag);
    else if (note) followLink(note);
    else api.external(url);
  }

  const followLink = guard(async (name) => {
    let p = resolveLink(name);
    if (!p) { p = await api.create('', name.replace(/#.*$/, '')); await refresh(); }
    await openNote(p);
  });

  // ---------------------------------------------------------------- title / rename

  async function renameItem(p, name) {
    const to = await api.rename(p, name);
    if (to === p) return to;
    for (const t of S.tabs) {
      if (t.p === p) t.p = to;
      else if (t.p.startsWith(p + '/')) t.p = to + t.p.slice(p.length);
    }
    for (const d of [...S.open]) if (d === p || d.startsWith(p + '/')) { S.open.delete(d); S.open.add(to + d.slice(p.length)); }
    await refresh();
    renderTabs();
    persist();
    return to;
  }

  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); if (cur().mode === 'edit' && !ed.hidden) ed.focus(); }
    if (e.key === 'Escape') { title.value = base(cur().p); title.blur(); }
  });
  title.addEventListener('change', guard(async () => {
    const t = cur();
    await flush();
    try { await renameItem(t.p, title.value); } catch (e) { title.value = base(t.p); throw e; }
    title.value = base(t.p);
  }));

  function inlineRename(row, onDone) {
    const lbl = row.querySelector('.lbl');
    const input = document.createElement('input');
    input.value = lbl.textContent;
    lbl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const end = async (commit) => {
      if (done) return;
      done = true;
      try {
        if (commit && input.value.trim() && input.value !== lbl.textContent) await renameItem(row.dataset.p, input.value);
      } catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
      renderTree();
      if (onDone) onDone();
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') end(true); if (e.key === 'Escape') end(false); };
    input.onblur = () => end(true);
    input.onclick = (e) => e.stopPropagation();
  }

  // ---------------------------------------------------------------- create / delete

  const newNote = guard(async (dir = '') => {
    if (dir) S.open.add(dir);
    const p = await api.create(dir, 'Untitled');
    await refresh();
    await openNote(p);
    cur().mode = 'edit';
    show();
    title.focus();
    title.select();
  });

  const newFolder = guard(async (dir = '') => {
    if (dir) S.open.add(dir);
    showPanel('files');
    const p = await api.mkdir(dir);
    S.open.add(p);
    await refresh();
    const row = [...document.querySelectorAll('#tree .row')].find((r) => r.dataset.p === p);
    if (row) inlineRename(row);
  });

  const remove = guard(async (p) => {
    for (let i = S.tabs.length - 1; i >= 0; i--) if (S.tabs[i].p === p || S.tabs[i].p.startsWith(p + '/')) { S.tabs[i].dirty = false; await closeTab(i); }
    await api.remove(p);
    await refresh();
  });

  // ---------------------------------------------------------------- context menu

  const menu = $('#menu');
  function showMenu(x, y, items) {
    menu.innerHTML = items.map((it, i) => `<div data-i="${i}"${it.danger ? ' class="danger"' : ''}>${it.label}</div>`).join('');
    menu.hidden = false;
    menu.style.left = Math.min(x, innerWidth - 180) + 'px';
    menu.style.top = Math.min(y, innerHeight - items.length * 30 - 12) + 'px';
    menu.onclick = (e) => {
      const el = e.target.closest('[data-i]');
      if (!el) return;
      menu.hidden = true;
      items[+el.dataset.i].run();
    };
  }
  addEventListener('mousedown', (e) => { if (!menu.contains(e.target)) menu.hidden = true; });

  $('#tree').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = e.target.closest('.row');
    if (!row) {
      showMenu(e.clientX, e.clientY, [{ label: 'New note', run: () => newNote('') }, { label: 'New folder', run: () => newFolder('') }]);
      return;
    }
    const p = row.dataset.p, isDir = row.dataset.d === '1';
    const items = [];
    if (isDir) items.push({ label: 'New note', run: () => newNote(p) }, { label: 'New folder', run: () => newFolder(p) });
    items.push({ label: 'Rename', run: () => inlineRename(row) });
    items.push({ label: 'Show in Explorer', run: () => api.reveal(p) });
    items.push({ label: 'Delete', danger: true, run: () => remove(p) });
    showMenu(e.clientX, e.clientY, items);
  });

  // ---------------------------------------------------------------- search & switcher

  function showPanel(name) {
    if (!S.side) toggleSide(true);
    S.panel = name;
    $('#filesPanel').hidden = name !== 'files';
    $('#searchPanel').hidden = name !== 'search';
    $('#outlinePanel').hidden = name !== 'outline';
    document.querySelectorAll('#ribbon [data-act=files],#ribbon [data-act=search],#ribbon [data-act=outline]').forEach((b) => b.classList.toggle('on', b.dataset.act === name));
    if (name === 'search') { $('#q').focus(); $('#q').select(); }
    drawOutline();
  }

  function searchFor(text) {
    showPanel('search');
    $('#q').value = text;
    $('#q').dispatchEvent(new Event('input'));
  }

  // Headings of the open note, and the notes that link to it.
  let outlineRun = 0;
  async function drawOutline() {
    if (S.panel !== 'outline' || !S.side) return;
    const run = ++outlineRun;
    const t = cur();
    if (!t) { $('#outline').innerHTML = '<div class="none">No note open</div>'; return; }
    const name = base(t.p).toLowerCase();
    const link = (l) => [...l.matchAll(/\[\[([^\]|#]+)/g)].some((m) => resolveLink(m[1].trim()) === t.p);
    const hits = (await api.search('[[')).filter((h) => h.p !== t.p);
    const named = (await api.search('[[' + name)).filter((h) => h.p !== t.p);
    if (run !== outlineRun) return;
    const from = [...new Map([...hits, ...named].filter((h) => h.lines.some((l) => link(l.t))).map((h) => [h.p, h])).values()];
    const heads = window.md.headings(t.text).map((h) => `<div class="row" data-l="${h.line}" style="padding-left:${6 + (h.level - 1) * 12}px"><span class="lbl">${esc(h.text)}</span></div>`).join('');
    const backs = from.map((h) => `<div class="row" data-p="${esc(h.p)}"><span class="lbl">${esc(base(h.p))}</span></div>`).join('');
    $('#outline').innerHTML = (heads || '<div class="none">No headings</div>') + '<h4>Backlinks</h4>' + (backs || '<div class="none">No notes link here</div>');
  }
  $('#outline').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (row.dataset.p) return open(row.dataset.p);
    const line = +row.dataset.l;
    if (!view.hidden) view.querySelector(`[data-l="${line}"]`)?.scrollIntoView({ block: 'start' });
    if (!ed.hidden) {
      const { lines } = where();
      const at = offset(lines, line, 0);
      ed.focus();
      ed.setSelectionRange(at, at + (lines[line] || '').length);
      ed.reveal(at);
    }
  });

  function toggleSide(force) {
    S.side = force ?? !S.side;
    document.body.classList.toggle('noside', !S.side);
    persist();
  }

  let qTimer;
  $('#q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(guard(async () => {
      const q = $('#q').value;
      const hits = await api.search(q);
      $('#results').innerHTML = !q.trim() ? '' : hits.length
        ? hits.map((h) => `<div class="hit" data-p="${esc(h.p)}" data-l="${h.lines[0] ? h.lines[0].n : ''}"><b>${esc(base(h.p))}</b>${h.lines.map((l) => `<small data-l="${l.n}">${esc(l.t)}</small>`).join('')}</div>`).join('')
        : '<div class="none">No results</div>';
    }), 180);
  });
  $('#results').addEventListener('click', (e) => {
    const hit = e.target.closest('.hit');
    if (!hit) return;
    const small = e.target.closest('small');
    const l = small ? small.dataset.l : hit.dataset.l;
    open(hit.dataset.p, l === '' || l == null ? undefined : +l);
  });

  // Commands that edit text switch to the editor first.
  const editing = (run) => () => {
    const t = cur();
    if (!t) return toast('Open a note first');
    if (t.mode !== 'edit' || ed.hidden) { t.mode = 'edit'; t.raw = true; show(); }
    ed.focus();
    run();
  };
  const inTable = (action) => editing(() => { if (!ed.cellAction(action) && !tableDo(action)) toast('Put the cursor in a table first'); });
  const COMMANDS = [
    ['Insert table', editing(insertTable)],
    ['Table: add row', inTable('rowBelow')],
    ['Table: add column', inTable('colRight')],
    ['Table: delete row', inTable('delRow')],
    ['Table: delete column', inTable('delCol')],
    ['Table: align', inTable('format')],
    ['To-do list', editing(() => prefixLines('- [ ] ', /^\s*[-*+]\s+\[[ xX]\]/))],
    ['Bullet list', editing(() => prefixLines('- ', /^\s*[-*+]\s+(?!\[[ xX]\])/))],
    ['Numbered list', editing(() => prefixLines((i) => `${i + 1}. `, /^\s*\d+[.)]\s/))],
    ['Heading 1', editing(() => prefixLines('# ', /^# /))],
    ['Heading 2', editing(() => prefixLines('## ', /^## /))],
    ['Heading 3', editing(() => prefixLines('### ', /^### /))],
    ['Quote', editing(() => prefixLines('> ', /^>/))],
    ['Callout', editing(() => insertBlock('> [!note] Title\n> Text', 'Title'))],
    ['Code block', editing(() => insertBlock('```\ncode\n```', 'code'))],
    ['Divider', editing(() => insertBlock('---', ''))],
    ['Bold', editing(() => wrap('**'))],
    ['Italic', editing(() => wrap('*'))],
    ['Strikethrough', editing(() => wrap('~~'))],
    ['Highlight', editing(() => wrap('=='))],
    ['Inline code', editing(() => wrap('`'))],
    ['Link to note', editing(() => wrap('[[', ']]'))],
    ['Move line up', editing(() => moveLines(-1))],
    ['Move line down', editing(() => moveLines(1))],
    ['Toggle live preview / source', () => togglePreview()],
    ['Toggle reading view', () => toggleMode()],
    ['Show outline and backlinks', () => showPanel('outline')],
    ['Search all notes', () => showPanel('search')],
    ['New note', () => newNote('')],
    ['New folder', () => newFolder('')],
    ['Check for updates', () => checkUpdate()],
  ];

  // Right-click in the editor offers the usual blocks.
  ed.dom.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const cell = e.target.closest('.cm-table th, .cm-table td');
    if (cell) cell.focus();
    const table = cell || window.blocks.TABLE.test(ed.value.slice(lineStart(ed.selectionStart), lineEnd(ed.selectionStart)));
    const names = table
      ? ['Table: add row', 'Table: add column', 'Table: delete row', 'Table: delete column', 'Table: align']
      : ['Insert table', 'To-do list', 'Bullet list', 'Numbered list', 'Callout', 'Code block', 'Highlight', 'Link to note'];
    showMenu(e.clientX, e.clientY, names.map((n) => ({ label: n, run: COMMANDS.find((c) => c[0] === n)[1] })));
  });

  let opts = [], sel = 0, commands = false;
  function switcher(asCommands = false) {
    commands = asCommands;
    modal.hidden = false;
    mq.placeholder = commands ? 'Run a command…' : 'Find or create a note…';
    mq.value = '';
    drawOpts();
    mq.focus();
  }
  const closeModal = () => { modal.hidden = true; if (cur() && cur().mode === 'edit') ed.focus(); };
  function score(q, s) {
    // subsequence match; earlier / tighter matches rank higher
    s = s.toLowerCase();
    let i = 0, last = -1, gaps = 0;
    for (const ch of q) {
      const j = s.indexOf(ch, i);
      if (j < 0) return -1;
      if (last >= 0) gaps += j - last - 1;
      last = j;
      i = j + 1;
    }
    return 1000 - gaps * 5 - s.length;
  }
  function drawOpts() {
    const q = mq.value.trim().toLowerCase();
    if (commands) {
      opts = COMMANDS.map(([label, run]) => ({ label, run, dir: '', s: score(q, label) })).filter((o) => !q || o.s >= 0);
      if (q) opts.sort((a, b) => b.s - a.s);
      sel = 0;
      paintOpts();
      return;
    }
    const notes = S.files.filter((f) => !f.d).map((f) => ({ p: f.p, label: base(f.p), dir: dirOf(f.p) }));
    opts = q
      ? notes.map((n) => ({ ...n, s: score(q, n.p.replace(/\.md$/i, '')) })).filter((n) => n.s >= 0).sort((a, b) => b.s - a.s)
      : notes.sort((a, b) => (S.tabs.some((t) => t.p === b.p) ? 1 : 0) - (S.tabs.some((t) => t.p === a.p) ? 1 : 0));
    opts = opts.slice(0, 50);
    if (q && !S.byName.has(q)) opts.push({ create: mq.value.trim(), label: `Create “${mq.value.trim()}”`, dir: '' });
    sel = 0;
    paintOpts();
  }
  function paintOpts() {
    $('#mlist').innerHTML = opts.map((o, i) => `<div class="opt${i === sel ? ' on' : ''}" data-i="${i}"><span>${esc(o.label)}</span><small>${esc(o.dir)}</small></div>`).join('') || `<div class="none">No ${commands ? 'commands' : 'notes'}</div>`;
    const on = $('#mlist .on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }
  const choose = guard(async (i) => {
    const o = opts[i];
    if (!o) return;
    closeModal();
    if (o.run) return o.run();
    if (o.create) { const p = await api.create('', o.create); await refresh(); await openNote(p); } else await openNote(o.p);
  });
  mq.addEventListener('input', drawOpts);
  mq.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, opts.length - 1); paintOpts(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); paintOpts(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
    else if (e.key === 'Escape') closeModal();
  });
  $('#mlist').addEventListener('click', (e) => { const o = e.target.closest('.opt'); if (o) choose(+o.dataset.i); });
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });

  // ---------------------------------------------------------------- shell: ribbon, resize, keys

  const vaultLabel = (v) => base(v.replace(/[\\/]+$/, '').replace(/\\/g, '/'));
  function loadVault(info) {
    S.tabs = []; S.active = -1; S.open = new Set();
    S.vault = info.vault;
    $('#vaultName').textContent = vaultLabel(info.vault);
    setFiles(info.files);
    renderTabs();
    show();
    persist();
  }
  const changeVault = guard(async () => {
    await flush();
    const info = await api.pick();
    if (info) loadVault(info);
  });
  let checking = false;
  const checkUpdate = guard(async () => {
    if (checking) return;
    checking = true;
    toast('Checking for updates…');
    try { toast(await api.checkUpdate()); } finally { checking = false; }
  });
  window.notes = { toast, guard, loadVault, flush, refresh, reload: () => reload() };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'files') S.side && S.panel === 'files' ? toggleSide(false) : showPanel('files');
    else if (act === 'search') S.side && S.panel === 'search' ? toggleSide(false) : showPanel('search');
    else if (act === 'outline') S.side && S.panel === 'outline' ? toggleSide(false) : showPanel('outline');
    else if (act === 'palette') switcher(true);
    else if (act === 'new') newNote('');
    else if (act === 'mkdir') newFolder('');
    else if (act === 'vault') changeVault();
    else if (act === 'update') checkUpdate();
    else if (act === 'sync') window.notes.openSync();
  });

  const resizer = $('#resizer');
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizer.classList.add('on');
    const move = (ev) => { S.sw = Math.max(160, Math.min(520, ev.clientX - 44)); document.documentElement.style.setProperty('--sw', S.sw + 'px'); };
    const up = () => { resizer.classList.remove('on'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); persist(); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });

  function cycle(d) {
    if (S.tabs.length > 1) activate((S.active + d + S.tabs.length) % S.tabs.length);
  }

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) return;
    if (e.key === 'F2' && cur()) { e.preventDefault(); title.focus(); title.select(); return; }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const run = {
      n: () => !e.shiftKey && newNote(''),
      o: () => switcher(),
      e: () => (e.shiftKey ? togglePreview() : toggleMode()),
      p: () => switcher(true),
      w: () => cur() && closeTab(S.active),
      f: () => e.shiftKey && showPanel('search'),
      '\\': () => toggleSide(),
      tab: () => cycle(e.shiftKey ? -1 : 1),
      pagedown: () => cycle(1),
      pageup: () => cycle(-1),
    }[k];
    if (run) { e.preventDefault(); run(); }
  });

  // ---------------------------------------------------------------- session

  let pTimer;
  function persist() {
    clearTimeout(pTimer);
    pTimer = setTimeout(() => api.session({
      tabs: S.tabs.map((t) => ({ p: t.p, mode: t.mode })),
      active: S.active,
      open: [...S.open],
      side: S.side,
      sw: S.sw,
      preview: S.preview,
    }), 300);
  }

  async function foldCopies() {
    await flush();
    const n = await api.fold();
    if (n) toast(`Merged ${n} conflict cop${n === 1 ? 'y' : 'ies'} into the original note${n === 1 ? '' : 's'}. The files are in the Recycle Bin.`);
  }

  // Pick up edits made elsewhere (e.g. by the sync app) whenever the window regains focus.
  const reload = guard(async () => {
    await foldCopies();
    await refresh();
    for (let i = S.tabs.length - 1; i >= 0; i--) {
      const t = S.tabs[i];
      if (t.dirty) continue;
      let text;
      try { text = await api.read(t.p); } catch { await closeTab(i); continue; }
      if (text !== t.text) {
        t.text = text;
        if (i === S.active) {
          const clash = !t.raw && (!merge.hidden || window.conflicts.parse(text).some((x) => x.older));
          if (clash) show();
          else {
            if (t.mode === 'edit') ed.update(text);
            if (!view.hidden) drawView();
          }
          drawOutline();
          stats();
        }
      }
    }
  });
  api.onFocus(reload);

  (async () => {
    await foldCopies().catch(() => {});
    const info = await api.info();
    S.vault = info.vault;
    $('#vaultName').textContent = base(info.vault.replace(/[\\/]+$/, '').replace(/\\/g, '/'));
    const s = info.session;
    S.open = new Set(s.open || []);
    S.preview = s.preview !== false;
    if (s.sw) { S.sw = s.sw; document.documentElement.style.setProperty('--sw', s.sw + 'px'); }
    if (s.side === false) toggleSide(false);
    setFiles(info.files);
    for (const t of s.tabs || []) {
      try { S.tabs.push({ p: t.p, text: await api.read(t.p), mode: t.mode || 'edit', dirty: false }); } catch {}
    }
    if (!S.tabs.length) {
      const first = info.files.find((f) => !f.d && f.p === 'Welcome.md');
      if (first) S.tabs.push({ p: first.p, text: await api.read(first.p), mode: 'edit', dirty: false });
    }
    S.active = S.tabs.length ? Math.min(Math.max(s.active ?? 0, 0), S.tabs.length - 1) : -1;
    showPanel('files');
    renderTabs();
    renderTree();
    show();
  })();
})();
