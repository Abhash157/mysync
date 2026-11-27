// Small in-memory stand-ins for the cloud APIs MySync talks to: just enough of WebDAV,
// Google Drive v3 (+ OAuth) and Microsoft Graph (+ OAuth) to exercise the real code
// paths, including paging, token expiry and large-file uploads.
import http from 'node:http';
import crypto from 'node:crypto';

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const json = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
};

// ---------------------------------------------------------------------------
// OAuth token endpoint shared by both providers
// ---------------------------------------------------------------------------

class Tokens {
  constructor() {
    this.valid = new Set();
    this.refresh = new Set();
    this.counter = 0;
    this.refreshes = 0;
    this.codes = new Map(); // code -> required client id
  }

  issue() {
    const access = `at-${++this.counter}`;
    const refresh = `rt-${crypto.randomBytes(6).toString('hex')}`;
    this.valid.add(access);
    this.refresh.add(refresh);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'Bearer' };
  }

  /** Expire every access token, as if an hour had passed. */
  revokeAccess() {
    this.valid.clear();
  }

  ok(req) {
    const auth = String(req.headers.authorization || '');
    return auth.startsWith('Bearer ') && this.valid.has(auth.slice(7));
  }

  async handle(req, res, { clientId, rotate }) {
    const form = new URLSearchParams((await body(req)).toString());
    if (form.get('client_id') !== clientId) return json(res, 401, { error: 'invalid_client' });
    if (form.get('grant_type') === 'authorization_code') {
      if (!form.get('code_verifier') || !form.get('redirect_uri')) return json(res, 400, { error: 'invalid_request' });
      return json(res, 200, this.issue());
    }
    if (form.get('grant_type') === 'refresh_token') {
      const rt = form.get('refresh_token');
      if (!this.refresh.has(rt)) return json(res, 400, { error: 'invalid_grant' });
      this.refreshes++;
      const issued = this.issue();
      if (rotate) this.refresh.delete(rt);
      else {
        this.refresh.delete(issued.refresh_token);
        delete issued.refresh_token;
      }
      return json(res, 200, issued);
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
}

/** Plays the browser: follows the sign-in URL's redirect back to MySync with a code. */
export async function approveSignIn(authUrl) {
  const url = new URL(authUrl);
  const redirect = new URL(url.searchParams.get('redirect_uri'));
  redirect.hostname = '127.0.0.1';
  redirect.searchParams.set('code', 'test-code');
  redirect.searchParams.set('state', url.searchParams.get('state'));
  const res = await fetch(redirect);
  return res.status;
}

// ---------------------------------------------------------------------------
// WebDAV
// ---------------------------------------------------------------------------

export async function startWebDav({ user = 'u', pass = 'p' } = {}) {
  const items = new Map([['/dav', { dir: true }]]); // path -> { dir } | { data, etag }
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== expected) return res.writeHead(401).end();
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/+$/, '');
    const parent = p.slice(0, p.lastIndexOf('/'));
    const data = await body(req);
    if (req.method === 'MKCOL') {
      if (items.has(p)) return res.writeHead(405).end();
      if (!items.get(parent)?.dir) return res.writeHead(409).end();
      items.set(p, { dir: true });
      return res.writeHead(201).end();
    }
    if (req.method === 'PUT') {
      if (!items.get(parent)?.dir) return res.writeHead(409).end();
      items.set(p, { data, etag: crypto.randomBytes(4).toString('hex') });
      return res.writeHead(201).end();
    }
    if (req.method === 'GET') {
      const item = items.get(p);
      if (!item || item.dir) return res.writeHead(404).end();
      return res.writeHead(200).end(item.data);
    }
    if (req.method === 'PROPFIND') {
      const item = items.get(p);
      if (!item) return res.writeHead(404).end();
      const rows = [[p, item]];
      for (const [k, v] of items) if (k.slice(0, k.lastIndexOf('/')) === p) rows.push([k, v]);
      const xml = rows.map(([k, v]) => `<D:response><D:href>${k.split('/').map(encodeURIComponent).join('/')}${v.dir ? '/' : ''}</D:href><D:propstat><D:prop>${v.dir ? '<D:resourcetype><D:collection/></D:resourcetype>' : `<D:resourcetype/><D:getetag>"${v.etag}"</D:getetag><D:getcontentlength>${v.data.length}</D:getcontentlength>`}</D:prop></D:propstat></D:response>`).join('');
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${xml}</D:multistatus>`);
    }
    res.writeHead(405).end();
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}/dav`, items };
}

// ---------------------------------------------------------------------------
// Google Drive v3
// ---------------------------------------------------------------------------

const FOLDER = 'application/vnd.google-apps.folder';
const unq = (s) => s.replace(/\\(.)/g, '$1');

