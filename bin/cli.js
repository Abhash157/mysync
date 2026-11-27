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
  join,
  publish,
  runHub,
  setDefaultHub,
  getDefaultHub,
  buildInvite,
  scanNearby,
  syncAll,
  snapshot,
  watch,
  getConfig,
  writeConfig,
  CLOUD_PROVIDERS,
  addCloudAccount,
  connectCloudAccount,
  listCloudAccounts,
  removeCloudAccount,
  detectCloudFolders,
  listCloudWorkspaces,
  linkCloud,
  unlinkCloud,
  joinCloud,
  setCloudApp,
} from '../src/index.js';
import { spawn } from 'node:child_process';

const program = new Command();

program
  .name('mysync')
  .description('Lightweight, Git-like Version Control System (VCS) CLI')
  .version('1.1.0');

// join
program
  .command('join <target> [directory]')
  .usage('<invite-code | workspace-name | auto | url> [directory]')
  .description('Join a synced workspace, merging any files already here with the others')
  .option('-t, --token <token>', 'Workspace token (not needed with an invite code)')
  .option('--device <name>', 'Name for this device (defaults to hostname)')
  .action(async (target, directory, options) => {
    try {
      await join(target, directory, { token: options.token, device: options.device });
      console.log('Run `mysync watch` in that folder to keep it in sync automatically.');
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// hub
const hubCmd = program
  .command('hub')
  .description('Run or choose a hub: an always-on meeting point so devices can sync over the internet');

hubCmd
  .command('serve')
  .description('Run a hub that stores named workspaces (put it behind HTTPS when exposing it)')
  .option('-p, --port <number>', 'Port to listen on', 8080)
  .option('-H, --host <address>', 'Host address to bind to', '0.0.0.0')
  .option('-d, --dir <path>', 'Where to store workspaces', './mysync-hub')
  .option('--secret <secret>', 'Required to create workspaces (recommended)', process.env.MYSYNC_HUB_SECRET)
  .action((options) => {
    runHub({ dir: options.dir, port: parseInt(options.port, 10), host: options.host, secret: options.secret || null });
  });

hubCmd
  .command('set <url>')
  .description('Use this hub for publish / join-by-name on this machine')
  .option('--secret <secret>', 'Hub secret, if the hub requires one to create workspaces')
  .action((url, options) => {
    if (!/^https?:\/\//.test(url)) {
      console.error('fatal: hub URL must start with http:// or https://');
      process.exit(1);
    }
    setDefaultHub(url, options.secret);
    console.log(`Default hub set to ${url}`);
    if (url.startsWith('http://') && !/^http:\/\/(localhost|127\.|10\.|192\.168\.)/.test(url)) {
      console.log('warning: plain http sends your workspace token over the internet in the clear. Prefer https://.');
    }
  });

hubCmd
  .command('show')
  .description('Show the default hub')
  .action(() => {
    const hub = getDefaultHub();
    console.log(hub ? hub.url : 'No hub set. Use `mysync hub set <url>`.');
  });

// cloud
const fail = (err) => {
  console.error(err.message);
  process.exit(1);
};

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* the URL is printed anyway */ }
}

/** Accepts an account id, or a provider name when only one such account exists. */
function resolveAccount(ref) {
  const all = listCloudAccounts();
  const exact = all.find((a) => a.id === ref);
  if (exact) return exact;
  const byProvider = all.filter((a) => a.provider === ref);
  if (byProvider.length === 1) return byProvider[0];
  if (byProvider.length > 1) throw new Error(`fatal: more than one ${ref} account; use its id (see \`mysync cloud list\`)`);
  throw new Error(`fatal: no cloud account '${ref}' (see \`mysync cloud list\`)`);
}

const cloudCmd = program
  .command('cloud')
  .description('Sync through Google Drive, OneDrive, MEGA, WebDAV or any cloud-synced folder, no server needed');

cloudCmd
  .command('add <provider> [location]')
  .usage('<gdrive | onedrive | mega | webdav | folder> [path-or-url]')
  .description('Connect a cloud account (folder <path>, webdav <url>, mega, gdrive, onedrive)')
  .option('-u, --user <name>', 'WebDAV user name')
  .option('-p, --password <password>', 'WebDAV or MEGA password')
  .option('-e, --email <email>', 'MEGA email')
  .option('--client-id <id>', 'OAuth app (client) ID for Google Drive or OneDrive')
  .option('--client-secret <secret>', 'OAuth client secret (Google desktop apps have one)')
  .action(async (provider, location, options) => {
    try {
      if (!CLOUD_PROVIDERS[provider]) throw new Error(`fatal: unknown provider '${provider}'. Use one of: ${Object.keys(CLOUD_PROVIDERS).join(', ')}`);
      let account;
      if (CLOUD_PROVIDERS[provider].oauth) {
        if (options.clientId) setCloudApp(provider, { clientId: options.clientId, clientSecret: options.clientSecret });
        const flow = await connectCloudAccount(provider);
        console.log(`Opening your browser to sign in to ${CLOUD_PROVIDERS[provider].label}. If it does not open, visit:\n  ${flow.url}`);
        openBrowser(flow.url);
        account = await flow.done;
      } else {
        account = await addCloudAccount(provider, {
          path: location,
          url: location,
          username: options.user,
          password: options.password,
          email: options.email,
        });
      }
      console.log(`Connected ${account.label}${account.detail ? ` (${account.detail})` : ''} as '${account.id}'`);
      console.log(`In a synced folder: mysync cloud link ${account.id}`);
    } catch (err) {
      fail(err);
    }
  });

cloudCmd
  .command('list')
  .description('List connected cloud accounts')
  .action(() => {
    const all = listCloudAccounts();
    if (all.length === 0) console.log('No cloud accounts yet. Add one with `mysync cloud add <provider>`.');
    for (const a of all) console.log(`${a.id}\t${a.label}${a.detail ? `\t${a.detail}` : ''}`);
  });

cloudCmd
  .command('detect')
  .description('Find folders that desktop cloud apps (OneDrive, Dropbox, Google Drive, MEGA...) sync')
  .action(() => {
    const found = detectCloudFolders();
    if (found.length === 0) console.log('No cloud folders found. You can still use any folder: mysync cloud add folder <path>');
    for (const f of found) console.log(`${f.label}\t${f.path}`);
  });

cloudCmd
  .command('remove <account>')
  .description('Forget a cloud account on this machine (nothing is deleted in the cloud)')
  .action((ref) => {
    try {
      const account = resolveAccount(ref);
      removeCloudAccount(account.id);
      console.log(`Removed ${account.label}`);
    } catch (err) {
      fail(err);
    }
  });

cloudCmd
  .command('workspaces <account>')
  .description('List the folders stored in a cloud account')
  .action(async (ref) => {
    try {
      const list = await listCloudWorkspaces(resolveAccount(ref).id);
      if (list.length === 0) console.log('No folders stored there yet. Use `mysync cloud link` in a folder.');
      for (const w of list) {
        console.log(`${w.name}\t${w.devices.map((d) => d.device).join(', ') || 'no devices yet'}`);
      }
    } catch (err) {
      fail(err);
    }
  });

cloudCmd
  .command('link <account> [name]')
  .description('Sync this folder through a cloud account (under [name], default: the folder name)')
  .action(async (ref, name) => {
    try {
      const root = requireRepoRoot();
      const account = resolveAccount(ref);
      const result = await linkCloud(root, account.id, name);
      console.log(`${result.created ? 'Stored' : 'Re-linked'} as '${result.name}' in ${account.label}.`);
      console.log(`On another device: mysync cloud join ${account.provider} ${result.name}`);
      console.log('Run `mysync watch` to keep it in sync.');
    } catch (err) {
      fail(err);
    }
  });

cloudCmd
  .command('unlink <account>')
  .description('Stop syncing this folder through a cloud account (its cloud copy stays)')
  .action((ref) => {
    try {
      const account = resolveAccount(ref);
      if (!unlinkCloud(requireRepoRoot(), account.id)) throw new Error(`fatal: this folder is not synced through ${account.label}`);
      console.log(`No longer syncing through ${account.label}`);
    } catch (err) {
      fail(err);
    }
  });

cloudCmd
  .command('join <account> <name> [directory]')
  .description('Get a folder stored in a cloud account, merging any files already in [directory]')
  .option('--device <name>', 'Name for this device (defaults to hostname)')
  .action(async (ref, name, directory, options) => {
    try {
      const result = await joinCloud(resolveAccount(ref).id, name, directory, { device: options.device });
      console.log(`Joined '${name}' in ${result.repoRoot}`);
      console.log('Run `mysync watch` in that folder to keep it in sync automatically.');
    } catch (err) {
      fail(err);
    }
  });

// publish
program
  .command('publish [name]')
  .description('Put this folder on your hub under a name so any device can join it')
  .option('-p, --port <number>', 'Port the watcher listens on (for LAN addresses in the invite)', 3000)
  .action(async (name, options) => {
    try {
      const root = requireRepoRoot();
      const code = await publish(root, name, { port: parseInt(options.port, 10) });
      console.log('\nOn any other device:');
      console.log(`  mysync join ${code}`);
      console.log('The invite code contains the workspace token. Treat it like a password.');
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// watch
program
  .command('watch')
  .description('Keep this folder continuously in sync with its peers (no add/commit/push needed)')
  .option('-p, --port <number>', 'Port to accept connections on', 3000)
  .option('-H, --host <address>', 'Host address to bind to', '0.0.0.0')
  .option('-i, --interval <seconds>', 'How often to check peers', 3)
  .option('--no-discover', 'Do not announce or look for devices on the local network')
  .option('--no-serve', 'Do not accept incoming connections (only sync out to peers)')
  .action((options) => {
    try {
      const root = requireRepoRoot();
      const handle = watch(root, {
        port: parseInt(options.port, 10),
        host: options.host,
        serve: options.serve,
        discover: options.discover,
        interval: Math.max(1, parseFloat(options.interval)),
      });
      process.on('SIGINT', () => {
        handle.stop();
        process.exit(0);
      });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// nearby
program
  .command('nearby')
  .description('List mysync devices announcing themselves on the local network')
  .action(async () => {
    const found = await scanNearby();
    if (found.length === 0) console.log('No devices found. Is `mysync watch` running on another device?');
    for (const d of found) console.log(`${d.device}	${d.url}	folder ${d.folderId}`);
  });

// sync
program
  .command('sync')
  .description('One-shot: save local changes, then merge with and send to every peer')
  .action(async () => {
    try {
      const root = requireRepoRoot();
      const hash = await snapshot(root);
      if (hash) console.log(`Saved local changes (${hash.slice(0, 7)})`);
      const results = await syncAll(root);
      if (results.length === 0) console.log('No peers configured. Use `mysync join` or `mysync remote add`.');
      let failed = false;
      for (const r of results) {
        if (!r.ok) {
          failed = true;
          console.error(`${r.name}: ${r.error}`);
          continue;
        }
        console.log(`${r.name}: received=${r.pulled} sent=${r.pushed ? 'yes' : 'nothing new'}`);
        for (const file of r.conflicts) console.log(`  conflict in ${file}: both versions kept`);
      }
      if (failed) process.exit(1);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// invite
program
  .command('invite')
  .description('Print an invite code other devices can use with `mysync join`')
  .option('-p, --port <number>', 'Port the watcher listens on', 3000)
  .option('--device <name>', 'Name this device (shown in commit history)')
  .action((options) => {
    try {
      const root = requireRepoRoot();
      if (options.device) {
        const config = getConfig(root);
        config.device = options.device;
        writeConfig(root, config);
      }
      console.log(`mysync join ${buildInvite(root, parseInt(options.port, 10))}`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// serve
program
  .command('serve')
  .description('Start the mysync HTTP server to allow cloning and pushing')
  .option('-p, --port <number>', 'Port to listen on', 3000)
  .option('-H, --host <address>', 'Host address to bind to', '0.0.0.0')
  .option('-d, --dir <path>', 'Path to the repository to serve (defaults to current directory)')
  .action((options) => {
    try {
      const root = requireRepoRoot(options.dir || process.cwd());
      const port = parseInt(options.port, 10);
      serve(root, port, options.host);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// clone
program
  .command('clone <url> [directory]')
  .description('Clone a repository into a new directory')
  .option('-t, --token <token>', 'Access token printed by the serving device')
  .action(async (url, directory, options) => {
    try {
      await clone(url, directory, { token: options.token });
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
  .option('-t, --token <token>', 'Access token printed by the serving device')
  .action((name, url, options) => {
    try {
      const root = requireRepoRoot();
      setRemote(root, name, url, options.token);
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
  .command('pull <remote> [branch]')
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
  .command('push <remote> [branch]')
  .description('Update remote refs along with associated objects')
  .action(async (remote, branch) => {
    try {
      const root = requireRepoRoot();
      console.log(await push(root, remote, branch));
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// init
program
  .command('init [directory]')
  .description('Create an empty mysync repository or reinitialize an existing one')
  .action((directory = '.') => {
    try {
      const result = initRepo(directory);
      if (result.initialized) {
        console.log(`Initialized empty mysync repository in ${result.path}/.mysync`);
      } else {
        console.log(`Reinitialized existing mysync repository in ${result.path}/.mysync`);
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
