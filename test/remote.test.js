import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '../bin/cli.js');
const sandboxDir = path.resolve(__dirname, 'sandbox_remote');
const repoA = path.join(sandboxDir, 'repoA');
const repoB = path.join(sandboxDir, 'repoB');

function runCli(args, cwd) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GDIF_AUTHOR_NAME: 'Test User',
      GDIF_AUTHOR_EMAIL: 'test@gdif.local',
    },
  });
}

function cleanSandbox() {
  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
  fs.mkdirSync(sandboxDir, { recursive: true });
  fs.mkdirSync(repoA, { recursive: true });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('Running gdif remote syncing test suite...\n');

async function runTests() {
  cleanSandbox();

  // 1. Initialize Repo A
  console.log('1. Initializing Repo A...');
  runCli(['init'], repoA);
  fs.writeFileSync(path.join(repoA, 'hello.txt'), 'Hello from Repo A\n', 'utf8');
  runCli(['add', 'hello.txt'], repoA);
  runCli(['commit', '-m', 'Initial commit in Repo A'], repoA);

  // 2. Start server on Repo A
  console.log('2. Starting gdif server on Repo A (port 3030)...');
  const serverProc = spawn(process.execPath, [cliPath, 'serve', '-p', '3030'], {
    cwd: repoA,
    stdio: 'inherit'
  });

  try {
    // Wait for server to start
    await sleep(2000);

    // 3. Clone to Repo B
    console.log('3. Cloning Repo A to Repo B...');
    runCli(['clone', 'http://127.0.0.1:3030', 'repoB'], sandboxDir);
    
    assert(fs.existsSync(path.join(repoB, 'hello.txt')), 'hello.txt should be cloned');
    const content = fs.readFileSync(path.join(repoB, 'hello.txt'), 'utf8');
    assert.strictEqual(content, 'Hello from Repo A\n', 'Content should match');

    // 4. Make a commit in Repo B and push
    console.log('4. Making commit in Repo B and pushing to origin...');
    fs.writeFileSync(path.join(repoB, 'world.txt'), 'Hello World\n', 'utf8');
    runCli(['add', 'world.txt'], repoB);
    runCli(['commit', '-m', 'Add world.txt in Repo B'], repoB);
    
    runCli(['push', 'origin', 'main'], repoB);

    // 5. Pull changes back to Repo A? 
    // Repo A shouldn't pull itself, but its refs were updated by Repo B's push.
    // If Repo A runs checkout to fast-forward, it should see world.txt!
    console.log('5. Verifying Repo A received the push...');
    const logA = runCli(['log', '--oneline'], repoA);
    // Since push updates remote refs, wait, push updates local branch ref on server?
    // In our simplified server, POST /refs/heads/main updates refs/heads/main directly.
    // However, the working directory of Repo A isn't automatically checked out.
    // If we checkout main, it should restore working dir.
    runCli(['checkout', 'main'], repoA);
    assert(fs.existsSync(path.join(repoA, 'world.txt')), 'world.txt should exist in Repo A after push and checkout');

    console.log('\nAll remote tests passed successfully! [5/5]');
  } finally {
    serverProc.kill();
    cleanSandbox();
  }
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