export async function startGoogleDrive({ clientId = 'g-client', pageSize = 50 } = {}) {
  const tokens = new Tokens();
  const files = new Map(); // id -> { id, name, parents, mimeType, data, created, modifiedTime }
  const sessions = new Map();
  let seq = 0;
  const stats = { resumable: 0, multipart: 0, patch: 0 };

  const create = (meta, data = null) => {
    const id = `f${++seq}`;
    files.set(id, { id, name: meta.name, parents: meta.parents || ['root'], mimeType: meta.mimeType || 'application/octet-stream', data, created: seq, modifiedTime: new Date(Date.now() + seq).toISOString() });
    return id;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/token') return tokens.handle(req, res, { clientId, rotate: false });
    if (url.pathname.startsWith('/session/')) {
      const meta = sessions.get(url.pathname.slice(9));
      if (!meta) return res.writeHead(404).end();
      const data = await body(req);
      return json(res, 200, { id: create(meta, data) });
    }
    if (!tokens.ok(req)) return json(res, 401, { error: { message: 'Invalid Credentials' } });

    if (req.method === 'GET' && url.pathname === '/drive/v3/about') return json(res, 200, { user: { emailAddress: 'me@example.com' } });

    if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q');
      const parent = unq(/'((?:[^'\\]|\\.)*)' in parents/.exec(query)[1]);
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(query);
      const mime = /mimeType (=|!=) '([^']+)'/.exec(query);
      let list = [...files.values()].filter((f) => f.parents.includes(parent));
      if (name) list = list.filter((f) => f.name === unq(name[1]));
      if (mime) list = list.filter((f) => (mime[1] === '=') === (f.mimeType === mime[2]));
      list.sort((a, b) => a.created - b.created);
      const start = Number(url.searchParams.get('pageToken') || 0);
      const size = Math.min(pageSize, Number(url.searchParams.get('pageSize')) || 100);
      const page = list.slice(start, start + size);
      return json(res, 200, {
        files: page.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, size: f.data ? String(f.data.length) : undefined })),
        ...(start + size < list.length ? { nextPageToken: String(start + size) } : {}),
      });
    }

    if (req.method === 'POST' && url.pathname === '/drive/v3/files') {
      return json(res, 200, { id: create(JSON.parse((await body(req)).toString())) });
    }

    const media = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && media && url.searchParams.get('alt') === 'media') {
      const f = files.get(media[1]);
      if (!f || !f.data) return json(res, 404, { error: { message: 'not found' } });
      return res.writeHead(200).end(f.data);
    }

    if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const raw = await body(req);
      if (url.searchParams.get('uploadType') === 'resumable') {
        stats.resumable++;
        const sid = crypto.randomBytes(6).toString('hex');
        sessions.set(sid, JSON.parse(raw.toString()));
        res.writeHead(200, { Location: `http://127.0.0.1:${server.address().port}/session/${sid}` });
        return res.end();
      }
      stats.multipart++;
      const boundary = /boundary=(\S+)/.exec(req.headers['content-type'])[1];
      const sepBuf = Buffer.from(`--${boundary}`);
      const first = raw.indexOf(sepBuf);
      const second = raw.indexOf(sepBuf, first + sepBuf.length);
      const last = raw.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      const metaPart = raw.subarray(first + sepBuf.length, second).toString();
      const meta = JSON.parse(metaPart.slice(metaPart.indexOf('\r\n\r\n') + 4).trim());
      const dataStart = raw.indexOf(Buffer.from('\r\n\r\n'), second) + 4;
      return json(res, 200, { id: create(meta, raw.subarray(dataStart, last)) });
    }

    const patch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'PATCH' && patch) {
      const f = files.get(patch[1]);
      if (!f) return json(res, 404, { error: { message: 'not found' } });
      stats.patch++;
      f.data = await body(req);
      f.modifiedTime = new Date(Date.now() + ++seq).toISOString();
      return json(res, 200, { id: f.id });
    }

    json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  return {
    server,
    tokens,
    files,
    stats,
    env: {
      MYSYNC_GOOGLE_AUTH_URL: `${base}/auth`,
      MYSYNC_GOOGLE_TOKEN_URL: `${base}/token`,
      MYSYNC_GDRIVE_API: `${base}/drive/v3`,
      MYSYNC_GDRIVE_UPLOAD: `${base}/upload/drive/v3`,
    },
  };
}

// ---------------------------------------------------------------------------
// Microsoft Graph (OneDrive app folder)
// ---------------------------------------------------------------------------

