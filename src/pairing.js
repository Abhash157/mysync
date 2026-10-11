import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// LAN pairing: a new device asks a nearby device to let it join a folder, and a person on the
// nearby device says yes or no. Only then does the new device receive the folder's invite, so
// nobody has to copy a code between devices. Requests expire, are rate limited and are only
// accepted from private-network addresses.

export const PAIR_TTL_MS = 2 * 60 * 1000; // how long a request waits for an answer
const KEEP_MS = 60 * 1000; // answered requests stay readable this long
const DECLINE_COOLDOWN_MS = 60 * 1000; // a declined device cannot ask again right away
const MAX_PENDING = 5;

const tooMany = (message) => Object.assign(new Error(message), { status: 429 });

/** Strips the IPv4-in-IPv6 prefix Node adds, e.g. "::ffff:192.168.1.5". */
export const plainAddress = (addr) => String(addr || '').replace(/^::ffff:/i, '');

/**
 * Private and link-local addresses: where "my own network" lives. Loopback does not count: a request
 * from this very machine is usually a tunnel or proxy forwarding someone from further away.
 */
export function isLocalAddress(addr) {
  const a = plainAddress(addr);
  if (/^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)) return true;
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
}

/** Device names come from the network: keep them short, printable and harmless. */
export function cleanDeviceName(name) {
  return String(name || '').replace(/[^\p{L}\p{N} _.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Another device';
}

/** Reads a small JSON request body; rejects anything larger than `limit` bytes. */
export function readSmallJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('request too large'), { status: 413 });
    if (Number(req.headers['content-length']) > limit) return reject(tooLarge()); // answered by the caller, who closes the connection
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(tooLarge());
        req.destroy(); // an upload that lied about its size: just drop it
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad request')); }
    });
    req.on('error', reject);
  });
}

const view = ({ id, code, device, address, name, folderId, at }) => ({ id, code, device, address, name, folderId, at });

/**
 * The requests waiting for a person to answer them, on the device that owns the folder.
 * Emits 'request' (a new one to show) and 'end' ({ id, status }) when one is no longer waiting.
 */
export class PairingBook extends EventEmitter {
  constructor() {
    super();
    this.requests = new Map();
    this.declined = new Map(); // address -> time it may ask again
  }

  /** A device asked to join. Asking again while a request is open returns the same one. */
  request({ folderId, name, device, address, via }) {
    this.sweep();
    const open = [...this.requests.values()].filter((r) => r.status === 'pending');
    const same = open.find((r) => r.folderId === folderId && r.address === address);
    if (same) return same;
    if ((this.declined.get(address) || 0) > Date.now()) throw tooMany('That device was declined a moment ago. Try again in a minute.');
    if (open.length >= MAX_PENDING) throw tooMany('Too many devices are asking at once. Try again in a minute.');

    const req = {
      id: crypto.randomBytes(16).toString('hex'),
      code: String(crypto.randomInt(0, 10000)).padStart(4, '0'),
      folderId,
      name,
      device,
      address,
      via,
      status: 'pending',
      at: Date.now(),
      answeredAt: 0,
      invite: null,
    };
    this.requests.set(req.id, req);
    this.emit('request', view(req));
    return req;
  }

  get(id) {
    this.sweep();
    return this.requests.get(id) || null;
  }

  /** Requests still waiting for an answer. */
  list() {
    this.sweep();
    return [...this.requests.values()].filter((r) => r.status === 'pending').map(view);
  }

  /** Approve (building the invite with `makeInvite`) or decline. Returns null if it is no longer waiting. */
  answer(id, allow, makeInvite) {
    const req = this.get(id);
    if (!req || req.status !== 'pending') return null;
    if (allow) {
      req.invite = makeInvite(req);
      req.status = 'approved';
    } else {
      req.status = 'denied';
      this.declined.set(req.address, Date.now() + DECLINE_COOLDOWN_MS);
    }
    this._finish(req);
    return req;
  }

  /** The asking device gave up (or the folder went away). */
  withdraw(id) {
    const req = this.requests.get(id);
    if (!req || req.status !== 'pending') return false;
    req.status = 'expired';
    this._finish(req);
    return true;
  }

  withdrawFolder(folderId) {
    for (const req of this.requests.values()) if (req.folderId === folderId) this.withdraw(req.id);
  }

  sweep() {
    const now = Date.now();
    for (const req of [...this.requests.values()]) {
      if (req.status === 'pending' && now - req.at > PAIR_TTL_MS) this.withdraw(req.id);
      if (req.status !== 'pending' && now - req.answeredAt > KEEP_MS) this.requests.delete(req.id);
    }
    for (const [address, until] of this.declined) if (until < now) this.declined.delete(address);
  }

  _finish(req) {
    req.answeredAt = Date.now();
    this.emit('end', { id: req.id, status: req.status });
  }
}

// ---------------------------------------------------------------------------
// The device that wants to join
// ---------------------------------------------------------------------------

/**
 * Asks a nearby device to let this one join. A device may be reachable at several addresses
 * (one per network adapter), so each is tried until one answers.
 * @param {string[]} urls Folder URLs as announced, e.g. http://192.168.1.5:3010/f/<folderId>
 * @returns {Promise<{ id: string, code: string, url: string }>}
 */
export async function requestPairing(urls, device, { timeout = 4000 } = {}) {
  let last = null;
  for (const base of urls) {
    try {
      const res = await fetch(`${base.replace(/\/+$/, '')}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device }),
        signal: AbortSignal.timeout(timeout),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.id) return { id: data.id, code: data.code, url: base };
      // The device answered (it just said no): trying its other addresses would not change that.
      throw Object.assign(new Error(data.error || `HTTP error ${res.status}`), { status: res.status, final: true });
    } catch (err) {
      if (err.final) throw err;
      last = err;
    }
  }
  throw last || new Error('Cannot connect to the other device');
}

/** @returns {Promise<{ status: 'pending'|'approved'|'denied'|'expired'|'gone', invite?: string }>} */
export async function pollPairing(url, id, { timeout = 4000 } = {}) {
  const res = await fetch(`${url.replace(/\/+$/, '')}/pair/${id}`, { signal: AbortSignal.timeout(timeout) });
  if (res.status === 404) return { status: 'gone' };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP error ${res.status}`);
  return data;
}

/** Tells the other device we no longer want in, so its prompt goes away. Best effort. */
export async function cancelPairing(url, id) {
  try {
    await fetch(`${url.replace(/\/+$/, '')}/pair/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(3000) });
  } catch { /* the request expires on its own */ }
}
