// Storage back ends for cloud sync. Each one exposes the same tiny key/value API over
// a "MySync" folder in the provider, with keys like "notes/objects/<hash>":
//   read(key)  -> Buffer | null
//   write(key, data)          (create or replace)
//   list(dir)  -> [{ name, version, dir }]   (version changes whenever the file does)
// Everything above this (what goes where, merging) lives in cloud.js.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

export const ROOT_FOLDER = 'MySync';
const SMALL_UPLOAD = 4 * 1024 * 1024;
const CHUNK = 320 * 1024 * 32; // 10 MiB, a multiple of 320 KiB as OneDrive requires

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An error whose message is already fit to show to a person. */
export function cloudError(message, { code = 'ECLOUD', status, cause } = {}) {
  return Object.assign(new Error(message), { cloud: true, code, status, cause });
}

const splitKey = (key) => String(key).split('/').filter(Boolean);

/**
 * fetch with retries for the things cloud APIs do under load (429, 5xx, dropped
 * connections). Network failures become friendly cloud errors.
 */
async function request(url, options = {}, { label = 'the cloud service', tries = 4, timeout = 120_000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      if (attempt < tries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const code = err?.cause?.code;
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw cloudError(`Cannot reach ${label}. Check your internet connection`, { code: 'ECLOUDNET', cause: err });
      if (err?.name === 'TimeoutError') throw cloudError(`${label} did not answer in time`, { code: 'ECLOUDNET', cause: err });
      throw cloudError(`Cannot connect to ${label}`, { code: 'ECLOUDNET', cause: err });
    }
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await res.arrayBuffer().catch(() => {});
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** attempt);
      continue;
    }
    return res;
  }
}

async function failure(res, label) {
  let detail = '';
  try {
    const data = await res.json();
    detail = data?.error?.message || data?.error_description || (typeof data?.error === 'string' ? data.error : '') || '';
  } catch { /* not JSON */ }
  if (res.status === 401) return cloudError(`${label} signed this PC out. Connect it again in Settings`, { code: 'ECLOUDAUTH', status: 401 });
  if (res.status === 403 && /quota|storage/i.test(detail)) return cloudError(`Your ${label} storage is full`, { code: 'ECLOUDFULL', status: 403 });
  if (res.status === 403) return cloudError(`${label} refused access${detail ? `: ${detail}` : ''}`, { code: 'ECLOUDAUTH', status: 403 });
  if (res.status === 507) return cloudError(`Your ${label} storage is full`, { code: 'ECLOUDFULL', status: 507 });
  return cloudError(`${label} returned an error (${res.status}${detail ? `: ${detail}` : ''})`, { status: res.status });
}

// ---------------------------------------------------------------------------
// A folder on disk: works with any desktop sync client (OneDrive, Google Drive for
// desktop, Dropbox, MEGA, iCloud, a NAS share...). The client does the uploading.
// ---------------------------------------------------------------------------

export class FolderStore {
  constructor({ path: base }) {
    if (!base) throw cloudError('Choose a folder first');
    this.base = path.join(path.resolve(base), ROOT_FOLDER);
    this.label = 'the cloud folder';
  }

  _full(key) {
    return path.join(this.base, ...splitKey(key));
  }

  async check() {
    const parent = path.dirname(this.base);
    if (!fs.existsSync(parent)) throw cloudError('That folder cannot be found. Is the drive connected?', { code: 'ECLOUDGONE' });
    fs.mkdirSync(this.base, { recursive: true });
  }

  async read(key) {
    try {
      return await fs.promises.readFile(this._full(key));
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw cloudError(`Cannot read from the cloud folder (${err.code})`, { cause: err });
    }
  }

