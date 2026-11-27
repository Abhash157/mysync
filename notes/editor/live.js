// The note editor: markdown shown formatted while you type in it. Markdown symbols appear only
// around the cursor, to-dos are real checkboxes and tables are edited cell by cell.
// The file stays plain markdown. Bundled into renderer/editor.bundle.js by scripts/prepare.js.
import { EditorState, StateEffect, StateField, Annotation } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, insertNewline, undo, redo } from '@codemirror/commands';

const { md, blocks } = window;

const setPreview = StateEffect.define();
const setFocused = StateEffect.define();
const External = Annotation.define(); // text that came from disk, not from the user

const flag = (effect, initial) => StateField.define({
  create: () => initial,
  update: (v, tr) => tr.effects.reduce((x, e) => (e.is(effect) ? e.value : x), v),
});

// ------------------------------------------------------------------ tables

const RULE_ROW = /^\s*\|(\s*:?-+:?\s*\|)*(\s*:?-+:?\s*)\|?\s*$/;
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const shown = (raw) => raw.replace(/\\\|/g, '|');
const stored = (text) => text.replace(/\s*\r?\n\s*/g, ' ').trim().replace(/(?<!\\)\|/g, '\\|');
const lineOffset = (lines, n) => lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
const columnAt = (line, ch) => Math.max(0, (line.slice(0, ch).match(/(?<!\\)\|/g) || []).length - 1);
// Where column `c` of a table line starts.
function columnStart(line, c) {
  const pipes = [...line.matchAll(/(?<!\\)\|/g)];
  return pipes[c] ? pipes[c].index + 1 : line.length;
}

