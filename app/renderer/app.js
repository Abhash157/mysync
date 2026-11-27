// MySync window. Plain JavaScript: the page asks the app (through the small allow-listed
// bridge in preload.cjs) to do things and re-draws whenever the app reports a change.

const $ = (selector, root = document) => root.querySelector(selector);
const main = $('#main');
const sidebar = $('#sidebar');
const dialog = $('#dialog');

let state = null;
let view = { name: 'folder', root: null };
let onboardingShown = false;
let dialogResolver = null;
let joinDraft = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(channel, payload) {
  const res = await window.mysync.invoke(channel, payload);
  if (!res.ok) throw new Error(res.error || 'Something went wrong');
  return res.data;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function fmtBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function ago(ts) {
  if (!ts) return 'never';
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${Math.floor(seconds)} seconds ago`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${plural(Math.floor(minutes), 'minute')} ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${plural(Math.floor(hours), 'hour')} ago`;
  return `${plural(Math.floor(hours / 24), 'day')} ago`;
}

const ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.5-4M4 13a8 8 0 0 0 14.5 4"/><path d="M20 4v5h-5M4 20v-5h5"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9.5 4.5 4.5 0 0 1 17.5 18z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 20h20"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

function toast(message, tone = '') {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), tone === 'err' ? 7000 : 3500);
}

const folderBy = (root) => state?.folders.find((f) => f.root === root) || null;
const selectedFolder = () => folderBy(view.root) || state?.folders[0] || null;
const sep = () => (state?.platform === 'win32' ? '\\' : '/');

async function refreshState() {
  state = await api('state:get');
}

// ---------------------------------------------------------------------------
// Status wording
// ---------------------------------------------------------------------------

const SHORT = {
  synced: 'Up to date',
  syncing: 'Syncing...',
  alone: 'Not shared yet',
  offline: 'Offline',
  waiting: 'Waiting for a file',
  paused: 'Paused',
  attention: 'Needs attention',
};

const TONE = { synced: 'ok', syncing: 'busy', alone: 'idle', offline: 'warn', waiting: 'warn', paused: 'muted', attention: 'err' };