  async write(key, data) {
    const full = this._full(key);
    if (!fs.existsSync(path.dirname(this.base))) throw cloudError('That folder cannot be found. Is the drive connected?', { code: 'ECLOUDGONE' });
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    // Write beside, then rename, so a sync client never uploads half a file.
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    await fs.promises.writeFile(tmp, data);
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, full);
        return;
      } catch (err) {
        // A sync client may hold the old file open for a moment.
        if (attempt < 8 && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {
          await sleep(150 * (attempt + 1));
          continue;
        }
        await fs.promises.rm(tmp, { force: true });
        throw cloudError(`Cannot write to the cloud folder (${err.code})`, { cause: err });
      }
    }
  }

  async list(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(this._full(dir), { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
      throw cloudError(`Cannot read the cloud folder (${err.code})`, { cause: err });
    }
    const out = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        out.push({ name: entry.name, dir: true, version: null });
        continue;
      }
      try {
        const stat = await fs.promises.stat(path.join(this._full(dir), entry.name));
        out.push({ name: entry.name, dir: false, version: `${stat.mtimeMs}:${stat.size}` });
      } catch { /* vanished while listing */ }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// WebDAV: Nextcloud, ownCloud, Box, pCloud, Koofr, Synology, many NAS boxes.
// ---------------------------------------------------------------------------

export class WebDavStore {
  constructor({ url, username = '', password = '' }) {
    if (!/^https?:\/\//.test(String(url || ''))) throw cloudError('The WebDAV address must start with https:// (or http://)');
    this.root = `${String(url).replace(/\/+$/, '')}/${ROOT_FOLDER}`;
    this.auth = username || password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : null;
    this.label = new URL(url).host;
    this.madeDirs = new Set();
  }

  _url(key, trailingSlash = false) {
    const parts = splitKey(key).map(encodeURIComponent);
    return `${this.root}${parts.length ? `/${parts.join('/')}` : ''}${trailingSlash ? '/' : ''}`;
  }

  _headers(extra = {}) {
    return this.auth ? { Authorization: this.auth, ...extra } : extra;
  }

  async check() {
    await this._mkdirs([]);
    await this.list('');
  }

  async _mkdirs(parts) {
    for (let i = 0; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (this.madeDirs.has(dir)) continue;
      const res = await request(this._url(dir, true), { method: 'MKCOL', headers: this._headers() }, { label: this.label });
      await res.arrayBuffer().catch(() => {});
      // 405: already exists. 301/302: some servers redirect to the slash form of an existing folder.
      if (!res.ok && ![405, 301, 302].includes(res.status)) throw await failure(res, this.label);
      this.madeDirs.add(dir);
    }
  }

  async read(key) {
    const res = await request(this._url(key), { headers: this._headers() }, { label: this.label });
    if (res.status === 404) return null;
    if (!res.ok) throw await failure(res, this.label);
    return Buffer.from(await res.arrayBuffer());
  }

  async write(key, data) {
    const put = () => request(this._url(key), { method: 'PUT', headers: this._headers({ 'Content-Type': 'application/octet-stream' }), body: data }, { label: this.label });
    let res = await put();
    if (res.status === 409 || res.status === 404) {
      await res.arrayBuffer().catch(() => {});
      await this._mkdirs(splitKey(key).slice(0, -1));
      res = await put();
    }
    if (!res.ok) throw await failure(res, this.label);
    await res.arrayBuffer().catch(() => {});
  }

  async list(dir) {
    const res = await request(this._url(dir, true), {
      method: 'PROPFIND',
      headers: this._headers({ Depth: '1', 'Content-Type': 'application/xml' }),
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>',
    }, { label: this.label });
    if (res.status === 404) return [];
    if (!res.ok) throw await failure(res, this.label);
    const xml = await res.text();
    const self = new URL(this._url(dir, true)).pathname.replace(/\/+$/, '');
    const out = [];
    for (const [, block] of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
      const href = /<(?:[\w-]+:)?href[^>]*>([^<]*)</i.exec(block)?.[1]?.trim();
      if (!href) continue;
      const hrefPath = decodeXml(new URL(href, this.root).pathname).replace(/\/+$/, '');
      if (decodeURIComponent(hrefPath) === decodeURIComponent(self)) continue;
      const name = decodeURIComponent(hrefPath.split('/').pop());
      if (!name || name.startsWith('.')) continue;
      const isDir = /<(?:[\w-]+:)?collection\b/i.test(block);
      const tag = (t) => new RegExp(`<(?:[\\w-]+:)?${t}[^>]*>([^<]*)<`, 'i').exec(block)?.[1] || '';
      out.push({ name, dir: isDir, version: isDir ? null : `${tag('getetag')}|${tag('getlastmodified')}|${tag('getcontentlength')}` });
    }
    return out;
  }
}

const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ---------------------------------------------------------------------------
// OAuth 2 (Google Drive, OneDrive): desktop "loopback" flow with PKCE. MySync opens
// the provider's sign-in page in the browser and catches the answer on 127.0.0.1.
// ---------------------------------------------------------------------------

const env = (name, fallback) => process.env[name] || fallback;

export const OAUTH = {
  gdrive: {
    label: 'Google Drive',
    authUrl: () => env('MYSYNC_GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    tokenUrl: () => env('MYSYNC_GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    // Only files MySync itself creates: it can never see the rest of your Drive.
    scope: 'https://www.googleapis.com/auth/drive.file',
    redirectHost: '127.0.0.1',
    extraAuth: { access_type: 'offline', prompt: 'consent' },
  },
  onedrive: {
    label: 'OneDrive',
    authUrl: () => env('MYSYNC_MS_AUTH_URL', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'),
    tokenUrl: () => env('MYSYNC_MS_TOKEN_URL', 'https://login.microsoftonline.com/common/oauth2/v2.0/token'),
    // Only MySync's own app folder (OneDrive > Apps > MySync).
    scope: 'Files.ReadWrite.AppFolder offline_access',
    redirectHost: 'localhost',
    extraAuth: { prompt: 'select_account' },
  },
};

const PAGE = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:15vh auto;max-width:28em;text-align:center"><h1 style="font-size:22px">${title}</h1><p>${text}</p></body>`;

/**
 * Starts a sign-in. Resolves { url, result } right away: open `url` in a browser;
 * `result` resolves with the tokens once the person approves (or rejects on
 * denial / timeout). `cancel()` gives up early.
 * @param {'gdrive'|'onedrive'} provider
 * @param {{ clientId: string, clientSecret?: string|null, timeoutMs?: number }} options
 */
export function startOAuth(provider, { clientId, clientSecret = null, timeoutMs = 5 * 60_000 }) {
  const spec = OAUTH[provider];
  if (!spec) throw cloudError(`Unknown provider ${provider}`);
  if (!clientId) throw cloudError(`${spec.label} needs an app ID before MySync can connect to it`, { code: 'ENOCLIENT' });

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise((resolveStart, rejectStart) => {
    let settle;
    const result = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    result.catch(() => {}); // the caller may never wait on it if it cancels
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      setTimeout(() => server.close(), 200).unref?.();
      if (err) settle.reject(err);
      else settle.resolve(value);
    };

    let redirectUri;
    const server = http.createServer(async (req, res) => {
      const params = new URL(req.url, 'http://x').searchParams;
      if (!params.has('code') && !params.has('error')) {
        res.writeHead(404).end();
        return;
      }
      const reply = (status, title, text) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE(title, text));
      };
      if (params.get('state') !== state) return reply(400, 'Something went wrong', 'This sign-in link is out of date. Please try again from MySync.');
      if (params.get('error')) {
        reply(200, 'Not connected', 'You can close this tab and go back to MySync.');
        return finish(cloudError(params.get('error') === 'access_denied' ? 'Sign-in was cancelled' : `Sign-in failed: ${params.get('error_description') || params.get('error')}`, { code: 'ECLOUDAUTH' }));
      }
      try {
        const tokens = await tokenRequest(provider, {
          grant_type: 'authorization_code',
          code: params.get('code'),
          redirect_uri: redirectUri,
          code_verifier: verifier,
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        });
        reply(200, `Connected to ${spec.label}`, 'You can close this tab and go back to MySync.');
        finish(null, tokens);
      } catch (err) {
        reply(500, 'Something went wrong', 'MySync could not finish connecting. Please try again.');
        finish(err);
      }
    });
    const timer = setTimeout(() => finish(cloudError('Sign-in took too long. Please try again', { code: 'ECLOUDAUTH' })), timeoutMs);
    timer.unref?.();
    server.on('error', (err) => {
      if (!done) rejectStart(cloudError(`Could not start sign-in (${err.code})`, { cause: err }));
      finish(err);
    });
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://${spec.redirectHost}:${server.address().port}`;
      const url = new URL(spec.authUrl());
      const query = {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: spec.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...spec.extraAuth,
      };
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      resolveStart({ url: url.href, result, cancel: () => finish(cloudError('Sign-in was cancelled', { code: 'ECLOUDAUTH' })) });
    });
  });
}

