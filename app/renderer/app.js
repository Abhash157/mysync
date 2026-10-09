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
        sub: `${online} of ${plural(f.peers.length, 'device')} reachable${f.lastChangeAt ? `. Last change ${ago(f.lastChangeAt)}` : ''}`,
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

function deviceRow(p) {
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
          <p>MySync kept both versions. The newest one keeps its name and the other sits beside it as “name.conflict-…”.</p>
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
            ? `<div class="rows">${f.peers.map(deviceRow).join('')}</div>`
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

function shareHtml(f, code, { fresh = false, busy = false, error = '' } = {}) {
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
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const handler = actions[el.dataset.action];
  if (handler) handler({ ...el.dataset }, el);
});

document.addEventListener('change', async (event) => {
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
