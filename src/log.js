import { getHeadInfo } from './repo.js';
import { readCommit } from './objects.js';

/**
 * Traverses commit history from HEAD.
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {number} [options.limit]
 * @returns {Array<{
 *   hash: string,
 *   treeHash: string,
 *   parentHash: string|null,
 *   author: { name: string, email: string, timestamp: number },
 *   message: string
 * }>}
 */
export function getLog(repoRoot, { limit } = {}) {
  const headInfo = getHeadInfo(repoRoot);
  if (!headInfo.commitHash) {
    return [];
  }

  const history = [];
  let currentHash = headInfo.commitHash;

  while (currentHash) {
    const commitData = readCommit(repoRoot, currentHash);
    history.push({
      hash: currentHash,
      ...commitData,
    });

    if (limit && history.length >= limit) {
      break;
    }

    currentHash = commitData.parentHash;
  }

  return history;
}

/**
 * Formats commit log entries for display.
 * @param {ReturnType<typeof getLog>} history
 * @param {object} [options]
 * @param {boolean} [options.oneline=false]
 * @param {string|null} [options.currentBranch=null]
 * @returns {string}
 */
export function formatLog(history, { oneline = false, currentBranch = null } = {}) {
  if (history.length === 0) {
    return 'fatal: your current branch does not have any commits yet';
  }

  return history
    .map((item, index) => {
      const shortHash = item.hash.slice(0, 7);
      const isHead = index === 0;
      let refDecoration = '';

      if (isHead) {
        refDecoration = currentBranch
          ? ` \x1b[36m(HEAD -> \x1b[32m${currentBranch}\x1b[36m)\x1b[0m`
          : ` \x1b[36m(HEAD)\x1b[0m`;
      }

      if (oneline) {
        return `\x1b[33m${shortHash}\x1b[0m${refDecoration} ${item.message.split('\n')[0]}`;
      }

      const dateStr = new Date(item.author.timestamp * 1000).toLocaleString();
      const messageLines = item.message
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');

      return [
        `\x1b[33mcommit ${item.hash}\x1b[0m${refDecoration}`,
        `Author: ${item.author.name} <${item.author.email}>`,
        `Date:   ${dateStr}`,
        '',
        messageLines,
        '',
      ].join('\n');
    })
    .join(oneline ? '\n' : '\n');
}