/** @returns {Promise<{ accessToken: string, refreshToken: string|null, expiresAt: number }>} */
async function tokenRequest(provider, form) {
  const spec = OAUTH[provider];
  const res = await request(spec.tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  }, { label: spec.label });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    if (data.error === 'invalid_grant') throw cloudError(`${spec.label} signed this PC out. Connect it again in Settings`, { code: 'ECLOUDAUTH', status: 401 });
    throw cloudError(`${spec.label} sign-in failed: ${data.error_description || data.error || `HTTP ${res.status}`}`, { code: 'ECLOUDAUTH', status: res.status });
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
}

/**
 * Keeps an access token fresh for one account. `save(patch)` persists rotated tokens.
 */
class TokenSource {
  constructor(provider, account, save) {
    this.provider = provider;
    this.account = account;
    this.save = save;
    this.refreshing = null;
  }

  async get(force = false) {
    const a = this.account;
    if (!force && a.accessToken && a.expiresAt > Date.now() + 60_000) return a.accessToken;
    if (!a.refreshToken) throw cloudError(`${OAUTH[this.provider].label} signed this PC out. Connect it again in Settings`, { code: 'ECLOUDAUTH', status: 401 });
    this.refreshing ??= tokenRequest(this.provider, {
      grant_type: 'refresh_token',
      refresh_token: a.refreshToken,
      client_id: a.clientId,
      ...(a.clientSecret ? { client_secret: a.clientSecret } : {}),
      ...(this.provider === 'onedrive' ? { scope: OAUTH.onedrive.scope } : {}),
    }).then((tokens) => {
      const patch = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
      if (tokens.refreshToken) patch.refreshToken = tokens.refreshToken;
      Object.assign(a, patch);
      this.save?.(patch);
      return tokens.accessToken;
    }).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
}

/** Shared request logic for the OAuth stores: bearer token, one silent refresh on 401. */
class OAuthStore {
  constructor(provider, account, save) {
    this.tokens = new TokenSource(provider, account, save);
    this.label = OAUTH[provider].label;
  }

