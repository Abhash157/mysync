/** Remotes are either a bare URL string or { url, token }. */
function asPeer(remote) {
  return typeof remote === 'string' ? { url: remote, token: null } : remote;
}

/**
 * Helper to make a JSON request.
 */
async function fetchJson(remote, route, method = 'GET', body = null) {
  const { url, token } = asPeer(remote);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const options = { method, headers, signal: AbortSignal.timeout(60_000) };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(new URL(route, url).href, options);
  let data = {};
  try {
    data = await res.json();
  } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Fetches remote refs.
 * @returns {Promise<Record<string, string>>} Map of branch name to commit hash
 */
export async function fetchRemoteRefs(remote) {
  return fetchJson(remote, '/info/refs');
}

/**
 * Fetches specific objects from remote.
 * @param {string[]} hashes
 * @returns {Promise<Record<string, string>>} Map of hash to base64 data
 */
export async function fetchRemoteObjects(remote, hashes) {
  if (hashes.length === 0) return {};
  const res = await fetchJson(remote, '/objects/fetch', 'POST', { hashes });
  return res.objects;
}

/**
 * Asks the remote which of the given object hashes it does not have yet.
 * @param {string[]} hashes
 * @returns {Promise<string[]>}
 */
export async function fetchMissingOnRemote(remote, hashes) {
  const missing = [];
  for (let i = 0; i < hashes.length; i += 2000) {
    const res = await fetchJson(remote, '/objects/missing', 'POST', { hashes: hashes.slice(i, i + 2000) });
    missing.push(...res.missing);
  }
  return missing;
}

/**
 * Pushes objects to remote.
 * @param {Record<string, string>} objects Map of hash to base64 data
 * @returns {Promise<void>}
 */
export async function pushRemoteObjects(remote, objects) {
  if (Object.keys(objects).length === 0) return;
  await fetchJson(remote, '/objects/push', 'POST', { objects });
}

/**
 * Updates remote branch ref. Rejects with err.status === 409 if the remote diverged.
 * @returns {Promise<void>}
 */
export async function updateRemoteRef(remote, branchName, commitHash) {
  await fetchJson(remote, `/refs/heads/${branchName}`, 'POST', { commitHash });
}
