import fs from 'node:fs';
import path from 'node:path';
import {
  getRemote,
  setRemote,
  updateRemoteBranchRef,
  initRepo,
  GDIF_DIR,
  getHeadInfo
} from './repo.js';
import { checkout } from './branch.js';
import { readObject, readCommit, readTree } from './objects.js';
import {
  fetchRemoteRefs,
  fetchRemoteObjects,
  pushRemoteObjects,
  updateRemoteRef
} from './client.js';

function getObjectPath(repoRoot, hash) {
  const dir = hash.slice(0, 2);
  const file = hash.slice(2);
  return path.join(repoRoot, GDIF_DIR, 'objects', dir, file);
}

/**
 * Downloads missing objects from remote recursively.
 */
async function downloadMissingObjects(repoRoot, remoteUrl, rootHashes) {
  const queue = [...rootHashes];
  const downloaded = new Set();
  
  while (queue.length > 0) {
    const batch = [];
    while (queue.length > 0 && batch.length < 50) {
      const hash = queue.shift();
      if (!downloaded.has(hash) && !fs.existsSync(getObjectPath(repoRoot, hash))) {
        batch.push(hash);
        downloaded.add(hash);
      }
    }
    
    if (batch.length === 0) continue;
    
    const objects = await fetchRemoteObjects(remoteUrl, batch);
    
    for (const [hash, base64Data] of Object.entries(objects)) {
      const objPath = getObjectPath(repoRoot, hash);
      fs.mkdirSync(path.dirname(objPath), { recursive: true });
      fs.writeFileSync(objPath, Buffer.from(base64Data, 'base64'));
      
      const { type } = readObject(repoRoot, hash);
      if (type === 'commit') {
        const commit = readCommit(repoRoot, hash);
        if (commit.treeHash) queue.push(commit.treeHash);
        if (commit.parentHash) queue.push(commit.parentHash);
      } else if (type === 'tree') {
        const treeEntries = readTree(repoRoot, hash);
        for (const entry of treeEntries) {
          queue.push(entry.hash);
        }
      }
    }
  }
}

/**
 * Collects all reachable objects locally up to a stopping commit.
 */
function collectObjects(repoRoot, startCommitHash, stopCommitHash) {
  const objects = {};
  const queue = [startCommitHash];
  const visited = new Set();
  
  while (queue.length > 0) {
    const hash = queue.shift();
    if (!hash || visited.has(hash) || hash === stopCommitHash) continue;
    visited.add(hash);
    
    const objPath = getObjectPath(repoRoot, hash);
    if (!fs.existsSync(objPath)) continue;
    
    objects[hash] = fs.readFileSync(objPath).toString('base64');
    
    const { type } = readObject(repoRoot, hash);
    if (type === 'commit') {
      const commit = readCommit(repoRoot, hash);
      if (commit.treeHash) queue.push(commit.treeHash);
      if (commit.parentHash) queue.push(commit.parentHash);
    } else if (type === 'tree') {
      const treeEntries = readTree(repoRoot, hash);
      for (const entry of treeEntries) {
        queue.push(entry.hash);
      }
    }
  }
  return objects;
}

/**
 * Fetches all branches from a remote.
 */
export async function fetch(repoRoot, remoteName) {
  const remoteUrl = getRemote(repoRoot, remoteName);
  if (!remoteUrl) throw new Error(`fatal: '${remoteName}' does not appear to be a gdif repository`);
  
  console.log(`Fetching from ${remoteUrl}...`);
  const refs = await fetchRemoteRefs(remoteUrl);
  
  const targetHashes = Object.values(refs);
  await downloadMissingObjects(repoRoot, remoteUrl, targetHashes);
  
  for (const [branch, hash] of Object.entries(refs)) {
    updateRemoteBranchRef(repoRoot, remoteName, branch, hash);
    console.log(` * [new branch]      ${branch} -> ${remoteName}/${branch}`);
  }
}

/**
 * Clones a repository.
 */
export async function clone(url, targetDir) {
  const dirName = targetDir || path.basename(new URL(url).pathname);
  const repoRoot = path.resolve(process.cwd(), dirName);
  
  if (fs.existsSync(repoRoot) && fs.readdirSync(repoRoot).length > 0) {
    throw new Error(`fatal: destination path '${dirName}' already exists and is not an empty directory.`);
  }
  
  fs.mkdirSync(repoRoot, { recursive: true });
  initRepo(repoRoot);
  setRemote(repoRoot, 'origin', url);
  
  await fetch(repoRoot, 'origin');
  
  const refs = await fetchRemoteRefs(url);
  const defaultBranch = refs.main ? 'main' : Object.keys(refs)[0];
  
  if (defaultBranch) {
    const commitHash = refs[defaultBranch];
    const branchPath = path.join(repoRoot, GDIF_DIR, 'refs', 'heads', defaultBranch);
    fs.mkdirSync(path.dirname(branchPath), { recursive: true });
    fs.writeFileSync(branchPath, `${commitHash}\n`, 'utf8');
    
    checkout(repoRoot, defaultBranch);
  }
  console.log(`Cloned into '${dirName}'.`);
}

/**
 * Fetches and fast-forwards.
 */
export async function pull(repoRoot, remoteName, branchName) {
  await fetch(repoRoot, remoteName);
  const remoteUrl = getRemote(repoRoot, remoteName);
  const refs = await fetchRemoteRefs(remoteUrl);
  const targetHash = refs[branchName];
  if (!targetHash) throw new Error(`fatal: couldn't find remote ref ${branchName}`);
  
  const headInfo = getHeadInfo(repoRoot);
  if (headInfo.branch !== branchName) {
    throw new Error(`fatal: You are not currently on branch '${branchName}'.`);
  }
  
  // Fast forward (simply checkout targetHash but update branch ref)
  checkout(repoRoot, targetHash);
  // Re-attach HEAD to branch
  const headPath = path.join(repoRoot, GDIF_DIR, 'HEAD');
  fs.writeFileSync(headPath, `ref: refs/heads/${branchName}\n`, 'utf8');
  // Update branch ref
  const branchPath = path.join(repoRoot, GDIF_DIR, 'refs', 'heads', branchName);
  fs.writeFileSync(branchPath, `${targetHash}\n`, 'utf8');
  
  console.log(`Fast-forwarded ${branchName} to ${targetHash.slice(0, 7)}`);
}

/**
 * Pushes local branch to remote.
 */
export async function push(repoRoot, remoteName, branchName) {
  const remoteUrl = getRemote(repoRoot, remoteName);
  if (!remoteUrl) throw new Error(`fatal: '${remoteName}' does not appear to be a gdif repository`);
  
  const headInfo = getHeadInfo(repoRoot);
  const localHash = headInfo.commitHash;
  if (!localHash) throw new Error('fatal: nothing to push');
  
  console.log(`Pushing to ${remoteUrl}...`);
  const refs = await fetchRemoteRefs(remoteUrl).catch(() => ({}));
  const remoteHash = refs[branchName];
  
  const objects = collectObjects(repoRoot, localHash, remoteHash);
  console.log(`Uploading ${Object.keys(objects).length} objects...`);
  
  await pushRemoteObjects(remoteUrl, objects);
  await updateRemoteRef(remoteUrl, branchName, localHash);
  updateRemoteBranchRef(repoRoot, remoteName, branchName, localHash);
  
  console.log(` * [new branch]      ${branchName} -> ${branchName}`);
}
