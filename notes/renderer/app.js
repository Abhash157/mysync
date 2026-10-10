(() => {
  const $ = (s) => document.querySelector(s);
  const api = window.api;
  const { esc } = window.md;

  const S = { vault: '', files: [], byName: new Map(), tabs: [], active: -1, open: new Set(), panel: 'files', side: true, sw: 260 };

  const P = {
    files: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
    folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    swap: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24">${P[k]}</svg>`;
  document.querySelectorAll('[data-i]').forEach((el) => (el.innerHTML = svg(el.dataset.i)));

  const base = (p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const cur = () => S.tabs[S.active];
  const modal = $('#modal'), mq = $('#mq');
  const ed = $('#ed'), view = $('#view'), title = $('#title'), pane = $('#pane');

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
    if (!t) return;
    title.value = base(t.p);
    $('#mode').textContent = t.mode === 'edit' ? 'Editing' : 'Reading';
    ed.hidden = t.mode !== 'edit';
    view.hidden = t.mode === 'edit';
    if (t.mode === 'edit') {
      ed.value = t.text;
      fit();
      if (modal.hidden) ed.focus();
    } else {
      drawView();
    }
    stats();
  }

  function drawView() {
    const t = cur();
    const top = pane.scrollTop;
    view.innerHTML = window.md.render(t.text, resolveLink) || '<p style="color:var(--muted)">Empty note. Double-click to edit.</p>';
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
    t.mode = t.mode === 'edit' ? 'read' : 'edit';
    show();
  }
  $('#mode').onclick = toggleMode;
  view.addEventListener('dblclick', (e) => { if (!e.target.closest('a, input')) toggleMode(); });

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

  function fit() {
    const top = pane.scrollTop;
    ed.style.height = 'auto';
    ed.style.height = ed.scrollHeight + 'px';
    pane.scrollTop = top;
  }
  ed.addEventListener('input', () => { cur().text = ed.value; fit(); stats(); dirty(); });
  $('#page').addEventListener('mousedown', (e) => {
    if (e.target === $('#page') && cur().mode === 'edit') { e.preventDefault(); ed.focus(); ed.setSelectionRange(ed.value.length, ed.value.length); }
  });

  function setCaret(line) {
    const lines = ed.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line && i < lines.length; i++) pos += lines[i].length + 1;
    ed.focus();
    ed.setSelectionRange(pos, pos + (lines[line] || '').length);
    pane.scrollTop = ed.offsetTop + line * 26 - pane.clientHeight / 3;
  }

  // execCommand keeps the textarea's native undo history intact.
  const ins = (text) => { ed.focus(); document.execCommand(text ? 'insertText' : 'delete', false, text); };
  const replace = (a, b, text) => { ed.setSelectionRange(a, b); ins(text); };
  const lineStart = (pos) => ed.value.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = (pos) => { const i = ed.value.indexOf('\n', pos); return i < 0 ? ed.value.length : i; };
  const LIST = /^(\s*)(?:([-*+])|(\d+)([.)]))\s+(\[[ xX]\]\s+)?/;

  ed.addEventListener('keydown', (e) => {
    const c = e.ctrlKey || e.metaKey;
    const a = ed.selectionStart, b = ed.selectionEnd;

    if (e.key === 'Enter' && !c && !e.shiftKey && !e.altKey && !e.isComposing && a === b) {
      const ls = lineStart(a);
      const m = ed.value.slice(ls, a).match(LIST);
      if (!m) return;
      e.preventDefault();
      if (!ed.value.slice(ls + m[0].length, lineEnd(a)).trim() && a === lineEnd(a)) { replace(ls, a, ''); return; }
      const marker = m[2] || `${+m[3] + 1}${m[4]}`;
      ins('\n' + m[1] + marker + ' ' + (m[5] ? '[ ] ' : ''));
    } else if (e.key === 'Tab' && !c) {
      e.preventDefault();
      const ls = lineStart(a), le = lineEnd(b);
      const block = ed.value.slice(ls, le);
      if (a === b && !LIST.test(block) && !e.shiftKey) { ins('  '); return; }
      const out = block.split('\n').map((l) => (e.shiftKey ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l)).join('\n');
      replace(ls, le, out);
      if (a === b) { const p = Math.max(ls, a + out.length - block.length); ed.setSelectionRange(p, p); }
      else ed.setSelectionRange(ls, ls + out.length);
    } else if (c && !e.shiftKey && !e.altKey && 'bi'.includes(e.key.toLowerCase()) && e.key.length === 1) {
      e.preventDefault();
      const w = e.key.toLowerCase() === 'b' ? '**' : '*';
      const sel = ed.value.slice(a, b);
      ins(w + sel + w);
      if (a === b) ed.setSelectionRange(a + w.length, a + w.length);
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
  });

  // ---------------------------------------------------------------- reading view

  view.addEventListener('click', (e) => {
    const t = cur();
    const box = e.target.closest('input[type=checkbox]');
    if (box) {
      t.text = window.md.toggle(t.text, +box.dataset.l);
      dirty();
      drawView();
      return;
    }
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains('wl')) followLink(a.dataset.t);
    else api.external(a.getAttribute('href'));
  });

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
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); if (cur().mode === 'edit') ed.focus(); }
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
    document.querySelectorAll('#ribbon [data-act=files],#ribbon [data-act=search]').forEach((b) => b.classList.toggle('on', b.dataset.act === name));
    if (name === 'search') { $('#q').focus(); $('#q').select(); }
  }

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

  let opts = [], sel = 0;
  function switcher() {
    modal.hidden = false;
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
    $('#mlist').innerHTML = opts.map((o, i) => `<div class="opt${i === sel ? ' on' : ''}" data-i="${i}"><span>${esc(o.label)}</span><small>${esc(o.dir)}</small></div>`).join('') || '<div class="none">No notes</div>';
    const on = $('#mlist .on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }
  const choose = guard(async (i) => {
    const o = opts[i];
    if (!o) return;
    closeModal();
    if (o.create) { const p = await api.create('', o.create); await refresh(); await openNote(p); } else await openNote(o.p);
  });
  mq.addEventListener('input', drawOpts);
  mq.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, opts.length - 1); paintOpts(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); paintOpts(); e.preventDefault(); }
    else if (e.key === 'Enter') choose(sel);
    else if (e.key === 'Escape') closeModal();
  });
  $('#mlist').addEventListener('click', (e) => { const o = e.target.closest('.opt'); if (o) choose(+o.dataset.i); });
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });

  // ---------------------------------------------------------------- shell: ribbon, resize, keys

  const changeVault = guard(async () => {
    await flush();
    const info = await api.pick();
    if (!info) return;
    S.tabs = []; S.active = -1; S.open = new Set();
    S.vault = info.vault;
    $('#vaultName').textContent = base(info.vault.replace(/[\\/]+$/, '').replace(/\\/g, '/'));
    setFiles(info.files);
    renderTabs();
    show();
    persist();
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'files') S.side && S.panel === 'files' ? toggleSide(false) : showPanel('files');
    else if (act === 'search') S.side && S.panel === 'search' ? toggleSide(false) : showPanel('search');
    else if (act === 'new') newNote('');
    else if (act === 'mkdir') newFolder('');
    else if (act === 'vault') changeVault();
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
      e: () => toggleMode(),
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
    }), 300);
  }

  // Pick up edits made elsewhere (e.g. by the sync app) whenever the window regains focus.
  api.onFocus(guard(async () => {
    await refresh();
    for (let i = S.tabs.length - 1; i >= 0; i--) {
      const t = S.tabs[i];
      if (t.dirty) continue;
      let text;
      try { text = await api.read(t.p); } catch { await closeTab(i); continue; }
      if (text !== t.text) {
        t.text = text;
        if (i === S.active) {
          const pos = ed.selectionStart;
          if (t.mode === 'edit') { ed.value = text; fit(); ed.setSelectionRange(pos, pos); } else drawView();
          stats();
        }
      }
    }
  }));

  (async () => {
    const info = await api.info();
    S.vault = info.vault;
    $('#vaultName').textContent = base(info.vault.replace(/[\\/]+$/, '').replace(/\\/g, '/'));
    const s = info.session;
    S.open = new Set(s.open || []);
    if (s.sw) { S.sw = s.sw; document.documentElement.style.setProperty('--sw', s.sw + 'px'); }
    if (s.side === false) toggleSide(false);
    setFiles(info.files);
    for (const t of s.tabs || []) {
      try { S.tabs.push({ p: t.p, text: await api.read(t.p), mode: t.mode || 'edit', dirty: false }); } catch {}
    }
    if (!S.tabs.length) {
      const first = info.files.find((f) => !f.d && f.p === 'Welcome.md');
      if (first) S.tabs.push({ p: first.p, text: await api.read(first.p), mode: 'read', dirty: false });
    }
    S.active = S.tabs.length ? Math.min(Math.max(s.active ?? 0, 0), S.tabs.length - 1) : -1;
    showPanel('files');
    renderTabs();
    renderTree();
    show();
  })();
})();