  async _fetch(url, options = {}, { auth = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      const headers = { ...(options.headers || {}) };
      if (auth) headers.Authorization = `Bearer ${await this.tokens.get(attempt > 0)}`;
      const res = await request(url, { ...options, headers }, { label: this.label });
      if (res.status === 401 && auth && attempt === 0) {
        await res.arrayBuffer().catch(() => {});
        continue;
      }
      return res;
    }
  }

  async _json(url, options = {}) {
    const res = await this._fetch(url, options);
    if (!res.ok) throw await failure(res, this.label);
    return res.json();
  }
}

// ---------------------------------------------------------------------------
// Google Drive (REST v3). Drive addresses files by id, so paths are resolved
// folder by folder and the ids remembered.
// ---------------------------------------------------------------------------

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export class GoogleDriveStore extends OAuthStore {
  constructor(account, save) {
    super('gdrive', account, save);
    this.api = env('MYSYNC_GDRIVE_API', 'https://www.googleapis.com/drive/v3');
    this.upload = env('MYSYNC_GDRIVE_UPLOAD', 'https://www.googleapis.com/upload/drive/v3');
    this.ids = new Map(); // path -> id (folders and files)
    this.making = new Map();
  }

  async check() {
    await this._folderId([], true);
  }

  async whoami() {
    const data = await this._json(`${this.api}/about?fields=user(displayName,emailAddress)`);
    return data.user?.emailAddress || data.user?.displayName || null;
  }

  /** Oldest match wins, so devices that raced to create the same folder still agree. */
  async _find(parentId, name, folder) {
    const query = `${q(parentId)} in parents and name = ${q(name)} and trashed = false and mimeType ${folder ? '=' : '!='} '${FOLDER_MIME}'`;
    const data = await this._json(`${this.api}/files?q=${encodeURIComponent(query)}&orderBy=createdTime&pageSize=10&fields=files(id)&spaces=drive`);
    return data.files?.[0]?.id || null;
  }

  async _folderId(parts, create) {
    let parentId = 'root';
    for (let i = 0; i <= parts.length; i++) {
      const segs = [ROOT_FOLDER, ...parts.slice(0, i)];
      const key = segs.join('/');
      let id = this.ids.get(key);
      if (!id) {
        id = await this._find(parentId, segs[segs.length - 1], true);
        if (!id && !create) return null;
        if (!id) {
          // One creation per path at a time inside this process.
          if (!this.making.has(key)) {
            const name = segs[segs.length - 1];
            const parent = parentId;
            this.making.set(key, (async () => {
              const made = await this._json(`${this.api}/files?fields=id`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
              });
              // Another device may have made it at the same moment: settle on the oldest.
              return (await this._find(parent, name, true)) || made.id;
            })().finally(() => this.making.delete(key)));
          }
          id = await this.making.get(key);
        }
        this.ids.set(key, id);
      }
      parentId = id;
    }
    return parentId;
  }

