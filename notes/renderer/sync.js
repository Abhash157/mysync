// The sync screen: turn sync on for the notes folder, join from another device, see status.
// Joining on the same network needs no code: nearby devices are listed, you pick one, and its
// owner clicks Allow. An invite code stays available for other networks and the internet.
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
  let view = 'main'; // 'main' | 'join' | 'wait'
  let shown = '';
  let confirmStop = false;
  let joinDest = '';
  let nearby = null; // null until the first look has finished
  let scanTimer = null;
  let scanning = false;
  let scanBusy = false;
  let pair = null; // { device, code, url, id, status: 'asking'|'pending'|'approved'|'denied'|'expired'|'error', error }
  let pairTimer = null;
  let pollBusy = false;

  const plain = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const dot = () => (st && st.enabled ? (st.error ? 'bad' : (st.snap ? DOT[st.snap.state] ?? '' : 'busy')) : '');
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

  // ---------------------------------------------------------------- another device asks to join

  let pairKey = '';
  function paintPair() {
    const box = $('#pair');
    const list = (st && st.pairs) || [];
    const key = list.map((p) => p.id).join();
    if (key === pairKey) return;
    pairKey = key;
    const p = list[0];
    box.hidden = !p;
    if (!p) return;
    box.innerHTML = `<b>${esc(p.device)}</b> <span class="muted">${esc(p.address)}</span> wants to sync with this notes folder.
      <div class="code sm">${esc(p.code)}</div>
      <p class="muted">Allow only if ${esc(p.device)} shows the same code.${list.length > 1 ? ` ${list.length - 1} more waiting.` : ''}</p>
      <div class="row2"><button class="btn primary" data-p="allow" data-id="${esc(p.id)}">Allow</button><button class="btn" data-p="deny" data-id="${esc(p.id)}">Deny</button></div>`;
  }
  $('#pair').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    guard(() => api.syncPairAnswer(b.dataset.id, b.dataset.p === 'allow'))();
  });

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
    return `<div class="status"><span class="dot ${DOT[s.state] ?? ''}"></span>${esc(SHORT[s.state] || s.state)}</div>${detail(s)}${peers}${conflicts}${skipped}`;
  }

  function nearHtml() {
    if (nearby === null) return '<p class="muted">Looking for devices…</p>';
    if (!nearby.length) return '<p class="muted">No devices found yet. On your other device, open MyNotes and turn on sync. Both need to be on the same network.</p>';
    return `<div class="devs">${nearby.map((n, i) => `<div><span class="dot ok"></span><b>${esc(n.device)}</b>${n.name ? `<span class="muted">${esc(n.name)}</span>` : ''}<button class="btn" style="margin-left:auto" data-s="pair" data-i="${i}">Join</button></div>`).join('')}</div>`;
  }
  const paintNearby = () => { if ($('#near')) $('#near').innerHTML = nearHtml(); };

  function waitView() {
    const who = esc(pair.device);
    const body = {
      asking: () => '<p class="muted">Contacting the device…</p>',
      pending: () => `<p>On <b>${who}</b>, click <b>Allow</b>. Check that it shows this code:</p><div class="code">${esc(pair.code)}</div><p class="muted">Waiting for an answer…</p>`,
      approved: () => '<p>Allowed. Joining…</p>',
      denied: () => `<p>${who} said no.</p>`,
      expired: () => '<p>There was no answer. Ask again, and click Allow on the other device.</p>',
      error: () => `<p class="warn">${esc(pair.error || 'Something went wrong.')}</p>`,
    }[pair.status]();
    const busy = pair.status === 'asking' || pair.status === 'pending';
    return `${head(`Joining ${who}`)}${body}<div class="row2">${busy ? '<button class="btn" data-s="cancel">Cancel</button>' : pair.status === 'approved' ? '' : '<button class="btn" data-s="cancel">Back</button>'}</div>`;
  }

  function full() {
    if (!st) return '';
    if (st.error && !st.snap) {
      return `${head('Sync problem')}<p>${esc(st.error)}</p><div class="row2"><button class="btn primary" data-s="retry">Try again</button></div>`;
    }
    if (!st.enabled) {
      if (view === 'wait' && pair) return waitView();
      if (view === 'join') {
        return `${head('Join your notes', 'Pick the device that already has your notes. It will ask you to confirm with a code, so there is nothing to copy.')}
          <h3>Devices on your network</h3>
          <div id="near">${nearHtml()}</div>
          <h3>Save notes in</h3>
          <p id="jdest" style="word-break:break-all"></p>
          <p class="muted">Notes already in that folder are kept and merged with the synced ones.</p>
          <div class="row2"><button class="btn" data-s="jpick">Choose another folder…</button></div>
          <details id="codebox"><summary>Use an invite code instead</summary>
            <p class="muted">For a device on another network or over the internet. Copy the code from “Sync” on the other device.</p>
            <textarea class="field" id="jcode" placeholder="Invite code" spellcheck="false"></textarea>
            <p class="muted" id="jhint"></p>
            <div class="row2"><button class="btn" id="jgo" data-s="join" disabled>Join with code</button></div>
          </details>
          <div class="row2" style="margin-top:18px"><button class="btn" data-s="back">Back</button></div>`;
      }
      return `${head('Sync your notes', 'Keep your notes folder the same on all your devices. No account needed.')}
        <p class="muted" style="word-break:break-all">${esc(st.vault)}</p>
        <div class="row2"><button class="btn primary" data-s="enable">Start syncing this folder</button></div>
        <div class="row2"><button class="btn" data-s="tojoin">Join notes from another device</button></div>
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
      <p class="muted">On the other device, open MyNotes, choose Sync, then Join notes from another device and pick this one. You will be asked here to allow it. Both devices need to be on the same network.</p>
      <details><summary>Invite code (another network, or the internet)</summary>
        <p class="muted">Anyone with this code can read and change your notes, so only share it with yourself.</p>
        <textarea class="field" id="icode" readonly placeholder="Loading…"></textarea>
        <div class="row2"><button class="btn" data-s="copy">Copy code</button>${online ? '<button class="btn" data-s="online">Put online</button>' : ''}</div>
        ${hub ? '' : '<p class="muted">To sync across the internet, add a server under Settings below.</p>'}
      </details>
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

  const structKey = () => st ? JSON.stringify([st.enabled, st.error, !!st.snap, st.hub && st.hub.url, st.snap && st.snap.paused, st.snap && !!st.snap.hub, st.deviceName, view, confirmStop, pair && [pair.status, pair.code, pair.error]]) : '';

  function draw(force) {
    const open = !$('#sync').hidden;
    paintIndicators();
    paintPair();
    if (!open || !st) return;
    const key = structKey();
    if (force || key !== shown) {
      shown = key;
      const typed = $('#jcode') ? $('#jcode').value : null; // a redraw must not eat a half-typed code
      $('#sbody').innerHTML = full();
      if (typed && $('#jcode')) { $('#jcode').value = typed; $('#codebox').open = true; checkCode(); }
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
      api.clipboard().then((t) => {
        t = (t || '').trim();
        if (t.startsWith('mys1.') && $('#jcode') && !$('#jcode').value) { $('#jcode').value = t; $('#codebox').open = true; checkCode(); }
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
      $('#jgo').disabled = true;
      if (!code) { $('#jhint').textContent = ''; return; }
      try {
        const r = await api.syncInspect(code);
        if (!$('#jhint')) return;
        $('#jhint').textContent = r.valid ? `Looks good${r.name ? ` — “${r.name}”` : ''}.` : 'That does not look like an invite code.';
        $('#jgo').disabled = !r.valid;
      } catch (e) { if ($('#jhint')) $('#jhint').textContent = 'Could not check the code.'; }
    }, 200);
  }

  // ---------------------------------------------------------------- looking for nearby devices

  async function lookAround() {
    if (scanBusy) return;
    scanBusy = true;
    try { nearby = await api.syncNearby(); paintNearby(); } catch (e) { /* the engine may still be starting */ } finally { scanBusy = false; }
  }
  function startScan() {
    clearInterval(scanTimer);
    if (!scanning) { scanning = true; nearby = null; api.syncScan(true).catch(() => {}); }
    lookAround();
    scanTimer = setInterval(lookAround, 2000);
  }
  /** Stop looking. The sync engine is switched off again unless sync is on or we are mid-join. */
  function stopScan({ keepEngine = false } = {}) {
    clearInterval(scanTimer);
    scanTimer = null;
    if (scanning && !keepEngine) api.syncScan(false).catch(() => {});
    scanning = false;
  }

  // ---------------------------------------------------------------- asking a nearby device

  function endPair(cancel) {
    clearInterval(pairTimer);
    if (cancel && pair && pair.id && pair.status === 'pending') api.syncPairCancel(pair.url, pair.id).catch(() => {});
    pair = null;
  }

  async function startPair(entry) {
    clearInterval(scanTimer);
    pair = { device: entry.device, status: 'asking' };
    view = 'wait';
    draw(true);
    const mine = pair;
    try {
      const r = await api.syncPairRequest(entry.urls);
      if (pair !== mine) return api.syncPairCancel(r.url, r.id).catch(() => {}); // cancelled while contacting
      Object.assign(pair, { id: r.id, url: r.url, code: r.code, status: 'pending', fails: 0 });
      draw(true);
      pairTimer = setInterval(pollPair, 1200);
    } catch (e) {
      if (pair !== mine) return;
      Object.assign(pair, { status: 'error', error: plain(e) });
      draw(true);
    }
  }

  async function pollPair() {
    const mine = pair;
    if (!mine || mine.status !== 'pending' || pollBusy) return;
    pollBusy = true;
    try {
      const r = await api.syncPairPoll(mine.url, mine.id);
      if (pair !== mine) return;
      mine.fails = 0;
      if (r.status === 'approved') {
        clearInterval(pairTimer);
        mine.status = 'approved';
        draw(true);
        await finishJoin(mine, r.invite);
      } else if (r.status !== 'pending') {
        clearInterval(pairTimer);
        mine.status = r.status === 'denied' ? 'denied' : 'expired';
        draw(true);
      }
    } catch (e) {
      if (pair === mine && ++mine.fails >= 4) { clearInterval(pairTimer); Object.assign(mine, { status: 'error', error: plain(e) }); draw(true); }
    } finally {
      pollBusy = false;
    }
  }

  async function finishJoin(mine, invite) {
    try {
      const info = await api.syncJoin(invite, joinDest || undefined);
      stopScan({ keepEngine: true }); // sync is on now, so the engine stays
      pair = null;
      view = 'main';
      loadVault(info);
      toast('Joined. Your notes will appear as they sync.');
      draw(true);
    } catch (e) {
      if (pair === mine) { Object.assign(mine, { status: 'error', error: plain(e) }); draw(true); }
    }
  }

  // ---------------------------------------------------------------- actions

  const run = (btn, label, fn) => guard(async () => {
    const old = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = label; }
    try { await fn(); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
  })();

  const actions = {
    close: () => close(),
    back: () => { stopScan(); view = 'main'; draw(true); },
    tojoin: () => { view = 'join'; joinDest = ''; draw(true); startScan(); },
    cancel: () => { endPair(true); view = 'join'; draw(true); startScan(); },
    pair: (b) => { const n = nearby && nearby[+b.dataset.i]; if (n) startPair(n); },
    retry: (b) => run(b, 'Starting…', () => api.syncRetry()),
    enable: (b) => run(b, 'Starting…', async () => { await api.syncEnable(); st = await api.syncState(); view = 'main'; draw(true); }),
    jpick: async () => { const d = await api.pickFolder(); if (d) { joinDest = d; $('#jdest').textContent = d; } },
    join: (b) => run(b, 'Joining…', async () => {
      const info = await api.syncJoin($('#jcode').value.trim(), joinDest || undefined);
      stopScan({ keepEngine: true });
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
      st = await api.syncState();
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
  function close() {
    $('#sync').hidden = true;
    confirmStop = false;
    if (pair && pair.status === 'approved') return; // joining: let it finish
    endPair(true);
    stopScan();
    view = 'main';
  }
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
