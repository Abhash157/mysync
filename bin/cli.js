#!/usr/bin/env node

import { Command } from 'commander';
import {
  requireRepoRoot,
  initRepo,
  getHeadInfo,
  stage,
  unstage,
  createCommit,
  getStatus,
  formatStatus,
  getLog,
  formatLog,
  getRepoDiff,
  listBranches,
  createBranch,
  deleteBranch,
  checkout,
  restore,
  serve,
  clone,
  setRemote,
  getRemote,
  fetch,
  pull,
  push,
} from '../src/index.js';

const program = new Command();

program
  .name('gdif')
  .description('Lightweight, Git-like Version Control System (VCS) CLI')
  .version('1.0.0');

// serve
program
  .command('serve')
  .description('Start the gdif HTTP server to allow cloning and pushing')
  .option('-p, --port <number>', 'Port to listen on', 3000)
  .action((options) => {
    try {
      const root = requireRepoRoot();
      const port = parseInt(options.port, 10);
      serve(root, port);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// clone
program
  .command('clone <url> [directory]')
  .description('Clone a repository into a new directory')
  .action(async (url, directory) => {
    try {
      await clone(url, directory);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// remote
const remoteCmd = program
  .command('remote')
  .description('Manage set of tracked repositories');

remoteCmd
  .command('add <name> <url>')
  .description('Add a remote named <name> for the repository at <url>')
  .action((name, url) => {
    try {
      const root = requireRepoRoot();
      setRemote(root, name, url);
      console.log(`Remote '${name}' added.`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// fetch
program
  .command('fetch <remote>')
  .description('Download objects and refs from another repository')
  .action(async (remote) => {
    try {
      const root = requireRepoRoot();
      await fetch(root, remote);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// pull
program
  .command('pull <remote> <branch>')
  .description('Fetch from and integrate with another repository or a local branch')
  .action(async (remote, branch) => {
    try {
      const root = requireRepoRoot();
      await pull(root, remote, branch);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// push
program
  .command('push <remote> <branch>')
  .description('Update remote refs along with associated objects')
  .action(async (remote, branch) => {
    try {
      const root = requireRepoRoot();
      await push(root, remote, branch);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// init
program
  .command('init [directory]')
  .description('Create an empty gdif repository or reinitialize an existing one')
  .action((directory = '.') => {
    try {
      const result = initRepo(directory);
      if (result.initialized) {
        console.log(`Initialized empty gdif repository in ${result.path}/.gdif`);
      } else {
        console.log(`Reinitialized existing gdif repository in ${result.path}/.gdif`);
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// add
program
  .command('add <pathspecs...>')
  .description('Add file contents to the staging index')
  .action((pathspecs) => {
    try {
      const root = requireRepoRoot();
      for (const spec of pathspecs) {
        stage(root, spec);
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// commit
program
  .command('commit')
  .description('Record changes to the repository')
  .requiredOption('-m, --message <message>', 'Commit message')
  .option('--author-name <name>', 'Override author name')
  .option('--author-email <email>', 'Override author email')
  .action((options) => {
    try {
      const root = requireRepoRoot();
      const authorOverride = {};
      if (options.authorName) authorOverride.name = options.authorName;
      if (options.authorEmail) authorOverride.email = options.authorEmail;

      const result = createCommit(root, options.message, authorOverride);
      const branchDisplay = result.branch ? result.branch : 'detached HEAD';
      const shortHash = result.commitHash.slice(0, 7);
      console.log(`[${branchDisplay} ${shortHash}] ${result.message}`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// status
program
  .command('status')
  .description('Show the working tree status')
  .action(() => {
    try {
      const root = requireRepoRoot();
      const status = getStatus(root);
      console.log(formatStatus(status));
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// log
program
  .command('log')
  .description('Show commit logs')
  .option('-n, --limit <count>', 'Number of commits to show', parseInt)
  .option('--oneline', 'Show one line per commit')
  .action((options) => {
    try {
      const root = requireRepoRoot();
      const headInfo = getHeadInfo(root);
      const history = getLog(root, { limit: options.limit });
      console.log(formatLog(history, { oneline: options.oneline, currentBranch: headInfo.branch }));
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// diff
program
  .command('diff [file]')
  .description('Show changes between commits, commit and working tree, etc')
  .option('--staged', 'View changes staged for commit')
  .option('--cached', 'Synonym for --staged')
  .action((file, options) => {
    try {
      const root = requireRepoRoot();
      const diffOutput = getRepoDiff(root, {
        staged: !!(options.staged || options.cached),
        filePath: file || null,
      });
      if (diffOutput) {
        console.log(diffOutput);
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// branch
program
  .command('branch [name]')
  .description('List, create, or delete branches')
  .option('-d, --delete', 'Delete a branch')
  .action((name, options) => {
    try {
      const root = requireRepoRoot();
      if (options.delete) {
        if (!name) {
          console.error('fatal: branch name required for delete');
          process.exit(1);
        }
        deleteBranch(root, name);
        console.log(`Deleted branch ${name}.`);
        return;
      }

      if (!name) {
        // List branches
        const branches = listBranches(root);
        if (branches.length === 0) {
          return;
        }
        for (const b of branches) {
          if (b.isCurrent) {
            console.log(`* \x1b[32m${b.name}\x1b[0m`);
          } else {
            console.log(`  ${b.name}`);
          }
        }
        return;
      }

      createBranch(root, name);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// checkout
program
  .command('checkout <target>')
  .description('Switch branches or restore working tree files')
  .option('-b, --create', 'Create and checkout a new branch')
  .action((target, options) => {
    try {
      const root = requireRepoRoot();
      const res = checkout(root, target, { create: !!options.create });
      if (res.isBranch) {
        console.log(`Switched to branch '${target}'`);
      } else {
        console.log(`Note: switching to '${target}'.\nYou are in 'detached HEAD' state.`);
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// restore
program
  .command('restore <pathspecs...>')
  .description('Restore working tree files or discard staged changes')
  .option('--staged', 'Restore the staging index (unstage)')
  .action((pathspecs, options) => {
    try {
      const root = requireRepoRoot();
      restore(root, pathspecs, { staged: !!options.staged });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);
