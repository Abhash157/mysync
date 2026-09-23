import fs from 'node:fs';
import path from 'node:path';

export const MYSYNC_DIR = '.mysync';

/**
 * Finds the root directory containing the .mysync folder by walking up from startDir.
 * @param {string} [startDir=process.cwd()]
 * @returns {string|null} Root path of repository, or null if not inside a repository.
 */
export function findRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, MYSYNC_DIR);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break; // Reached filesystem root
    }
    current = parent;
  }
  return null;
}

/**
 * Gets the .mysync directory path, throwing if not in a repository.
 * @param {string} [startDir=process.cwd()]
 * @returns {string} Path to .mysync directory
 */
export function requireRepoRoot(startDir = process.cwd()) {
  const root = findRepoRoot(startDir);
  if (!root) {
    throw new Error('fatal: not a mysync repository (or any of the parent directories): .mysync');
  }
  return root;
}

/**
 * Initializes a new mysync repository.
 * @param {string} [targetDir=process.cwd()]
 * @param {string} [defaultBranch='main']
 * @returns {{ initialized: boolean, path: string }}
 */
export function initRepo(targetDir = process.cwd(), defaultBranch = 'main') {
  const root = path.resolve(targetDir);
  const mysyncPath = path.join(root, MYSYNC_DIR);

  if (fs.existsSync(mysyncPath)) {
    return { initialized: false, path: root };
  }

  // Create directory structure
  fs.mkdirSync(path.join(mysyncPath, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(mysyncPath, 'refs', 'heads'), { recursive: true });

  // Initialize HEAD pointing to default branch
  fs.writeFileSync(path.join(mysyncPath, 'HEAD'), `ref: refs/heads/${defaultBranch}\n`, 'utf8');

  // Initialize empty index file
  fs.writeFileSync(path.join(mysyncPath, 'index'), JSON.stringify({}, null, 2), 'utf8');

  // Initialize config file
  const config = {
    core: {
      repositoryformatversion: 1,
      defaultBranch,
    },
    user: {
      name: process.env.MYSYNC_AUTHOR_NAME || process.env.USER || process.env.USERNAME || 'mysync-user',
      email: process.env.MYSYNC_AUTHOR_EMAIL || 'user@mysync.local',
    },
  };
  fs.writeFileSync(path.join(mysyncPath, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  return { initialized: true, path: root };
}

/**
 * Reads HEAD information.
 * @param {string} repoRoot
 * @returns {{ isBranch: boolean, branch: string|null, commitHash: string|null, headContent: string }}
 */
export function getHeadInfo(repoRoot) {
  const headPath = path.join(repoRoot, MYSYNC_DIR, 'HEAD');
  if (!fs.existsSync(headPath)) {
    throw new Error('fatal: Corrupted repository: HEAD file missing');
  }

  const headContent = fs.readFileSync(headPath, 'utf8').trim();
  if (headContent.startsWith('ref: ')) {
    const refRelative = headContent.slice(5).trim();
    const branchName = refRelative.replace(/^refs\/heads\//, '');
    const refFile = path.join(repoRoot, MYSYNC_DIR, refRelative);
    const commitHash = fs.existsSync(refFile) ? fs.readFileSync(refFile, 'utf8').trim() : null;

    return {
      isBranch: true,
      branch: branchName,
      commitHash: commitHash || null,
      headContent,
    };
  }

  // Detached HEAD
  return {
    isBranch: false,
    branch: null,
    commitHash: headContent,
    headContent,
  };
}

/**
 * Updates HEAD to point to a branch or a commit.
 * @param {string} repoRoot
 * @param {string} target e.g. "refs/heads/main" or a 40-char commit hash
 * @param {boolean} [asBranch=true]
 */
export function setHead(repoRoot, target, asBranch = true) {
  const headPath = path.join(repoRoot, MYSYNC_DIR, 'HEAD');
  if (asBranch) {
    const branchRef = target.startsWith('refs/heads/') ? target : `refs/heads/${target}`;
    fs.writeFileSync(headPath, `ref: ${branchRef}\n`, 'utf8');
  } else {
    fs.writeFileSync(headPath, `${target}\n`, 'utf8');
  }
}

/**
 * Updates or creates a branch ref to point to a commit hash.
 * @param {string} repoRoot
 * @param {string} branchName
 * @param {string} commitHash
 */
export function updateBranchRef(repoRoot, branchName, commitHash) {
  const refPath = path.join(repoRoot, MYSYNC_DIR, 'refs', 'heads', branchName);
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(refPath, `${commitHash}\n`, 'utf8');
}

/**
 * Reads repo config.
 * @param {string} repoRoot
 * @returns {object}
 */
export function getConfig(repoRoot) {
  const configPath = path.join(repoRoot, MYSYNC_DIR, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // Fallback
    }
  }
  return {
    core: { repositoryformatversion: 1 },
    user: {
      name: process.env.MYSYNC_AUTHOR_NAME || process.env.USER || process.env.USERNAME || 'mysync-user',
      email: process.env.MYSYNC_AUTHOR_EMAIL || 'user@mysync.local',
    },
    remotes: {},
  };
}

/**
 * Writes repo config.
 * @param {string} repoRoot
 * @param {object} config
 */
export function writeConfig(repoRoot, config) {
  const configPath = path.join(repoRoot, MYSYNC_DIR, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Sets a remote URL.
 * @param {string} repoRoot
 * @param {string} remoteName
 * @param {string} url
 */
export function setRemote(repoRoot, remoteName, url) {
  const config = getConfig(repoRoot);
  if (!config.remotes) config.remotes = {};
  config.remotes[remoteName] = url;
  writeConfig(repoRoot, config);
}

/**
 * Gets a remote URL.
 * @param {string} repoRoot
 * @param {string} remoteName
 * @returns {string|null}
 */
export function getRemote(repoRoot, remoteName) {
  const config = getConfig(repoRoot);
  return config.remotes?.[remoteName] || null;
}

/**
 * Updates a remote tracking branch ref.
 * @param {string} repoRoot
 * @param {string} remoteName
 * @param {string} branchName
 * @param {string} commitHash
 */
export function updateRemoteBranchRef(repoRoot, remoteName, branchName, commitHash) {
  const refPath = path.join(repoRoot, MYSYNC_DIR, 'refs', 'remotes', remoteName, branchName);
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(refPath, `${commitHash}\n`, 'utf8');
}

/**
 * Gets a remote tracking branch ref.
 * @param {string} repoRoot
 * @param {string} remoteName
 * @param {string} branchName
 * @returns {string|null}
 */
export function getRemoteBranchRef(repoRoot, remoteName, branchName) {
  const refPath = path.join(repoRoot, MYSYNC_DIR, 'refs', 'remotes', remoteName, branchName);
  if (fs.existsSync(refPath)) {
    return fs.readFileSync(refPath, 'utf8').trim();
  }
  return null;
}