  async _fileId(key) {
    const parts = splitKey(key);
    const cacheKey = [ROOT_FOLDER, ...parts].join('/');
    if (this.ids.has(cacheKey)) return this.ids.get(cacheKey);
    const parentId = await this._folderId(parts.slice(0, -1), false);
    if (!parentId) return null;
    const id = await this._find(parentId, parts[parts.length - 1], false);
    if (id) this.ids.set(cacheKey, id);
    return id;
  }

  async read(key) {
    const id = await this._fileId(key);
    if (!id) return null;
    const res = await this._fetch(`${this.api}/files/${id}?alt=media`);
    if (res.status === 404) {
      this.ids.delete([ROOT_FOLDER, ...splitKey(key)].join('/'));
      return null;
    }
    if (!res.ok) throw await failure(res, this.label);
    return Buffer.from(await res.arrayBuffer());
  }

  async write(key, data) {
    const parts = splitKey(key);
    const name = parts[parts.length - 1];
    const cacheKey = [ROOT_FOLDER, ...parts].join('/');
    const existing = await this._fileId(key);
    if (existing) {
      const res = await this._fetch(`${this.upload}/files/${existing}?uploadType=media&fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: data,
      });
      if (res.ok) {
        await res.arrayBuffer().catch(() => {});
        return;
      }
      if (res.status !== 404) throw await failure(res, this.label);
      this.ids.delete(cacheKey); // deleted meanwhile: create it again
    }

    const parentId = await this._folderId(parts.slice(0, -1), true);
    const metadata = JSON.stringify({ name, parents: [parentId] });
    let res;
    if (data.length <= SMALL_UPLOAD) {
      const boundary = `mysync${crypto.randomBytes(8).toString('hex')}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      res = await this._fetch(`${this.upload}/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
    } else {
      const start = await this._fetch(`${this.upload}/files?uploadType=resumable&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(data.length) },
        body: metadata,
      });
      if (!start.ok) throw await failure(start, this.label);
      await start.arrayBuffer().catch(() => {});
      res = await this._fetch(start.headers.get('location'), { method: 'PUT', body: data });
    }
    if (!res.ok) throw await failure(res, this.label);
    const made = await res.json().catch(() => ({}));
    if (made.id) this.ids.set(cacheKey, made.id);
  }

  async list(dir) {
    const parts = splitKey(dir);
    const folderId = await this._folderId(parts, false);
    if (!folderId) return [];
    const out = [];
    let pageToken = '';
    do {
      const query = `${q(folderId)} in parents and trashed = false`;
      const data = await this._json(
        `${this.api}/files?q=${encodeURIComponent(query)}&orderBy=createdTime&pageSize=1000&spaces=drive&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,md5Checksum)${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      );
      for (const f of data.files || []) {
        const isDir = f.mimeType === FOLDER_MIME;
        const cacheKey = [ROOT_FOLDER, ...parts, f.name].join('/');
        if (!this.ids.has(cacheKey)) this.ids.set(cacheKey, f.id); // oldest first, so the oldest wins
        if (out.some((o) => o.name === f.name)) continue;
        out.push({ name: f.name, dir: isDir, version: isDir ? null : `${f.modifiedTime}|${f.md5Checksum || f.size || ''}` });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return out;
  }
}

// ---------------------------------------------------------------------------
// OneDrive (Microsoft Graph), inside the app folder: OneDrive > Apps > MySync.
// Graph addresses items by path, which keeps this simple.
// ---------------------------------------------------------------------------

export class OneDriveStore extends OAuthStore {
  constructor(account, save) {
    super('onedrive', account, save);
    this.base = `${env('MYSYNC_GRAPH_API', 'https://graph.microsoft.com/v1.0')}/me/drive/special/approot`;
    this.madeDirs = new Set();
  }

  _item(parts) {
    const all = [ROOT_FOLDER, ...parts].map(encodeURIComponent).join('/');
    return `${this.base}:/${all}:`;
  }

  async check() {
    await this._mkdirs([]);
  }

  async whoami() {
    const data = await this._json(`${this.base.replace(/\/special\/approot$/, '')}?$select=owner`);
    return data.owner?.user?.email || data.owner?.user?.displayName || null;
  }

  async _mkdirs(parts) {
    for (let i = 0; i <= parts.length; i++) {
      const segs = parts.slice(0, i);
      const key = segs.join('/');
      if (this.madeDirs.has(key)) continue;
      const parentUrl = i === 0 ? `${this.base}/children` : `${this._item(parts.slice(0, i - 1))}/children`;
      const name = i === 0 ? ROOT_FOLDER : segs[segs.length - 1];
      const res = await this._fetch(parentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      });
      if (!res.ok && res.status !== 409) throw await failure(res, this.label);
      await res.arrayBuffer().catch(() => {});
      this.madeDirs.add(key);
    }
  }

  async read(key) {
    const res = await this._fetch(`${this._item(splitKey(key))}/content`);
    if (res.status === 404) return null;
    if (!res.ok) throw await failure(res, this.label);
    return Buffer.from(await res.arrayBuffer());
  }

  async write(key, data) {
    const parts = splitKey(key);
    const attempt = async () => {
      if (data.length <= SMALL_UPLOAD) {
        return this._fetch(`${this._item(parts)}/content`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
      }
      const session = await this._fetch(`${this._item(parts)}/createUploadSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
      });
      if (!session.ok) return session;
      const { uploadUrl } = await session.json();
      let res;
      for (let offset = 0; offset < data.length; offset += CHUNK) {
        const piece = data.subarray(offset, Math.min(offset + CHUNK, data.length));
        // The upload URL carries its own authorisation.
        res = await this._fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${offset}-${offset + piece.length - 1}/${data.length}` },
          body: piece,
        }, { auth: false });
        if (!res.ok) return res;
        if (offset + CHUNK < data.length) await res.arrayBuffer().catch(() => {});
      }
      return res;
    };
    let res = await attempt();
    if (res.status === 404 || res.status === 409) {
      await res.arrayBuffer().catch(() => {});
      await this._mkdirs(parts.slice(0, -1));
      res = await attempt();
    }
    if (!res.ok) throw await failure(res, this.label);
    await res.arrayBuffer().catch(() => {});
  }

  async list(dir) {
    const parts = splitKey(dir);
    const out = [];
    let url = `${this._item(parts)}/children?$select=name,eTag,size,folder,lastModifiedDateTime&$top=999`;
    while (url) {
      const res = await this._fetch(url);
      if (res.status === 404) return [];
      if (!res.ok) throw await failure(res, this.label);
      const data = await res.json();
      for (const item of data.value || []) {
        out.push({ name: item.name, dir: !!item.folder, version: item.folder ? null : `${item.eTag}|${item.size}` });
      }
      url = data['@odata.nextLink'] || null;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// MEGA, through the `megajs` package (MEGA encrypts everything client side, so
// there is no plain REST API). It is an optional dependency, loaded on first use.
// ---------------------------------------------------------------------------

let megaModule = null;
async function loadMega() {
  if (!megaModule) {
    try {
      megaModule = await import('megajs');
    } catch {
      throw cloudError('MEGA support is not installed in this copy of MySync (missing the megajs package)', { code: 'ENOMEGA' });
    }
  }
  return megaModule;
}

export class MegaStore {
  constructor({ email, password }) {
    if (!email || !password) throw cloudError('Enter your MEGA email and password');
    this.email = email;
    this.password = password;
    this.label = 'MEGA';
    this.storage = null;
  }

  async _login() {
    if (this.storage) return this.storage;
    const { Storage } = await loadMega();
    try {
      this.storage = await new Storage({ email: this.email, password: this.password, userAgent: 'MySync', keepalive: true }).ready;
    } catch (err) {
      this.storage = null;
      if (/ENOENT|EKEY|-9|password/i.test(String(err?.message))) throw cloudError('MEGA did not accept that email and password', { code: 'ECLOUDAUTH', status: 401 });
      throw cloudError(`Cannot sign in to MEGA: ${err?.message || err}`, { code: 'ECLOUDNET', cause: err });
    }
    return this.storage;
  }

  async _node(parts, create = false) {
    const storage = await this._login();
    let node = storage.root;
    for (const name of [ROOT_FOLDER, ...parts]) {
      let child = (node.children || []).find((c) => c.name === name && c.directory);
      if (!child) {
        if (!create) return null;
        child = await node.mkdir(name);
      }
      node = child;
    }
    return node;
  }

  async check() {
    await this._node([], true);
  }

  async whoami() {
    return this.email;
  }

  async read(key) {
    const parts = splitKey(key);
    const dir = await this._node(parts.slice(0, -1));
    const file = dir && (dir.children || []).find((c) => c.name === parts[parts.length - 1] && !c.directory);
    if (!file) return null;
    try {
      return await file.downloadBuffer({});
    } catch (err) {
      throw cloudError(`Cannot download from MEGA: ${err?.message || err}`, { code: 'ECLOUDNET', cause: err });
    }
  }

  async write(key, data) {
    const parts = splitKey(key);
    const name = parts[parts.length - 1];
    const dir = await this._node(parts.slice(0, -1), true);
    const old = (dir.children || []).filter((c) => c.name === name && !c.directory);
    try {
      const upload = dir.upload({ name, size: data.length, allowUploadBuffering: true }, data);
      await (upload.complete || new Promise((resolve, reject) => upload.once('complete', resolve).once('error', reject)));
      for (const file of old) await file.delete(true); // MEGA has no overwrite: upload, then drop the old one
    } catch (err) {
      throw cloudError(`Cannot upload to MEGA: ${err?.message || err}`, { code: 'ECLOUDNET', cause: err });
    }
  }

  async list(dir) {
    const node = await this._node(splitKey(dir));
    if (!node) return [];
    const out = [];
    for (const c of node.children || []) {
      if (out.some((o) => o.name === c.name)) continue;
      out.push({ name: c.name, dir: !!c.directory, version: c.directory ? null : `${c.timestamp}|${c.size}|${c.nodeId}` });
    }
    return out;
  }
}