function parseTable(src) {
  const lines = src.split('\n');
  const align = splitRow(lines[1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : ''));
  const rows = lines.filter((_, i) => i !== 1).map(splitRow);
  const width = Math.max(align.length, ...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push('');
  return { align, rows, width };
}

class TableWidget extends WidgetType {
  constructor(src, hooks) { super(); this.src = src; this.hooks = hooks; }
  eq(other) { return other.src === this.src; }
  ignoreEvent() { return true; }

  draw(cell, raw) {
    cell.dataset.raw = raw;
    cell.innerHTML = md.inline(shown(raw), this.hooks.resolve) || '<br>';
  }

  toDOM(view) {
    const { align, rows, width } = parseTable(this.src);
    const dom = document.createElement('div');
    dom.className = 'cm-table';
    dom.contentEditable = 'false';
    dom.src = this.src;
    dom.shape = `${rows.length}x${width}:${align}`;
    const table = dom.appendChild(document.createElement('table'));
    rows.forEach((row, r) => {
      const tr = table.appendChild(document.createElement('tr'));
      row.forEach((raw, c) => {
        const cell = tr.appendChild(document.createElement(r ? 'td' : 'th'));
        cell.contentEditable = 'plaintext-only';
        cell.spellcheck = false;
        cell.dataset.r = r;
        cell.dataset.c = c;
        if (align[c]) cell.className = align[c];
        this.draw(cell, raw);
      });
    });
    wireTable(view, dom, this.hooks);
    return dom;
  }

  updateDOM(dom) {
    const { align, rows, width } = parseTable(this.src);
    if (dom.shape !== `${rows.length}x${width}:${align}`) return false;
    if (dom.src === this.src) return true; // typed here: leave the cells alone
    dom.src = this.src;
    for (const cell of dom.querySelectorAll('th, td')) {
      const raw = rows[+cell.dataset.r][+cell.dataset.c];
      if (cell.dataset.raw === raw) continue;
      if (cell === document.activeElement) { cell.dataset.raw = raw; cell.textContent = shown(raw); caretToEnd(cell); }
      else this.draw(cell, raw);
    }
    return true;
  }
}

function caretToEnd(el, all = false) {
  const range = document.createRange();
  range.selectNodeContents(el);
  if (!all) range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function wireTable(view, dom, hooks) {
  const cellOf = (e) => e.target.closest?.('th, td');

  dom.addEventListener('mousedown', (e) => {
    const a = e.target.closest('a');
    if (a && e.button === 0) { e.preventDefault(); hooks.follow(a.dataset.tag ? { tag: a.dataset.tag } : a.dataset.t ? { note: a.dataset.t } : { url: a.getAttribute('href') }); }
  });
  dom.addEventListener('click', (e) => { if (e.target.closest('a')) e.preventDefault(); });

  dom.addEventListener('focusin', (e) => {
    const cell = cellOf(e);
    if (!cell) return;
    hooks.cell({ dom, r: +cell.dataset.r, c: +cell.dataset.c });
    const text = shown(cell.dataset.raw);
    if (cell.textContent !== text) { cell.textContent = text; caretToEnd(cell); }
  });
  dom.addEventListener('focusout', (e) => {
    const cell = cellOf(e);
    if (cell) cell.innerHTML = md.inline(shown(cell.dataset.raw), hooks.resolve) || '<br>';
  });

  dom.addEventListener('input', (e) => {
    const cell = cellOf(e);
    if (!cell) return;
    cell.dataset.raw = stored(cell.textContent);
    const lines = dom.src.split('\n');
    const rows = [...dom.querySelectorAll('tr')].map((tr) => [...tr.children].map((x) => x.dataset.raw));
    const indent = lines[0].match(/^\s*/)[0];
    const next = [rows[0], splitRow(lines[1]), ...rows.slice(1)].map((r) => `${indent}| ${r.join(' | ')} |`);
    const src = blocks.table(next, 0, 0, 'format').out.join('\n');
    if (src === dom.src) return;
    const from = view.posAtDOM(dom);
    const to = from + dom.src.length;
    dom.src = src;
    view.dispatch({ changes: { from, to, insert: src }, userEvent: 'input.type' });
  });

  dom.addEventListener('keydown', (e) => {
    const cell = cellOf(e);
    if (!cell || e.isComposing) return;
    const r = +cell.dataset.r, c = +cell.dataset.c;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let handled = true;
    if (e.key === 'Tab' && !ctrl) tableAction(view, dom, r, c, e.shiftKey ? 'prev' : 'next');
    else if (e.key === 'Enter' && !ctrl) tableAction(view, dom, r, c, 'enter');
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const other = dom.querySelector(`[data-r="${r + (e.key === 'ArrowUp' ? -1 : 1)}"][data-c="${c}"]`);
      if (other) { other.focus(); caretToEnd(other); }
      else leaveTable(view, dom, e.key === 'ArrowUp');
    } else if (e.key === 'Escape') leaveTable(view, dom, false);
    else if (ctrl && key === 'z' && !e.shiftKey) undo(view);
    else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) redo(view);
    else if (ctrl && !e.shiftKey && (key === 'b' || key === 'i')) {
      const mark = key === 'b' ? '**' : '*';
      document.execCommand('insertText', false, mark + getSelection().toString() + mark);
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  });
}

// Puts the cursor on the line above or below a table, making one if needed.
function leaveTable(view, dom, above) {
  const from = view.posAtDOM(dom);
  const end = from + dom.src.length;
  const doc = view.state.doc;
  document.activeElement?.blur();
  if (above) {
    view.dispatch(from ? { selection: { anchor: from - 1 } } : { changes: { from: 0, insert: '\n' }, selection: { anchor: 0 } });
  } else {
    view.dispatch(end < doc.length ? { selection: { anchor: end + 1 } } : { changes: { from: end, insert: '\n' }, selection: { anchor: end + 1 } });
  }
  view.focus();
}

// Adds, removes or moves between rows and columns, starting at cell (r, c).
function tableAction(view, dom, r, c, action) {
  const lines = dom.src.split('\n');
  const line = r ? r + 1 : 0;
  const result = blocks.table(lines, line, columnStart(lines[line], c), action);
  if (!result) return;
  const from = view.posAtDOM(dom);
  const start = from + lineOffset(lines, result.start);
  const end = from + lineOffset(lines, result.end - 1) + lines[result.end - 1].length;
  const insert = result.out.join('\n');
  const exit = action === 'enter' && result.out.length === 1 && !result.out[0];
  if (exit) {
    document.activeElement?.blur();
    view.dispatch({ changes: { from: start, to: end, insert: '\n' }, selection: { anchor: start + 1 }, userEvent: 'input' });
    view.focus();
    return;
  }
  if (view.state.sliceDoc(start, end) !== insert) view.dispatch({ changes: { from: start, to: end, insert }, userEvent: 'input' });
  focusCell(view, from, result.line ? result.line - 1 : 0, columnAt(result.out[result.line], result.from));
}

// Focuses cell (r, c) of the table starting at `from`. The cursor has to be outside the table,
// otherwise the table is showing as text.
function focusCell(view, from, r, c) {
  const doc = view.state.doc;
  let last = doc.lineAt(from);
  while (last.number < doc.lines && /^\s*\|/.test(doc.line(last.number + 1).text)) last = doc.line(last.number + 1);
  const { from: a, to: b } = view.state.selection.main;
  if (a <= last.to && b >= from) {
    view.dispatch(last.to < doc.length
      ? { selection: { anchor: last.to + 1 } }
      : { changes: { from: last.to, insert: '\n' }, selection: { anchor: last.to + 1 }, userEvent: 'input' });
  }
  const go = () => {
    const dom = [...view.contentDOM.querySelectorAll('.cm-table')].find((d) => view.posAtDOM(d) === from);
    const cell = dom?.querySelector(`[data-r="${r}"][data-c="${c}"]`);
    if (!cell) return false;
    cell.focus();
    caretToEnd(cell, true);
    return true;
  };
  if (!go()) requestAnimationFrame(go);
}

// ------------------------------------------------------------------ formatting in place

class Check extends WidgetType {
  constructor(on) { super(); this.on = on; }
  eq(o) { return o.on === this.on; }
  ignoreEvent() { return true; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-check';
    box.checked = this.on;
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(box));
      const m = line.text.match(/\[([ xX])\]/);
      if (m) view.dispatch({ changes: { from: line.from + m.index + 1, to: line.from + m.index + 2, insert: m[1] === ' ' ? 'x' : ' ' }, userEvent: 'input' });
    });
    return box;
  }
  updateDOM() { return false; }
}

