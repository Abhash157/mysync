import { getConfig, getOrCreateToken } from './repo.js';
import { lanAddresses } from './server.js';

const PREFIX = 'mys1.';

export function hubWorkspaceUrl(hubUrl, name) {
  return `${hubUrl.replace(/\/+$/, '')}/w/${name}`;
}

/**
 * One copy-pasteable string holding everything a new device needs.
 * It contains the workspace token, so treat it like a password.
 * @param {{ t: string, w?: string, h?: string, l?: string[] }} data
 */
export function encodeInvite(data) {
  return PREFIX + Buffer.from(JSON.stringify(data)).toString('base64url');
}

export function isInviteCode(text) {
  return typeof text === 'string' && text.startsWith(PREFIX);
}

export function decodeInvite(code) {
  try {
    const data = JSON.parse(Buffer.from(code.slice(PREFIX.length), 'base64url').toString('utf8'));
    if (typeof data.t !== 'string') throw new Error('no token');
    return data;
  } catch {
    throw new Error('fatal: that is not a valid mysync invite code');
  }
}

/** Invite for this workspace: LAN addresses plus the hub (if published). */
export function buildInvite(repoRoot, port = 3000, { path = '' } = {}) {
  const config = getConfig(repoRoot);
  const data = { t: getOrCreateToken(repoRoot) };
  if (config.hub) {
    data.h = config.hub.url;
    data.w = config.hub.workspace;
  }
  data.l = lanAddresses().map((ip) => `http://${ip}:${port}${path}`);
  return encodeInvite(data);
}