function describe(f) {
  const online = f.peers.filter((p) => p.online).length;
  switch (f.state) {
    case 'synced':
      return {
        tone: 'ok',
        icon: 'check',
        title: 'Up to date',
        sub: `${online} of ${plural(f.peers.length, f.peers.some((p) => p.kind === 'cloud') ? 'connection' : 'device')} reachable${f.lastChangeAt ? `. Last change ${ago(f.lastChangeAt)}` : ''}`,
      };
    case 'syncing':
      return { tone: 'busy', icon: 'sync', title: f.message.startsWith('Connecting') ? 'Connecting...' : 'Syncing...', sub: 'Your changes are being exchanged.' };
    case 'alone':
      return { tone: 'idle', icon: 'laptop', title: 'Not shared with another device yet', sub: 'Add another device to start syncing this folder.' };
    case 'offline':
      return { tone: 'warn', icon: 'alert', title: 'Cannot reach your other devices', sub: 'Changes are saved here and will sync as soon as they are back.' };
    case 'waiting':
      return { tone: 'warn', icon: 'alert', title: 'Waiting for a file to be closed', sub: f.message };
    case 'paused':
      return { tone: 'muted', icon: 'pause', title: 'Paused', sub: 'Changes are not being sent or received.' };
    default:
      return { tone: 'err', icon: 'alert', title: 'Needs attention', sub: f.message };
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSidebar() {
  const folders = state.folders;
  const current = selectedFolder();
  sidebar.innerHTML = `
    <div class="brand"><img src="logo.png" alt="" width="28" height="28"><span>MySync</span></div>
    <nav class="folders" aria-label="Synced folders">
      ${folders.length ? '<div class="nav-label">Your folders</div>' : ''}
      ${
        folders.length
          ? folders
              .map(
                (f) => `
        <button class="nav-item ${view.name === 'folder' && current?.root === f.root ? 'active' : ''}" data-action="select" data-root="${esc(f.root)}" title="${esc(f.root)}">
          <span class="dot ${TONE[f.state] || 'idle'}"></span>
          <span class="nav-text"><span class="nav-title">${esc(f.name)}</span><span class="nav-sub">${esc(SHORT[f.state] || f.state)}</span></span>
        </button>`,
              )
              .join('')
          : '<div class="empty-nav">No folders yet.</div>'
      }
    </nav>
    <div class="sidebar-actions">
      <button class="btn primary block" data-action="add">${icon('plus')} Sync a folder</button>
      <button class="btn block" data-action="join">${icon('link')} Join a folder</button>
      <button class="nav-item small ${view.name === 'settings' ? 'active' : ''}" data-action="settings">${icon('sliders')} Settings</button>
    </div>`;
}

function engineBanner() {
  if (state.engine.ready && !state.engine.error) return '';
  if (state.engine.error) {
    return `<div class="notice err">${icon('alert')}<div><h3>The sync engine is not running</h3><p>${esc(state.engine.error)}</p></div></div>`;
  }
  return `<div class="notice">${icon('info')}<div><h3>Starting up...</h3><p>MySync is getting ready.</p></div></div>`;
}

function welcomeHtml() {
  return `
    <div class="content">
      ${engineBanner()}
      <section class="hero">
        <img src="logo.png" alt="" width="84" height="84">
        <h1>Keep your folders in sync</h1>
        <p>Choose a folder on this PC and MySync keeps it identical on all your devices. No account needed, and it works directly between devices on the same network.</p>
        <div class="hero-actions">
          <button class="btn primary large" data-action="add">${icon('plus')} Sync a folder from this PC</button>
          <button class="btn large" data-action="join">${icon('link')} Join a folder from another device</button>
        </div>
        <ul class="tips">
          <li>${icon('sync')}<div><b>Changes sync by themselves</b><span>Save a file and it shows up on your other devices within seconds.</span></div></li>
          <li>${icon('shield')}<div><b>Nothing is lost</b><span>If two devices edit the same file, MySync keeps both versions.</span></div></li>
          <li>${icon('monitor')}<div><b>Private by default</b><span>Your files go straight between your own devices, protected by a secret invite code.</span></div></li>
        </ul>
      </section>
    </div>`;
}

const cloudIdOf = (peerName) => String(peerName).replace(/^cloud-/, '');

function deviceRow(p, f) {
  if (p.kind === 'cloud') return cloudRow(p, f);
  const internet = p.kind === 'internet';
  let chip = '<span class="chip">Connecting...</span>';
  if (p.online === true) chip = '<span class="chip ok">Online</span>';
  else if (p.online === false) chip = '<span class="chip warn">Offline</span>';
  const sub = p.online === false && p.error ? p.error : internet ? 'Over the internet' : 'On your network';
  return `
    <div class="row">
      <div class="row-icon">${icon(internet ? 'cloud' : 'monitor')}</div>
      <div class="grow"><div class="title">${esc(internet ? 'Internet server' : p.label)}</div><div class="sub">${esc(sub)}</div></div>
      ${chip}
    </div>`;
}

function cloudRow(p, f) {
  const account = state.cloud.accounts.find((a) => a.id === cloudIdOf(p.name));
  let chip = '<span class="chip">Connecting...</span>';
  if (p.online === true) chip = '<span class="chip ok">Connected</span>';
  else if (p.online === false) chip = '<span class="chip warn">Not reachable</span>';
  const sub = p.online === false && p.error ? p.error : `Cloud storage${account?.detail ? ` · ${account.detail}` : ''}`;
  return `
    <div class="row">
      <div class="row-icon">${icon('cloud')}</div>
      <div class="grow"><div class="title">${esc(p.label)}</div><div class="sub">${esc(sub)}</div></div>
      ${chip}
      <button class="btn ghost" data-action="cloud-unlink" data-root="${esc(f.root)}" data-id="${esc(cloudIdOf(p.name))}" title="Stop keeping this folder in ${esc(p.label)}">Disconnect</button>
    </div>`;
}

function folderHtml(f) {
  const s = describe(f);
  const missing = !!f.missing;
  const conflicts = f.conflicts.slice(0, 5);
  const extraConflicts = f.conflicts.length - conflicts.length;

  return `
    <div class="content">
      ${engineBanner()}
      <header class="page-head">
        <div>
          <h1>${esc(f.name)}</h1>
          <div class="path" title="${esc(f.root)}">${esc(f.root)}</div>
        </div>
        <div class="head-actions">
          <button class="btn" data-action="open-folder" data-root="${esc(f.root)}" ${missing ? 'disabled' : ''}>${icon('external')} Open folder</button>
          <button class="btn primary" data-action="share" data-root="${esc(f.root)}" ${missing ? 'disabled' : ''}>${icon('plus')} Add another device</button>
        </div>
      </header>

      <section class="status-card tone-${s.tone}" aria-live="polite">
        <div class="status-badge">${icon(s.icon)}</div>
        <div class="status-text"><div class="status-title">${esc(s.title)}</div><div class="status-sub">${esc(s.sub)}</div></div>
        ${
          missing
            ? ''
            : `<div class="status-actions">
          <button class="btn ghost" data-action="sync-now" data-root="${esc(f.root)}">${icon('sync')} Sync now</button>
          <button class="btn ghost" data-action="${f.paused ? 'resume' : 'pause'}" data-root="${esc(f.root)}">${icon(f.paused ? 'play' : 'pause')} ${f.paused ? 'Resume' : 'Pause'}</button>
        </div>`
        }
      </section>

      ${
        conflicts.length
          ? `<section class="notice">${icon('alert')}<div class="grow">
          <h3>${plural(f.conflicts.length, 'file')} changed on two devices</h3>
          <p>Both versions were kept. In text files they are inside the file, between &lt;&lt;&lt;&lt;&lt;&lt;&lt; and &gt;&gt;&gt;&gt;&gt;&gt;&gt; lines. For other files the older one sits beside it as “name.conflict-…”.</p>
          <ul>${conflicts
            .map(
              (c) => `<li><span class="file">${esc(c.path)}</span><button class="btn" data-action="reveal" data-root="${esc(f.root)}" data-rel="${esc(c.path)}">Show in folder</button></li>`,
            )
            .join('')}${extraConflicts > 0 ? `<li><span>and ${extraConflicts} more</span></li>` : ''}</ul>
        </div></section>`
          : ''
      }

      ${
        f.skipped.length
          ? `<section class="notice">${icon('info')}<div>
          <h3>${plural(f.skipped.length, 'file')} too large to sync</h3>
          <p>Files over 100 MB are not synced yet: ${f.skipped
            .slice(0, 3)
            .map((x) => `${esc(x.path)} (${fmtBytes(x.size)})`)
            .join(', ')}${f.skipped.length > 3 ? ', ...' : ''}</p>
        </div></section>`
          : ''
      }

      ${
        missing
          ? ''
          : `<section class="card">
        <h2>Devices</h2>
        ${
          f.peers.length
            ? `<div class="rows">${f.peers.map((p) => deviceRow(p, f)).join('')}</div>`
            : `<p class="empty">No other devices yet. Choose “Add another device” to get an invite code.</p>`
        }
      </section>

      <section class="card activity">
        <h2>Recent activity</h2>
        ${
          f.activity.length
            ? `<div class="rows">${f.activity
                .slice(0, 12)
                .map(
                  (a) => `<div class="row"><span class="act-dot ${esc(a.kind)}"></span><div class="grow">${esc(a.text)}</div><div class="when">${esc(ago(a.at))}</div></div>`,
                )
                .join('')}</div>`
            : '<p class="empty">Nothing yet. Changes will show up here.</p>'
        }
      </section>`
      }

      <div class="footer-actions"><button class="link-btn" data-action="remove" data-root="${esc(f.root)}">Stop syncing this folder</button></div>
    </div>`;
}

function settingsHtml() {
  const s = state.settings;
  const hub = state.hub;
  return `
    <div class="content">
      <header class="page-head"><div><h1>Settings</h1></div></header>
      <div class="settings-grid">
        <section class="card">
          <h2>This PC</h2>
          <div class="field">
            <label for="set-device">Name shown on your other devices</label>
            <div class="input-row"><input class="input" id="set-device" maxlength="40" value="${esc(s.deviceName)}"><button class="btn" data-action="save-device">Save</button></div>
          </div>
        </section>

        <section class="card">
          <h2>Startup</h2>
          <label class="switch"><input type="checkbox" id="set-auto" data-change="autostart" ${s.autoStart ? 'checked' : ''} ${s.canAutoStart ? '' : 'disabled'}>
            <span>Start MySync when I sign in to Windows</span></label>
          ${s.canAutoStart ? '' : '<p class="hint mt8">Available in the installed version of MySync.</p>'}
        </section>

        <section class="card">
          <h2>Internet sync <span class="chip ml">optional</span></h2>
          <p class="hint mb14">Devices on the same network find each other automatically. To sync devices that are far apart, enter the address of a MySync server. Ask whoever set one up for you.</p>
          <div class="field"><label for="hub-url">Server address</label><input class="input" id="hub-url" placeholder="https://sync.example.com" value="${esc(hub?.url || '')}"></div>
          <div class="field"><label for="hub-secret">Server password</label><input class="input" id="hub-secret" type="password" autocomplete="off" placeholder="${hub?.hasSecret ? 'Saved (leave empty to keep it)' : 'If the server needs one'}"></div>
          <div class="form-row">
            <button class="btn" data-action="hub-test">Test connection</button>
            <button class="btn primary" data-action="hub-save">Save</button>
            <span class="inline-result" id="hub-result" role="status"></span>
          </div>
        </section>

        <section class="card">
          <h2>Cloud storage <span class="chip ml">optional</span></h2>
          <p class="hint mb14">Sync through storage you already have: Google Drive, OneDrive, MEGA, Dropbox, Nextcloud and more. Your devices stay in sync even when they are never on at the same time, with no server to run.</p>
          ${
            state.cloud.accounts.length
              ? `<div class="rows mb14">${state.cloud.accounts
                  .map(
                    (a) => `<div class="row"><div class="row-icon">${icon('cloud')}</div><div class="grow"><div class="title">${esc(a.label)}</div><div class="sub">${esc(a.detail || a.providerLabel)}</div></div>
                    <button class="btn ghost" data-action="cloud-remove" data-id="${esc(a.id)}">Remove</button></div>`,
                  )
                  .join('')}</div>`
              : ''
          }
          <div class="form-row"><button class="btn primary" data-action="cloud-add">${icon('plus')} Connect cloud storage</button></div>
        </section>

        <section class="card">
          <h2>About</h2>
          <div class="rows">
            <div class="row"><div class="grow"><div class="title">MySync ${esc(state.version)}</div><div class="sub">${state.engine.port ? `Listening for other devices on port ${esc(state.engine.port)}` : 'Not accepting connections from other devices right now'}</div></div>
              <button class="btn" data-action="open-logs">Open log folder</button></div>
          </div>
        </section>
      </div>
    </div>`;
}

let lastViewKey = '';

function renderMain() {
  // Keep the scroll position while the same page refreshes, but start at the top on a new page.
  const key = view.name === 'settings' ? 'settings' : `folder:${selectedFolder()?.root || ''}`;
  const top = key === lastViewKey ? main.scrollTop : 0;
  lastViewKey = key;
  if (view.name === 'settings') {
    main.innerHTML = settingsHtml();
  } else {
    const f = selectedFolder();
    main.innerHTML = f ? folderHtml(f) : welcomeHtml();
  }
  main.scrollTop = top;
}

function renderAll() {
  if (!state) return;
  renderSidebar();
  renderMain();
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function showDialog(html) {
  dialog.innerHTML = `<div class="dlg">${html}</div>`;
  if (!dialog.open) dialog.showModal();
}

function closeDialog(result = false) {
  const resolve = dialogResolver;
  dialogResolver = null;
  const extra = !!$('#dlg-extra')?.checked;
  if (dialog.open) dialog.close();
  dialog.innerHTML = '';
  resolve?.(result, extra);
}

dialog.addEventListener('close', () => {
  const resolve = dialogResolver;
  dialogResolver = null;
  resolve?.(false);
});
dialog.addEventListener('cancel', (event) => {
  if (dialog.dataset.locked) event.preventDefault();
});
dialog.addEventListener('click', (event) => {
  if (event.target === dialog && !dialog.dataset.locked) closeDialog(false);
});

/** Yes/no question. Resolves { ok, extra } where extra is the optional checkbox. */
function confirmDialog({ title, body, confirm = 'OK', danger = false, extra = null }) {
  showDialog(`
    <h2>${esc(title)}</h2>
    <p>${body}</p>
    ${extra ? `<label class="switch"><input type="checkbox" id="dlg-extra"><span>${esc(extra)}</span></label>` : ''}
    <div class="actions">
      <button class="btn" data-action="dlg-no">Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-action="dlg-yes" autofocus>${esc(confirm)}</button>
    </div>`);
  return new Promise((resolve) => {
    dialogResolver = (result, extra) => resolve(result === 'yes' ? { ok: true, extra: !!extra } : { ok: false, extra: false });
  });
}

function showOnboarding() {
  dialog.dataset.locked = '1';
  const s = state.settings;
  showDialog(`
    <h2>Welcome to MySync</h2>
    <p>Two quick things before you start.</p>
    <div class="field flush">
      <label for="ob-name">What should this PC be called?</label>
      <input class="input" id="ob-name" maxlength="40" value="${esc(s.deviceName)}">
      <span class="note">Your other devices will see this name.</span>
    </div>
    <label class="switch"><input type="checkbox" id="ob-auto" ${s.autoStart ? 'checked' : ''} ${s.canAutoStart ? '' : 'disabled'}><span>Start MySync when I sign in to Windows</span></label>
    <div class="callout info">${icon('info')}<span>Windows may ask whether MySync can use your network. Choose <b>Private networks</b> so your devices can find each other.</span></div>
    <div class="actions"><button class="btn primary" data-action="finish-onboarding" autofocus>Get started</button></div>`);
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

async function addFlow() {
  try {
    const root = await api('folder:pick', { title: 'Choose a folder to keep in sync' });
    if (!root) return;
    const { estimate } = await api('folder:inspect', { root });
    const big = estimate.bytes > 2 * 1024 ** 3 || estimate.files > 50_000 || estimate.truncated;
    if (big) {
      const more = estimate.truncated ? '+' : '';
      const answer = await confirmDialog({
        title: 'This is a big folder',
        body: `It has ${estimate.files.toLocaleString()}${more} files (${fmtBytes(estimate.bytes)}${more}). MySync keeps a hidden copy of your files to track changes, so it needs about as much extra disk space, and the first sync can take a while.`,
        confirm: 'Sync it anyway',
      });
      if (!answer.ok) return;
    }
    const snap = await api('folder:add', { root });
    await refreshState();
    view = { name: 'folder', root: snap.root };
    renderAll();
    await shareFlow(snap.root, { fresh: true });
  } catch (err) {
    toast(err.message, 'err');
  }
}

function shareCloudHtml(f, { busy = false, error = '' } = {}) {
  const linked = f.peers.filter((p) => p.kind === 'cloud');
  const free = state.cloud.accounts.filter((a) => !linked.some((p) => cloudIdOf(p.name) === a.id));
  const already = linked.length
    ? `<div class="callout info">${icon('cloud')}<span>Also kept in <b>${esc(linked.map((p) => p.label).join(', '))}</b>. On another device, connect the same cloud storage, then choose <b>Join a folder</b> and <b>From cloud storage</b>.</span></div>`
    : '';
  if (!state.cloud.accounts.length) {
    return `<div class="callout info">${icon('cloud')}<span>Use Google Drive, OneDrive, MEGA or Dropbox so devices can sync without being on at the same time. <button class="link-btn accent" data-action="go-settings">Connect cloud storage</button></span></div>`;
  }
  if (!free.length) return already;
  const suggestion = f.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const dis = busy ? 'disabled' : '';
  return `
    ${already}
    <div class="divider"></div>
    <div class="field flush">
      <label for="cloud-acct">Also keep it in your cloud storage</label>
      <div class="input-row">
        <select class="input" id="cloud-acct" ${dis}>${free.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}${a.detail ? ` (${esc(a.detail)})` : ''}</option>`).join('')}</select>
        <input class="input" id="cloud-name" maxlength="63" value="${esc(suggestion)}" aria-label="Name in the cloud" ${dis}>
        <button class="btn" data-action="cloud-link" data-root="${esc(f.root)}" ${dis}>${busy ? '<span class="spinner"></span>' : icon('cloud')} Keep in cloud</button>
      </div>
      <span class="note">Stored in a “MySync” folder there. The first upload runs in the background.</span>
      ${error ? `<span class="inline-result err" role="alert">${esc(error)}</span>` : ''}
    </div>`;
}

function shareHtml(f, code, { fresh = false, busy = false, error = '', cloudBusy = false, cloudError = '' } = {}) {
  let internet;
  if (f.hub) {
    internet = `<div class="callout info">${icon('cloud')}<span>This folder is also available over the internet as <b>${esc(f.hub.workspace)}</b>, so devices on other networks can join too.</span></div>`;
  } else if (state.hub) {
    const suggestion = f.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    internet = `
      <div class="divider"></div>
      <div class="field flush">
        <label for="pub-name">Also let devices on other networks join</label>
        <div class="input-row"><input class="input" id="pub-name" maxlength="63" value="${esc(suggestion)}"><button class="btn" data-action="publish" data-root="${esc(f.root)}" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner"></span>' : icon('cloud')} Put online</button></div>
        <span class="note">Uses your MySync server. The name can only contain letters, numbers, dots, dashes and underscores.</span>
        ${error ? `<span class="inline-result err" role="alert">${esc(error)}</span>` : ''}
      </div>`;
  } else {
    internet = `<div class="callout info">${icon('cloud')}<span>Want to sync devices that are not on the same network? Set up a MySync server in <button class="link-btn accent" data-action="go-settings">Settings</button>.</span></div>`;
  }

  return `
    <h2>${fresh ? `Now syncing “${esc(f.name)}”` : 'Add another device'}</h2>
    <ol class="steps">
      <li>Install MySync on the other device.</li>
      <li>Choose <b>Join a folder</b>.</li>
      <li>Paste this invite code.</li>
    </ol>
    <div class="code-box"><code id="invite-code">${esc(code)}</code><button class="btn primary" data-action="copy-code">${icon('copy')} Copy</button></div>
    <div class="callout">${icon('shield')}<span>Anyone with this code can read and change this folder. Only share it with your own devices or people you trust.</span></div>
    ${internet}
    ${shareCloudHtml(f, { busy: cloudBusy, error: cloudError })}
    <div class="actions"><button class="btn primary" data-action="dlg-no" autofocus>Done</button></div>`;
}

async function shareFlow(root, { fresh = false } = {}) {
  try {
    const f = folderBy(root);
    const { code } = await api('folder:invite', { root });
    showDialog(shareHtml(f, code, { fresh }));
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function publishFlow(root) {
  const name = $('#pub-name')?.value.trim();
  const f = folderBy(root);
  const code = $('#invite-code')?.textContent || '';
  showDialog(shareHtml(f, code, { busy: true }));
  $('#pub-name').value = name;
  try {
    const result = await api('folder:publish', { root, name });
    await refreshState();
    renderAll();
    showDialog(shareHtml(folderBy(root), result.code));
    toast('Available over the internet', 'ok');
  } catch (err) {
    showDialog(shareHtml(f, code, { error: err.message }));
    $('#pub-name').value = name;
  }
}

function defaultDest(name) {
  const safe = (name || 'Synced folder').replace(/[<>:"/\\|?*]+/g, '-').trim() || 'Synced folder';
  return `${state.defaultJoinBase}${sep()}${safe}`;
}

function joinHtml({ code = '', preview = '', dest, busy = false, error = '' }) {
  return `
    <h2>Join a folder</h2>
    <div class="field flush">
      <label for="join-code">Invite code from your other device</label>
      <textarea class="textarea" id="join-code" placeholder="Paste the code here" spellcheck="false" ${busy ? 'disabled' : ''}>${esc(code)}</textarea>
      <span id="join-preview" class="inline-result" role="status">${preview}</span>
    </div>
    <div class="field flush">
      <label>Save it in</label>
      <div class="input-row"><input class="input" id="join-dest" readonly value="${esc(dest)}"><button class="btn" data-action="choose-dest" ${busy ? 'disabled' : ''}>Change...</button></div>
      <span class="dest">If the folder already has files, they are kept and merged with the synced ones.</span>
    </div>
    ${error ? `<div class="callout" role="alert">${icon('alert')}<span>${esc(error)}</span></div>` : ''}
    ${state.cloud.accounts.length ? `<div class="callout info">${icon('cloud')}<span>No code? Get a folder you keep in your cloud storage: <button class="link-btn accent" data-action="cloud-join" ${busy ? 'disabled' : ''}>From cloud storage</button></span></div>` : ''}
    <div class="actions">
      <button class="btn" data-action="dlg-no" ${busy ? 'disabled' : ''}>Cancel</button>
      <button class="btn primary" data-action="do-join" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner"></span> Connecting...' : 'Join folder'}</button>
    </div>`;
}

function updateJoinPreview(info) {
  const el = $('#join-preview');
  if (!el) return;
  if (!info) {
    el.className = 'inline-result';
    el.textContent = '';
  } else if (info.valid) {
    el.className = 'inline-result ok';
    el.textContent = info.name ? `Recognized: “${info.name}”` : 'Invite code recognized';
  } else {
    el.className = 'inline-result err';
    el.textContent = 'That does not look like a MySync invite code.';
  }
}

async function joinFlow() {
  let clip = null;
  try { clip = await api('invite:clipboard'); } catch { /* clipboard is optional */ }
  joinDraft = { dest: defaultDest(null), custom: false, timer: null };
  showDialog(joinHtml({ code: clip || '', dest: joinDraft.dest }));
  if (clip) inspectCode(clip);
}

async function inspectCode(code) {
  try {
    const info = await api('invite:inspect', { code });
    updateJoinPreview(code.trim() ? info : null);
    if (info.valid && !joinDraft.custom) {
      joinDraft.dest = defaultDest(info.name);
      const input = $('#join-dest');
      if (input) input.value = joinDraft.dest;
    }
  } catch { /* ignore */ }
}

async function doJoin() {
  const code = $('#join-code').value.trim();
  if (!code) return showDialog(joinHtml({ code, dest: joinDraft.dest, error: 'Paste the invite code first.' }));
  showDialog(joinHtml({ code, dest: joinDraft.dest, busy: true }));
  try {
    const snap = await api('folder:join', { code, dest: joinDraft.dest });
    closeDialog();
    await refreshState();
    view = { name: 'folder', root: snap.root };
    renderAll();
    toast(`Joined “${snap.name}”. Files will appear in a moment.`, 'ok');
  } catch (err) {
    showDialog(joinHtml({ code, dest: joinDraft.dest, error: err.message }));
  }
}

// ---- cloud storage ----

const PROVIDERS = [
  { id: 'gdrive', title: 'Google Drive', sub: 'Sign in with your Google account' },
  { id: 'onedrive', title: 'OneDrive', sub: 'Sign in with your Microsoft account' },
  { id: 'mega', title: 'MEGA', sub: 'Your MEGA email and password' },
  { id: 'webdav', title: 'Nextcloud / WebDAV', sub: 'Nextcloud, ownCloud, pCloud, Box, Koofr, a NAS...' },
];

function cloudAddHtml({ error = '' } = {}) {
  const detected = state.cloud.detected;
  return `
    <h2>Connect cloud storage</h2>
    ${
      detected.length
        ? `<p class="hint">Found on this PC. The quickest option: your cloud app does the uploading.</p>
      <div class="rows">${detected
        .map(
          (d) => `<div class="row"><div class="row-icon">${icon('folder')}</div><div class="grow"><div class="title">${esc(d.label)}</div><div class="sub">${esc(d.path)}</div></div>
          <button class="btn primary" data-action="cloud-use-folder" data-path="${esc(d.path)}">Use</button></div>`,
        )
        .join('')}</div>`
        : ''
    }
    <p class="hint">${detected.length ? 'Or connect directly:' : 'Choose where to keep your folders:'}</p>
    <div class="rows">
      ${PROVIDERS.map(
        (p) => `<div class="row"><div class="row-icon">${icon('cloud')}</div><div class="grow"><div class="title">${esc(p.title)}</div><div class="sub">${esc(p.sub)}</div></div>
        <button class="btn" data-action="cloud-provider" data-provider="${p.id}">Connect</button></div>`,
      ).join('')}
      <div class="row"><div class="row-icon">${icon('folder')}</div><div class="grow"><div class="title">Another folder</div><div class="sub">Any folder your cloud app (Dropbox, iCloud, MEGA...) keeps in sync</div></div>
        <button class="btn" data-action="cloud-pick-folder">Choose...</button></div>
    </div>
    ${error ? `<div class="callout" role="alert">${icon('alert')}<span>${esc(error)}</span></div>` : ''}
    <div class="actions"><button class="btn" data-action="dlg-no">Close</button></div>`;
}

function cloudFormHtml(provider, { busy = false, error = '', values = {} } = {}) {
  const dis = busy ? 'disabled' : '';
  const field = (id, label, type = 'text', placeholder = '') =>
    `<div class="field flush"><label for="${id}">${label}</label><input class="input" id="${id}" type="${type}" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(values[id] || '')}" ${dis}></div>`;
  let title;
  let fields;
  let note;
  if (provider === 'mega') {
    title = 'Connect MEGA';
    fields = field('cf-email', 'Email', 'email') + field('cf-pass', 'Password', 'password');
    note = 'Saved on this PC only, in your user profile. Accounts with two-step login are not supported yet: use the MEGA desktop app’s folder instead.';
  } else if (provider === 'webdav') {
    title = 'Connect Nextcloud or WebDAV';
    fields = field('cf-url', 'WebDAV address', 'url', 'https://cloud.example.com/remote.php/dav/files/you') + field('cf-user', 'User name') + field('cf-pass', 'Password or app password', 'password');
    note = 'Find the address in your service’s settings (Nextcloud: Files, then Settings, then WebDAV). An app password is safer than your main one.';
  } else {
    const name = provider === 'gdrive' ? 'Google Drive' : 'OneDrive';
    title = `Set up ${name} sign-in`;
    fields = field('cf-client', 'App (client) ID') + (provider === 'gdrive' ? field('cf-secret', 'Client secret', 'password') : '');
    note =
      provider === 'gdrive'
        ? 'This copy of MySync has no Google app ID yet. Create a “Desktop app” OAuth client in Google Cloud Console (with the Google Drive API turned on) and paste its ID and secret here. You only do this once.'
        : 'This copy of MySync has no Microsoft app ID yet. Register an app in the Azure portal (platform “Mobile and desktop applications”, redirect URI http://localhost) and paste its Application (client) ID here. You only do this once.';
  }
  return `
    <h2>${esc(title)}</h2>
    ${fields}
    <p class="hint">${esc(note)}</p>
    ${error ? `<div class="callout" role="alert">${icon('alert')}<span>${esc(error)}</span></div>` : ''}
    <div class="actions">
      <button class="btn" data-action="cloud-add" ${dis}>Back</button>
      <button class="btn primary" data-action="cloud-submit" data-provider="${provider}" ${dis}>${busy ? '<span class="spinner"></span> Connecting...' : 'Connect'}</button>
    </div>`;
}

function readForm() {
  const values = {};
  for (const el of dialog.querySelectorAll('input[id^="cf-"]')) values[el.id] = el.value;
  return values;
}

async function cloudAddFlow(error = '') {
  try {
    await api('cloud:refresh');
    await refreshState();
  } catch { /* show what we have */ }
  showDialog(cloudAddHtml({ error }));
}

function cloudConnected(account) {
  closeDialog();
  refreshState().then(renderAll);
  toast(`Connected ${account.label}${account.detail ? ` (${account.detail})` : ''}`, 'ok');
}

async function cloudUseFolder(dir) {
  try {
    cloudConnected(await api('cloud:add-folder', { path: dir }));
  } catch (err) {
    showDialog(cloudAddHtml({ error: err.message }));
  }
}

async function cloudSignIn(provider) {
  const name = provider === 'gdrive' ? 'Google Drive' : 'OneDrive';
  if (!state.cloud.apps?.[provider]) return showDialog(cloudFormHtml(provider));
  dialog.dataset.locked = '1';
  showDialog(`
    <h2>Sign in to ${esc(name)}</h2>
    <p>Your browser opened ${esc(name)}’s sign-in page. Sign in there and allow MySync, then come back here.</p>
    <div class="callout info">${icon('shield')}<span>MySync only asks for its own folder, so it cannot see the rest of your files.</span></div>
    <div class="actions"><span class="spinner"></span><button class="btn" data-action="cloud-signin-cancel">Cancel</button></div>`);
  try {
    const account = await api('cloud:signin', { provider });
    delete dialog.dataset.locked;
    cloudConnected(account);
  } catch (err) {
    delete dialog.dataset.locked;
    showDialog(cloudAddHtml({ error: err.message }));
  }
}

async function cloudSubmit(provider) {
  const values = readForm();
  showDialog(cloudFormHtml(provider, { busy: true, values }));
  try {
    if (provider === 'mega') {
      cloudConnected(await api('cloud:add-mega', { email: values['cf-email'], password: values['cf-pass'] }));
    } else if (provider === 'webdav') {
      cloudConnected(await api('cloud:add-webdav', { url: values['cf-url'], username: values['cf-user'], password: values['cf-pass'] }));
    } else {
      if (!values['cf-client']?.trim()) throw new Error('Paste the app ID first.');
      await api('cloud:app', { provider, clientId: values['cf-client'], clientSecret: values['cf-secret'] });
      await refreshState();
      await cloudSignIn(provider);
    }
  } catch (err) {
    showDialog(cloudFormHtml(provider, { error: err.message, values }));
  }
}

async function cloudRemoveFlow(id) {
  const account = state.cloud.accounts.find((a) => a.id === id);
  if (!account) return;
  const answer = await confirmDialog({
    title: `Remove ${account.label}?`,
    body: 'Folders stop syncing through it on this PC. Nothing is deleted, here or in the cloud, and your other devices are not affected.',
    confirm: 'Remove',
    danger: true,
  });
  if (!answer.ok) return;
  try {
    await api('cloud:remove', { id });
    await refreshState();
    renderAll();
    toast(`Removed ${account.label}`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function cloudLinkFlow(root) {
  const id = $('#cloud-acct')?.value;
  const name = $('#cloud-name')?.value.trim();
  const code = $('#invite-code')?.textContent || '';
  const f = folderBy(root);
  showDialog(shareHtml(f, code, { cloudBusy: true }));
  try {
    await api('cloud:link', { root, id, name });
    await refreshState();
    renderAll();
    showDialog(shareHtml(folderBy(root), code));
    toast('This folder is now kept in your cloud storage too', 'ok');
  } catch (err) {
    showDialog(shareHtml(f, code, { cloudError: err.message }));
    if ($('#cloud-acct')) $('#cloud-acct').value = id;
    if ($('#cloud-name')) $('#cloud-name').value = name;
  }
}

async function cloudUnlinkFlow(root, id) {
  const label = state.cloud.accounts.find((a) => a.id === id)?.label || 'cloud storage';
  const answer = await confirmDialog({
    title: `Stop keeping this folder in ${label}?`,
    body: `This PC stops syncing it through ${esc(label)}. Your files and the copy in the cloud stay where they are.`,
    confirm: 'Disconnect',
    danger: true,
  });
  if (!answer.ok) return;
  try {
    await api('cloud:unlink', { root, id });
    await refreshState();
    renderAll();
  } catch (err) {
    toast(err.message, 'err');
  }
}

let cloudJoinDraft = null;

function cloudJoinHtml({ busy = false, error = '' } = {}) {
  const d = cloudJoinDraft;
  const dis = busy ? 'disabled' : '';
  let list;
  if (d.loading) list = '<p class="hint"><span class="spinner"></span> Looking...</p>';
  else if (d.listError) list = `<div class="callout" role="alert">${icon('alert')}<span>${esc(d.listError)}</span></div>`;
  else if (!d.workspaces.length) list = '<p class="empty">No folders to join there yet. On the device that has the folder, choose “Add another device”, then “Keep in cloud”.</p>';
  else {
    list = `<div class="rows">${d.workspaces
      .map(
        (w) => `<label class="row"><input type="radio" name="cloud-ws" value="${esc(w.name)}" ${d.name === w.name ? 'checked' : ''} ${dis}>
        <div class="grow"><div class="title">${esc(w.name)}</div><div class="sub">${esc(w.devices.length ? `From ${w.devices.map((x) => x.device).join(', ')}` : 'No devices yet')}${w.updatedAt ? ` · changed ${esc(ago(w.updatedAt))}` : ''}</div></div></label>`,
      )
      .join('')}</div>`;
  }
  return `
    <h2>Join from cloud storage</h2>
    <div class="field flush">
      <label for="cj-acct">Cloud storage</label>
      <select class="input" id="cj-acct" data-change="cloud-join-acct" ${dis}>${state.cloud.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === d.id ? 'selected' : ''}>${esc(a.label)}${a.detail ? ` (${esc(a.detail)})` : ''}</option>`).join('')}</select>
    </div>
    ${list}
    <div class="field flush">
      <label>Save it in</label>
      <div class="input-row"><input class="input" id="join-dest" readonly value="${esc(d.dest)}"><button class="btn" data-action="cloud-join-dest" ${dis}>Change...</button></div>
      <span class="dest">If the folder already has files, they are kept and merged with the synced ones.</span>
    </div>
    ${error ? `<div class="callout" role="alert">${icon('alert')}<span>${esc(error)}</span></div>` : ''}
    <div class="actions">
      <button class="btn" data-action="dlg-no" ${dis}>Cancel</button>
      <button class="btn primary" data-action="cloud-do-join" ${busy || !d.name ? 'disabled' : ''}>${busy ? '<span class="spinner"></span> Joining...' : 'Join folder'}</button>
    </div>`;
}

async function cloudJoinLoad(id) {
  cloudJoinDraft = { ...cloudJoinDraft, id, loading: true, listError: '', workspaces: [], name: null };
  showDialog(cloudJoinHtml());
  try {
    const workspaces = await api('cloud:workspaces', { id });
    if (cloudJoinDraft.id !== id) return;
    // Folders already synced on this PC are not offered again.
    const local = new Set(state.folders.map((f) => f.folderId).filter(Boolean));
    cloudJoinDraft.workspaces = workspaces.filter((w) => !local.has(w.folderId));
    cloudJoinDraft.name = cloudJoinDraft.workspaces[0]?.name || null;
    if (!cloudJoinDraft.custom) cloudJoinDraft.dest = defaultDest(cloudJoinDraft.name);
  } catch (err) {
    cloudJoinDraft.listError = err.message;
  }
  cloudJoinDraft.loading = false;
  showDialog(cloudJoinHtml());
}

function cloudJoinFlow() {
  cloudJoinDraft = { id: state.cloud.accounts[0]?.id, workspaces: [], name: null, dest: defaultDest(null), custom: false };
  cloudJoinLoad(cloudJoinDraft.id);
}

async function cloudDoJoin() {
  const d = cloudJoinDraft;
  if (!d.name) return;
  showDialog(cloudJoinHtml({ busy: true }));
  try {
    const snap = await api('cloud:join', { id: d.id, name: d.name, dest: d.dest });
    closeDialog();
    await refreshState();
    view = { name: 'folder', root: snap.root };
    renderAll();
    toast(`Joined “${snap.name}”. Files will appear in a moment.`, 'ok');
  } catch (err) {
    showDialog(cloudJoinHtml({ error: err.message }));
  }
}

async function removeFlow(root) {
  const f = folderBy(root);
  if (!f) return;
  const answer = await confirmDialog({
    title: `Stop syncing “${f.name}”?`,
    body: 'Your files stay exactly where they are, and your other devices keep their copies. This PC just stops sending and receiving changes for this folder.',
    confirm: 'Stop syncing',
    danger: true,
    extra: 'Also remove MySync’s hidden data from this folder',
  });
  if (!answer.ok) return;
  try {
    await api('folder:remove', { root, forget: answer.extra });
    await refreshState();
    view = { name: 'folder', root: null };
    renderAll();
    toast(`No longer syncing “${f.name}”`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const actions = {
  select: ({ root }) => {
    view = { name: 'folder', root };
    renderAll();
  },
  settings: () => {
    view = { name: 'settings', root: view.root };
    renderAll();
  },
  'go-settings': () => {
    closeDialog();
    actions.settings();
  },
  add: () => addFlow(),
  join: () => joinFlow(),
  share: ({ root }) => shareFlow(root),
  publish: ({ root }) => publishFlow(root),
  'open-folder': ({ root }) => api('folder:open', { root }).catch((err) => toast(err.message, 'err')),
  reveal: ({ root, rel }) => api('folder:reveal', { root, rel }).catch((err) => toast(err.message, 'err')),
  'sync-now': ({ root }) => api('folder:sync', { root }).catch((err) => toast(err.message, 'err')),
  pause: ({ root }) => api('folder:pause', { root }).then(refreshState).then(renderAll).catch((err) => toast(err.message, 'err')),
  resume: ({ root }) => api('folder:resume', { root }).then(refreshState).then(renderAll).catch((err) => toast(err.message, 'err')),
  remove: ({ root }) => removeFlow(root),
  'copy-code': async (_data, el) => {
    await api('clipboard:write', { text: $('#invite-code').textContent });
    el.innerHTML = `${icon('check')} Copied`;
    setTimeout(() => { if (el.isConnected) el.innerHTML = `${icon('copy')} Copy`; }, 1800);
  },
  'choose-dest': async () => {
    const picked = await api('folder:pick', { title: 'Where should this folder be saved?', defaultPath: state.defaultJoinBase }).catch(() => null);
    if (picked) {
      joinDraft.dest = picked;
      joinDraft.custom = true;
      $('#join-dest').value = picked;
    }
  },
  'do-join': () => doJoin(),
  'dlg-yes': () => closeDialog('yes'),
  'dlg-no': () => closeDialog(false),
  'finish-onboarding': async () => {
    try {
      await api('settings:save', { deviceName: $('#ob-name').value, autoStart: $('#ob-auto').checked });
      await api('onboarding:done');
      delete dialog.dataset.locked;
      closeDialog();
      await refreshState();
      renderAll();
    } catch (err) {
      toast(err.message, 'err');
    }
  },
  'save-device': async () => {
    try {
      await api('settings:save', { deviceName: $('#set-device').value });
      await refreshState();
      toast('Saved', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  },
  'hub-test': async () => {
    const result = $('#hub-result');
    result.className = 'inline-result';
    result.textContent = 'Testing...';
    try {
      const res = await api('hub:test', { url: $('#hub-url').value });
      result.className = `inline-result ${res.ok ? 'ok' : 'err'}`;
      result.textContent = res.ok ? 'Connected' : res.error;
    } catch (err) {
      result.className = 'inline-result err';
      result.textContent = err.message;
    }
  },
  'hub-save': async () => {
    try {
      await api('hub:set', { url: $('#hub-url').value, secret: $('#hub-secret').value });
      await refreshState();
      renderMain();
      toast($('#hub-url').value ? 'Internet server saved' : 'Internet server removed', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  },
  'open-logs': () => api('app:logs').catch(() => {}),
  'cloud-add': () => cloudAddFlow(),
  'cloud-use-folder': ({ path }) => cloudUseFolder(path),
  'cloud-pick-folder': async () => {
    const picked = await api('folder:pick', { title: 'Choose a folder your cloud app keeps in sync' }).catch(() => null);
    if (picked) cloudUseFolder(picked);
  },
  'cloud-provider': ({ provider }) => (provider === 'gdrive' || provider === 'onedrive' ? cloudSignIn(provider) : showDialog(cloudFormHtml(provider))),
  'cloud-submit': ({ provider }) => cloudSubmit(provider),
  'cloud-signin-cancel': () => api('cloud:signin-cancel').catch(() => {}),
  'cloud-remove': ({ id }) => cloudRemoveFlow(id),
  'cloud-link': ({ root }) => cloudLinkFlow(root),
  'cloud-unlink': ({ root, id }) => cloudUnlinkFlow(root, id),
  'cloud-join': () => cloudJoinFlow(),
  'cloud-join-dest': async () => {
    const picked = await api('folder:pick', { title: 'Where should this folder be saved?', defaultPath: state.defaultJoinBase }).catch(() => null);
    if (picked) {
      cloudJoinDraft.dest = picked;
      cloudJoinDraft.custom = true;
      $('#join-dest').value = picked;
    }
  },
  'cloud-do-join': () => cloudDoJoin(),
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const handler = actions[el.dataset.action];
  if (handler) handler({ ...el.dataset }, el);
});

document.addEventListener('change', async (event) => {
  if (event.target.dataset.change === 'cloud-join-acct') return cloudJoinLoad(event.target.value);
  if (event.target.name === 'cloud-ws' && cloudJoinDraft) {
    cloudJoinDraft.name = event.target.value;
    if (!cloudJoinDraft.custom) cloudJoinDraft.dest = defaultDest(cloudJoinDraft.name);
    return showDialog(cloudJoinHtml());
  }
  if (event.target.dataset.change === 'autostart') {
    try {
      await api('settings:save', { autoStart: event.target.checked });
    } catch (err) {
      event.target.checked = !event.target.checked;
      toast(err.message, 'err');
    }
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id !== 'join-code') return;
  clearTimeout(joinDraft?.timer);
  joinDraft.timer = setTimeout(() => inspectCode(event.target.value), 250);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  state = await api('state:get');
  renderAll();
  if (!state.onboarded && !onboardingShown) {
    onboardingShown = true;
    showOnboarding();
  }

  window.mysync.onState((next) => {
    state = next;
    renderSidebar();
    if (view.name !== 'settings') renderMain();
  });
  window.mysync.onSelect((root) => {
    view = { name: 'folder', root };
    renderAll();
  });

  // Keep "5 minutes ago" style times fresh.
  setInterval(() => {
    if (state && view.name !== 'settings') renderMain();
  }, 20_000);
}

start().catch((err) => {
  main.innerHTML = `<div class="content"><div class="notice err"><div><h3>MySync could not start</h3><p>${esc(err.message)}</p></div></div></div>`;
});