export async function startOneDrive({ clientId = 'ms-client', pageSize = 50 } = {}) {
  const tokens = new Tokens();
  const items = new Map([['', { folder: true }]]); // path inside approot -> { folder } | { data, eTag }
  const sessions = new Map();
  const stats = { sessions: 0, chunks: [] };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ms/token') return tokens.handle(req, res, { clientId, rotate: true });
    if (url.pathname.startsWith('/upload/')) {
      const s = sessions.get(url.pathname.slice(8));
      if (!s) return res.writeHead(404).end();
      const data = await body(req);
      const [, from, to, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers['content-range']).map(Number);
      if (from !== s.received || to - from + 1 !== data.length) return json(res, 416, { error: { message: 'bad range' } });
      if (to + 1 < total && data.length % (320 * 1024) !== 0) return json(res, 400, { error: { message: 'chunk not a multiple of 320 KiB' } });
      stats.chunks.push(data.length);
      s.parts.push(data);
      s.received += data.length;
      if (s.received < total) return json(res, 202, { nextExpectedRanges: [`${s.received}-`] });
      items.set(s.path, { data: Buffer.concat(s.parts), eTag: crypto.randomBytes(4).toString('hex') });
      sessions.delete(url.pathname.slice(8));
      return json(res, 201, { name: s.path.split('/').pop() });
    }
    if (!tokens.ok(req)) return json(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'expired' } });

    if (url.pathname === '/v1.0/me/drive') return json(res, 200, { owner: { user: { displayName: 'Me', email: 'me@outlook.com' } } });

    const prefix = '/v1.0/me/drive/special/approot';
    if (!url.pathname.startsWith(prefix)) return json(res, 404, { error: { message: 'no route' } });
    let rest = decodeURIComponent(url.pathname.slice(prefix.length));
    let itemPath = '';
    let action = '';
    if (rest.startsWith(':/')) {
      const end = rest.indexOf(':', 2);
      itemPath = rest.slice(2, end === -1 ? undefined : end);
      action = end === -1 ? '' : rest.slice(end + 1);
    } else {
      action = rest;
    }
    action = action.replace(/^\//, '');
    const parentOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

    if (req.method === 'GET' && action === 'children') {
      const item = items.get(itemPath);
      if (!item?.folder) return json(res, 404, { error: { code: 'itemNotFound' } });
      const kids = [...items.entries()].filter(([k]) => k !== '' && parentOf(k) === itemPath);
      const start = Number(url.searchParams.get('skip') || 0);
      const page = kids.slice(start, start + pageSize);
      const next = new URL(url.href.replace('http://x', `http://127.0.0.1:${server.address().port}`));
      next.searchParams.set('skip', String(start + pageSize));
      return json(res, 200, {
        value: page.map(([k, v]) => ({ name: k.split('/').pop(), ...(v.folder ? { folder: {} } : { eTag: v.eTag, size: v.data.length }) })),
        ...(start + pageSize < kids.length ? { '@odata.nextLink': next.href } : {}),
      });
    }
    if (req.method === 'POST' && action === 'children') {
      if (!items.get(itemPath)?.folder) return json(res, 404, { error: { code: 'itemNotFound' } });
      const { name } = JSON.parse((await body(req)).toString());
      const p = itemPath ? `${itemPath}/${name}` : name;
      if (items.has(p)) return json(res, 409, { error: { code: 'nameAlreadyExists' } });
      items.set(p, { folder: true });
      return json(res, 201, { name });
    }
    if (req.method === 'PUT' && action === 'content') {
      if (!items.get(parentOf(itemPath))?.folder) return json(res, 404, { error: { code: 'itemNotFound' } });
      const data = await body(req);
      if (data.length > 4 * 1024 * 1024) return json(res, 413, { error: { message: 'too big for simple upload' } });
      items.set(itemPath, { data, eTag: crypto.randomBytes(4).toString('hex') });
      return json(res, 201, { name: itemPath.split('/').pop() });
    }
    if (req.method === 'GET' && action === 'content') {
      const item = items.get(itemPath);
      if (!item || item.folder) return json(res, 404, { error: { code: 'itemNotFound' } });
      return res.writeHead(200).end(item.data);
    }
    if (req.method === 'POST' && action === 'createUploadSession') {
      if (!items.get(parentOf(itemPath))?.folder) return json(res, 404, { error: { code: 'itemNotFound' } });
      stats.sessions++;
      const sid = crypto.randomBytes(6).toString('hex');
      sessions.set(sid, { path: itemPath, parts: [], received: 0 });
      return json(res, 200, { uploadUrl: `http://127.0.0.1:${server.address().port}/upload/${sid}` });
    }
    json(res, 404, { error: { message: `no route ${req.method} ${action}` } });
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  return {
    server,
    tokens,
    items,
    stats,
    env: {
      MYSYNC_MS_AUTH_URL: `${base}/ms/auth`,
      MYSYNC_MS_TOKEN_URL: `${base}/ms/token`,
      MYSYNC_GRAPH_API: `${base}/v1.0`,
    },
  };
}