class Text extends WidgetType {
  constructor(cls, text) { super(); this.cls = cls; this.text = text; }
  eq(o) { return o.cls === this.cls && o.text === this.text; }
  toDOM() {
    const el = document.createElement('span');
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }
  ignoreEvent() { return false; }
}

const INLINE = /(`[^`]+`)|(\[\[[^\]|]+(?:\|[^\]]+)?\]\])|(\[[^\]]+\]\((?:https?:\/\/[^\s)]+|mailto:[^\s)]+)\))|(https?:\/\/[^\s<)]+)|((?<!\S)#[\p{L}_\/-][\p{L}\p{N}_\/-]*)|(==.+?==)|(\*\*.+?\*\*|(?<![\p{L}\p{N}])__.+?__(?![\p{L}\p{N}]))|(~~.+?~~)|(\*[^*\s][^*]*?\*|(?<![\p{L}\p{N}])_[^_]+_(?![\p{L}\p{N}]))/gu;

const mark = (cls, attributes) => Decoration.mark({ class: cls, attributes });
const hide = Decoration.replace({});

function decorate(state, hooks) {
  const out = [];
  if (!state.field(hooks.preview)) return Decoration.none;
  const focused = state.field(hooks.focused);
  const ranges = state.selection.ranges;
  // `touches` includes the edges, `inside` does not.
  const touches = (a, b) => focused && ranges.some((r) => r.from <= b && r.to >= a);
  const inside = (a, b) => focused && ranges.some((r) => r.from < b && r.to > a);
  const add = (from, to, deco) => out.push(deco.range(from, to));
  const line = (at, cls) => out.push(Decoration.line({ class: cls }).range(at));

  function inline(text, base) {
    for (const m of text.matchAll(INLINE)) {
      const [all, code, wiki, link, url, tag, high, strong, strike, em] = m;
      const a = base + m.index, b = a + all.length;
      const open = touches(a, b);
      const live = open ? '' : ' cm-live';
      const span = (before, after, deco, recurse = true) => {
        if (b - after > a + before) add(a + before, b - after, deco);
        if (!open) {
          if (before) add(a, a + before, hide);
          if (after) add(b - after, b, hide);
        }
        if (recurse) inline(all.slice(before, all.length - after), a + before);
      };
      if (code) span(1, 1, mark('cm-code'), false);
      else if (wiki) {
        const bar = all.indexOf('|');
        const name = all.slice(2, bar < 0 ? -2 : bar).trim();
        span(bar < 0 ? 2 : bar + 1, 2, mark(`cm-wl${hooks.resolve(name) ? '' : ' new'}${live}`, { 'data-t': name }), false);
      } else if (link) {
        const mid = all.lastIndexOf('](');
        span(1, all.length - mid, mark('cm-link' + live, { 'data-href': all.slice(mid + 2, -1) }));
      } else if (url) add(a, b, mark('cm-link' + live, { 'data-href': all }));
      else if (tag) add(a, b, mark('cm-tag' + live, { 'data-tag': all.slice(1) }));
      else if (high) span(2, 2, mark('cm-mark'));
      else if (strong) span(2, 2, mark('cm-strong'));
      else if (strike) span(2, 2, mark('cm-strike'));
      else if (em) span(1, 1, mark('cm-em'));
    }
  }

  const doc = state.doc;
  let fence = null;
  let callout = null; // kind of the callout the current quote block belongs to
  for (let n = 1; n <= doc.lines; n++) {
    const l = doc.line(n);
    const text = l.text;

    if (fence) {
      line(l.from, 'cm-pre');
      if (text.startsWith(fence)) { fence = null; line(l.from, 'cm-fence'); }
      continue;
    }
    const f = text.match(/^(```|~~~)/);
    if (f) { fence = f[1]; callout = null; line(l.from, 'cm-pre cm-fence'); continue; }

    if (/^\s*\|/.test(text) && n < doc.lines && RULE_ROW.test(doc.line(n + 1).text)) {
      let last = n + 1;
      while (last < doc.lines && /^\s*\|/.test(doc.line(last + 1).text)) last++;
      const end = doc.line(last).to;
      callout = null;
      if (touches(l.from, end)) for (let k = n; k <= last; k++) line(doc.line(k).from, 'cm-rawtable');
      else add(l.from, end, Decoration.replace({ widget: new TableWidget(doc.sliceString(l.from, end), hooks), block: true }));
      n = last;
      continue;
    }

    const here = touches(l.from, l.to);
    let at = 0; // how far into the line the block syntax reaches

    const quote = text.match(/^\s{0,3}(?:>\s?)+/);
    if (quote) {
      at = quote[0].length;
      const call = !callout && text.slice(at).match(/^\[!([\w-]+)\][+-]?\s*/);
      const starts = call && (n === 1 || !/^\s{0,3}>/.test(doc.line(n - 1).text));
      if (starts) {
        callout = call[1].toLowerCase();
        line(l.from, `cm-callout cm-callout-title ${callout}`);
        at += call[0].length;
        if (!here) {
          const label = at === text.length ? callout[0].toUpperCase() + callout.slice(1) : '';
          add(l.from, l.from + at, label ? Decoration.replace({ widget: new Text('cm-label', label) }) : hide);
        }
      } else {
        line(l.from, callout ? `cm-callout ${callout}` : 'cm-quote');
        if (!here) add(l.from, l.from + at, hide);
      }
    } else callout = null;

    const rest = text.slice(at);
    const head = rest.match(/^(#{1,6})\s+/);
    if (head) {
      line(l.from, `cm-h cm-h${head[1].length}`);
      if (!here) add(l.from + at, l.from + at + head[0].length, hide);
      at += head[0].length;
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(rest)) {
      if (!here) add(l.from + at, l.to, Decoration.replace({ widget: new Text('cm-hr', '') }));
      continue;
    } else {
      const item = rest.match(/^(\s*)([-*+]|\d+[.)])(\s+)(?:(\[([ xX])\])(?=\s|$))?/);
      if (item) {
        const [all, indent, marker, space, box, state_] = item;
        const start = l.from + at + indent.length;
        const end = l.from + at + all.length;
        const bullet = /[-*+]/.test(marker);
        line(l.from, 'cm-item');
        if (box) {
          const boxFrom = bullet ? start : start + marker.length + space.length;
          if (!inside(boxFrom, end)) add(boxFrom, end, Decoration.replace({ widget: new Check(state_ !== ' ') }));
          if (state_ !== ' ' && end < l.to) add(end, l.to, mark('cm-done'));
        } else if (bullet && !inside(start, start + 1) && !(here && ranges.some((r) => r.head === start + 1))) {
          add(start, start + 1, Decoration.replace({ widget: new Text('cm-bullet', '•') }));
        }
        at += all.length;
      }
    }
    inline(text.slice(at), l.from + at);
  }
  return Decoration.set(out, true);
}

