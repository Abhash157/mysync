// The sync screen: turn sync on for the notes folder, join from another device, see status.
(() => {
  const $ = (s) => document.querySelector(s);
  const api = window.api;
  const { toast, guard, loadVault } = window.notes;
  const { esc } = window.md;

  const SHORT = {
    synced: 'Up to date',
    syncing: 'Syncing…',
    alone: 'Not shared with another device yet',
    offline: 'Cannot reach your other devices',
    waiting: 'Waiting for a file to be closed',
    paused: 'Paused',
    attention: 'Needs attention',
  };
  const DOT = { synced: 'ok', syncing: 'busy', alone: '', offline: 'warn', waiting: 'warn', paused: '', attention: 'bad' };

  let st = null;
  let view = 'main'; // 'main' | 'join'
  let shown = '';
  let confirmStop = false;
  let joinDest = '';
  let joinOk = false;

  const kind = () => (!st || !st.enabled ? 'off' : st.error ? 'bad' : st.snap ? st.snap.state : 'syncing');
  const dot = () => (st && st.enabled ? (st.error ? 'bad' : DOT[kind()] ?? '') : '');
  const text = () => (!st || !st.enabled ? 'Sync off' : st.error ? 'Sync problem' : st.snap ? SHORT[st.snap.state] || st.snap.state : 'Starting sync…');
  const ago = (t) => {
    const s = Math.max(0, (Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
  };

  function paintIndicators() {
    $('#syncBtn').innerHTML = `<span class="dot ${dot()}"></span>${esc(text())}`;
    const r = $('#syncRibbon');
    if (st && st.enabled) r.dataset.k = dot() || 'idle'; else delete r.dataset.k;
  }

  // ---------------------------------------------------------------- dialog content

  const head = (title, sub) => `<div class="head"><h2>${title}</h2><button data-s="close" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>${sub ? `<p class="muted">${sub}</p>` : ''}`;

  const detail = (s) => {
    const msg = s.message && s.message.replace(/[.…]+$/, '') !== (SHORT[s.state] || '').replace(/[.…]+$/, '') ? esc(s.message) : '';
    const last = s.lastChangeAt ? `Last change ${ago(s.lastChangeAt)}.` : '';
    return msg || last ? `<p class="muted">${[msg, last].filter(Boolean).join(' ')}</p>` : '';
  };

  function dyn() {
    const s = st.snap;
    if (!s) return `<div class="status"><span class="dot busy"></span>Starting…</div>`;
    const peers = s.peers.length
      ? `<div class="devs">${s.peers.map((p) => `<div><span class="dot ${p.online ? 'ok' : 'warn'}"></span>${esc(p.label || p.name)}<small>${p.online ? 'online' : esc(p.error || 'not reachable')}</small></div>`).join('')}</div>`
      : '';
    const conflicts = s.conflicts.length ? `<p class="warn">${s.conflicts.length} note${s.conflicts.length === 1 ? ' was' : 's were'} changed on two devices. Both copies are kept in your notes folder (look for “.conflict” in the name).</p>` : '';
    const skipped = s.skipped.length ? `<p class="muted">${s.skipped.length} large file${s.skipped.length === 1 ? ' is' : 's are'} not synced (over 100 MB).</p>` : '';
    return `<div class="status"><span class="dot ${DOT[s.state] ?? ''}"></span>${esc(SHORT[s.state] || s.state)}</div>
      ${detail(s)}${peers}${conflicts}${skipped}`;
  }

  function full() {
    if (!st) return '';
    if (st.error && !st.snap) {
      return `${head('Sync problem')}<p>${esc(st.error)}</p><div class="row2"><button class="btn primary" data-s="retry">Try again</button></div>`;
    }
    if (!st.enabled) {
      if (view === 'join') {
        return `${head('Join your notes', 'Paste the invite code from your other device.')}
          <textarea class="field" id="jcode" placeholder="Invite code" spellcheck="false"></textarea>
          <p class="muted" id="jhint"></p>
          <h3>Save notes in</h3>
          <p id="jdest" style="word-break:break-all"></p>
          <p class="muted">Notes already in that folder are kept and merged with the synced ones.</p>
          <div class="row2"><button class="btn" data-s="jpick">Choose another folder…</button></div>
          <div class="row2"><button class="btn primary" id="jgo" data-s="join" disabled>Join</button><button class="btn" data-s="back">Back</button></div>`;
      }
      return `${head('Sync your notes', 'Keep your notes folder the same on all your devices. No account needed: devices connect directly, or through your own server.')}
        <p class="muted" style="word-break:break-all">${esc(st.vault)}</p>
        <div class="row2"><button class="btn primary" data-s="enable">Start syncing this folder</button></div>
        <div class="row2"><button class="btn" data-s="tojoin">I already sync notes on another device</button></div>
        <p class="muted">Sync runs while MyNotes is open.</p>`;
    }
    const hub = st.hub;
    const online = hub && !(st.snap && st.snap.hub);
    return `${head('Sync')}
      <div id="sdyn">${dyn()}</div>
      <div class="row2">
        <button class="btn" data-s="now">Sync now</button>
        <button class="btn" data-s="pause">${st.snap && st.snap.paused ? 'Resume' : 'Pause'}</button>
      </div>
      <h3>Add another device</h3>
      <p class="muted">On the other device choose “I already sync notes on another device” and paste this code. Anyone with the code can read and change your notes, so only share it with yourself.</p>
      <textarea class="field" id="icode" readonly placeholder="Loading…"></textarea>
      <div class="row2"><button class="btn" data-s="copy">Copy code</button>${online ? '<button class="btn" data-s="online">Put online</button>' : ''}</div>
      ${hub ? '' : '<p class="muted">Devices on the same network find each other automatically. To sync across the internet, add a server under Settings below.</p>'}
      <details><summary>Settings</summary>
        <label>Name of this device</label>
        <div class="row2" style="margin-top:0"><input class="field" id="dname" value="${esc(st.deviceName)}" style="flex:1"><button class="btn" data-s="dname">Save</button></div>
        <label>Internet server address</label>
        <input class="field" id="hurl" value="${esc(hub ? hub.url : '')}" placeholder="https://notes.example.com">
        <label>Server secret${hub && hub.hasSecret ? ' (saved; leave empty to keep it)' : ''}</label>
        <input class="field" id="hsec" type="password" placeholder="optional">
        <div class="row2"><button class="btn" data-s="htest">Test</button><button class="btn" data-s="hsave">Save</button></div>
      </details>
      <div class="row2" style="margin-top:18px"><button class="btn danger" data-s="stop">${confirmStop ? 'Click again to stop syncing' : 'Stop syncing this folder'}</button></div>
      <p class="muted">Your notes stay exactly where they are.</p>`;
  }

  const structKey = () => st ? JSON.stringify([st.enabled, st.error, !!st.snap, st.hub && st.hub.url, st.snap && st.snap.paused, st.snap && !!st.snap.hub, st.deviceName, view, confirmStop]) : '';

  function draw(force) {
    const open = !$('#sync').hidden;
    paintIndicators();
    if (!open || !st) return;
    const key = structKey();
    if (force || key !== shown) {
      shown = key;
      $('#sbody').innerHTML = full();
      afterDraw();
    } else if ($('#sdyn')) {
      $('#sdyn').innerHTML = dyn();
    }
  }

  function afterDraw() {
    if (st.enabled && !st.error && $('#icode')) {
      api.syncInvite().then((c) => { if ($('#icode')) $('#icode').value = c; }).catch(() => { if ($('#icode')) $('#icode').placeholder = 'Could not create a code'; });
    }
    if (!st.enabled && view === 'join') {
      $('#jdest').textContent = joinDest || st.vault;
      $('#jcode').focus();
      api.clipboard().then((t) => {
        if (t && $('#jcode') && !$('#jcode').value) { $('#jcode').value = t.trim(); checkCode(); }
      }).catch(() => {});
    }
  }

  let checkTimer;
  function checkCode() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(async () => {
      const el = $('#jcode');
      if (!el) return;
      const code = el.value.trim();
      joinOk = false;
      $('#jgo').disabled = true;
      if (!code) { $('#jhint').textContent = ''; return; }
      try {
        const r = await api.syncInspect(code);
        joinOk = r.valid;
        $('#jhint').textContent = r.valid ? `Looks good${r.name ? ` — “${r.name}”` : ''}.` : 'That does not look like an invite code.';
        $('#jgo').disabled = !r.valid;
      } catch (e) { $('#jhint').textContent = 'Could not check the code.'; }
    }, 200);
  }

  // ---------------------------------------------------------------- actions

  const run = (btn, label, fn) => guard(async () => {
    const old = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = label; }
    try { await fn(); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
  })();

  const actions = {
    close: () => close(),
    back: () => { view = 'main'; draw(true); },
    tojoin: () => { view = 'join'; joinDest = ''; draw(true); },
    retry: (b) => run(b, 'Starting…', () => api.syncRetry()),
    enable: (b) => run(b, 'Starting…', async () => { await api.syncEnable(); view = 'main'; draw(true); }),
    jpick: async () => { const d = await api.pickFolder(); if (d) { joinDest = d; $('#jdest').textContent = d; } },
    join: (b) => run(b, 'Joining…', async () => {
      const info = await api.syncJoin($('#jcode').value.trim(), joinDest || undefined);
      loadVault(info);
      view = 'main';
      toast('Joined. Your notes will appear as they sync.');
      draw(true);
    }),
    now: (b) => run(b, 'Syncing…', () => api.syncNow()),
    pause: () => guard(() => (st.snap && st.snap.paused ? api.syncResume() : api.syncPause()))(),
    copy: async () => { await api.copy($('#icode').value); toast('Invite code copied'); },
    online: (b) => run(b, 'Putting online…', async () => {
      const name = (st.vault.split(/[\\/]/).filter(Boolean).pop() || 'notes').replace(/[^\w-]+/g, '-').toLowerCase();
      const code = await api.syncPublish(name);
      $('#icode').value = code;
      toast('Your notes are online');
    }),
    dname: (b) => run(b, 'Saving…', async () => { await api.syncDevice($('#dname').value); toast('Saved'); }),
    htest: (b) => run(b, 'Testing…', async () => {
      const r = await api.syncTestHub($('#hurl').value);
      toast(r.ok ? 'Server reachable' : r.error);
    }),
    hsave: (b) => run(b, 'Saving…', async () => { await api.syncHub($('#hurl').value, $('#hsec').value); toast($('#hurl').value.trim() ? 'Server saved' : 'Server removed'); }),
    stop: async () => {
      if (!confirmStop) { confirmStop = true; draw(true); return; }
      confirmStop = false;
      await guard(() => api.syncStop())();
      draw(true);
    },
  };

  $('#sync').addEventListener('click', (e) => {
    if (e.target === $('#sync')) return close();
    const b = e.target.closest('[data-s]');
    if (b && actions[b.dataset.s]) actions[b.dataset.s](b);
  });
  $('#sync').addEventListener('input', (e) => { if (e.target.id === 'jcode') checkCode(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sync').hidden) close(); });

  function open() {
    view = 'main';
    confirmStop = false;
    joinDest = '';
    $('#sync').hidden = false;
    shown = '';
    draw(true);
  }
  function close() { $('#sync').hidden = true; confirmStop = false; }
  window.notes.openSync = open;

  let lastChange = null;
  api.onSync((s) => {
    st = s;
    draw(false);
    const t = s.snap && s.snap.lastChangeAt;
    if (t && t !== lastChange) { lastChange = t; window.notes.reload(); } // sync brought in changes
  });
  api.onSyncNotify((info) => toast(`Two versions of “${(info.files && info.files[0]) || 'a note'}” were kept. Both copies are in your notes folder.`));
  api.syncState().then((s) => { st = s; draw(false); });
})();
