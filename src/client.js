/**
 * Helper to make a JSON request.
 */
async function fetchJson(url, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP error ${res.status}`);
  }
  return data;
}

/**
 * Fetches remote refs.
 * @param {string} remoteUrl
 * @returns {Promise<Record<string, string>>} Map of branch name to commit hash
 */
export async function fetchRemoteRefs(remoteUrl) {
  const url = new URL('/info/refs', remoteUrl).href;
  return fetchJson(url);
}

/**
 * Fetches specific objects from remote.
 * @param {string} remoteUrl
 * @param {string[]} hashes
 * @returns {Promise<Record<string, string>>} Map of hash to base64 data
 */
export async function fetchRemoteObjects(remoteUrl, hashes) {
  if (hashes.length === 0) return {};
  const url = new URL('/objects/fetch', remoteUrl).href;
  const res = await fetchJson(url, 'POST', { hashes });
  return res.objects;
}

/**
 * Pushes objects to remote.
 * @param {string} remoteUrl
 * @param {Record<string, string>} objects Map of hash to base64 data
 * @returns {Promise<void>}
 */
export async function pushRemoteObjects(remoteUrl, objects) {
  if (Object.keys(objects).length === 0) return;
  const url = new URL('/objects/push', remoteUrl).href;
  await fetchJson(url, 'POST', { objects });
}

/**
 * Updates remote branch ref.
 * @param {string} remoteUrl
 * @param {string} branchName
 * @param {string} commitHash
 * @returns {Promise<void>}
 */
export async function updateRemoteRef(remoteUrl, branchName, commitHash) {
  const url = new URL(`/refs/heads/${branchName}`, remoteUrl).href;
  await fetchJson(url, 'POST', { commitHash });
}