// ------------------------------------------------------------------ the editor

function create(parent, hooks) {
  let lastCell = null; // the table cell last worked in, for commands from the palette or menu
  let preview = true;
  const listeners = [];

  const makeState = (doc, focused) => {
    const h = {
      resolve: hooks.resolve,
      follow: hooks.follow,
      cell: (c) => (lastCell = c),
      preview: flag(setPreview, preview),
      focused: flag(setFocused, focused),
    };
    const decorations = StateField.define({
      create: (state) => decorate(state, h),
      update: (value, tr) => (tr.docChanged || tr.selection || tr.effects.length ? decorate(tr.state, h) : value),
      provide: (field) => EditorView.decorations.from(field),
    });
    return EditorState.create({
      doc,
      selection: { anchor: doc.replace(/\r\n?/g, '\n').length },
      extensions: [
        h.preview,
        h.focused,
        decorations,
        history(),
        EditorView.lineWrapping,
        keymap.of([{ key: 'Enter', run: insertNewline, shift: insertNewline }, ...historyKeymap, ...defaultKeymap]),
        EditorView.focusChangeEffect.of((_, focusing) => setFocused.of(focusing)),
        EditorView.updateListener.of((u) => {
          if (u.transactions.some((tr) => tr.selection && tr.isUserEvent('select'))) lastCell = null;
          if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) listeners.forEach((fn) => fn());
        }),
        EditorView.domEventHandlers({
          mousedown(e) {
            const el = e.button === 0 && e.target.closest?.('.cm-live');
            if (!el) return false;
            e.preventDefault();
            const { t, tag, href } = el.dataset;
            hooks.follow(tag ? { tag } : t ? { note: t } : { url: href });
            return true;
          },
        }),
      ],
    });
  };

  const view = new EditorView({ state: makeState('', false), parent });
  const select = (a, b = a) => view.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true });

  return {
    view,
    dom: view.dom,
    get value() { return view.state.doc.toString(); },
    get selectionStart() { return view.state.selection.main.from; },
    get selectionEnd() { return view.state.selection.main.to; },
    get hidden() { return parent.hidden; },
    set hidden(v) { parent.hidden = v; },
    focus: () => view.focus(),
    setSelectionRange: select,
    insert: (text) => view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input', scrollIntoView: true }),
    onInput: (fn) => listeners.push(fn),
    // Opens another note (with a fresh undo history).
    load(text) { lastCell = null; view.setState(makeState(text, view.hasFocus)); },
    // The same note changed on disk.
    update(text) {
      const next = text.replace(/\r\n?/g, '\n');
      const now = view.state.doc.toString();
      if (next === now) return;
      let a = 0, x = now.length, y = next.length;
      while (a < x && a < y && now[a] === next[a]) a++;
      while (x > a && y > a && now[x - 1] === next[y - 1]) { x--; y--; }
      view.dispatch({ changes: { from: a, to: x, insert: next.slice(a, y) }, annotations: External.of(true) });
    },
    setPreview(on) {
      if (preview === on) return;
      preview = on;
      view.dispatch({ effects: setPreview.of(on) });
    },
    reveal: (pos) => view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) }),
    // In preview mode a table is edited in its cells: move there after changing its text.
    enterTable() {
      const doc = view.state.doc;
      const head = view.state.selection.main;
      let line = doc.lineAt(head.from);
      if (!preview || !/^\s*\|/.test(line.text)) return;
      const col = columnAt(line.text, head.from - line.from);
      const row = line.number;
      while (line.number > 1 && /^\s*\|/.test(doc.line(line.number - 1).text)) line = doc.line(line.number - 1);
      const r = row - line.number;
      focusCell(view, line.from, r ? Math.max(r - 1, 0) : 0, col);
    },
    // Applies a table command to the cell last worked in. False if the cursor is not in a table cell.
    cellAction(action) {
      if (!lastCell?.dom.isConnected) return false;
      tableAction(view, lastCell.dom, lastCell.r, lastCell.c, action);
      return true;
    },
  };
}

window.liveEditor = { create };
