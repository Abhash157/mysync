import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '../bin/cli.js');
const sandboxDir = path.resolve(__dirname, 'sandbox');

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function runCli(args, cwd = sandboxDir) {
  const output = execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GDIF_AUTHOR_NAME: 'Test User',
      GDIF_AUTHOR_EMAIL: 'test@gdif.local',
    },
  });
  return stripAnsi(output);
}

function cleanSandbox() {
  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
  fs.mkdirSync(sandboxDir, { recursive: true });
}

console.log('Running gdif test suite...\n');

try {
  cleanSandbox();

  // 1. Test init
  console.log('1. Testing "gdif init"...');
  const initOutput = runCli(['init']);
  assert(initOutput.includes('Initialized empty gdif repository'), 'Init output mismatch');
  assert(fs.existsSync(path.join(sandboxDir, '.gdif')), '.gdif directory not created');
  assert(fs.existsSync(path.join(sandboxDir, '.gdif', 'HEAD')), 'HEAD file not created');
  assert(fs.existsSync(path.join(sandboxDir, '.gdif', 'index')), 'index file not created');

  // 2. Test status on empty repo
  console.log('2. Testing "gdif status" on empty repository...');
  const statusEmpty = runCli(['status']);
  assert(statusEmpty.includes('On branch main'), 'Should be on main branch');
  assert(statusEmpty.includes('No commits yet'), 'Should show no commits');

  // 3. Test ignore and file creation
  console.log('3. Testing ignore rules and untracked file detection...');
  fs.writeFileSync(path.join(sandboxDir, '.gdifignore'), 'ignored.txt\nlogs/\n', 'utf8');
  fs.writeFileSync(path.join(sandboxDir, 'ignored.txt'), 'secret\n', 'utf8');
  fs.mkdirSync(path.join(sandboxDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(sandboxDir, 'logs', 'app.log'), 'log line\n', 'utf8');
  fs.writeFileSync(path.join(sandboxDir, 'hello.txt'), 'Hello, World!\n', 'utf8');

  const statusUntracked = runCli(['status']);
  assert(statusUntracked.includes('hello.txt'), 'hello.txt should be untracked');
  assert(statusUntracked.includes('.gdifignore'), '.gdifignore should be untracked');
  assert(!statusUntracked.includes('ignored.txt'), 'ignored.txt should be ignored');
  assert(!statusUntracked.includes('app.log'), 'logs/ should be ignored');

  // 4. Test add
  console.log('4. Testing "gdif add"...');
  runCli(['add', '.']);
  const statusStaged = runCli(['status']);
  assert(statusStaged.includes('Changes to be committed:'), 'Should show changes to be committed');
  assert(statusStaged.includes('new file:   hello.txt'), 'hello.txt should be staged as new file');
  assert(statusStaged.includes('new file:   .gdifignore'), '.gdifignore should be staged');

  // 5. Test commit
  console.log('5. Testing "gdif commit"...');
  const commitOutput = runCli(['commit', '-m', 'feat: initial commit']);
  assert(commitOutput.includes('[main'), 'Commit output should mention branch');
  assert(commitOutput.includes('feat: initial commit'), 'Commit output should contain message');

  const statusAfterCommit = runCli(['status']);
  assert(statusAfterCommit.includes('nothing to commit, working tree clean'), 'Working tree should be clean');

  // 6. Test file modification and diff
  console.log('6. Testing file changes and "gdif diff"...');
  fs.writeFileSync(path.join(sandboxDir, 'hello.txt'), 'Hello, World!\nWelcome to gdif!\n', 'utf8');
  const diffOutput = runCli(['diff']);
  assert(diffOutput.includes('+Welcome to gdif!'), 'Diff should show added line');

  // 7. Test restore
  console.log('7. Testing "gdif restore"...');
  runCli(['restore', 'hello.txt']);
  const restoredContent = fs.readFileSync(path.join(sandboxDir, 'hello.txt'), 'utf8');
  assert.strictEqual(restoredContent, 'Hello, World!\n', 'File content should be restored');

  // 8. Commit modification
  console.log('8. Staging and committing modification...');
  fs.writeFileSync(path.join(sandboxDir, 'hello.txt'), 'Hello, Universe!\n', 'utf8');
  runCli(['add', 'hello.txt']);
  runCli(['commit', '-m', 'chore: update greeting']);

  // 9. Test branching and checkout
  console.log('9. Testing "gdif branch" and "gdif checkout"...');
  runCli(['branch', 'feature-alpha']);
  const branchesList = runCli(['branch']);
  assert(branchesList.includes('* main'), 'main should be current branch');
  assert(branchesList.includes('feature-alpha'), 'feature-alpha should be listed');

  runCli(['checkout', 'feature-alpha']);
  const branchStatus = runCli(['status']);
  assert(branchStatus.includes('On branch feature-alpha'), 'Should be on feature-alpha');

  // Add file on feature branch
  fs.writeFileSync(path.join(sandboxDir, 'feature.txt'), 'Feature A active\n', 'utf8');
  runCli(['add', 'feature.txt']);
  runCli(['commit', '-m', 'feat: add feature alpha file']);
  assert(fs.existsSync(path.join(sandboxDir, 'feature.txt')), 'feature.txt should exist on feature-alpha');

  // Switch back to main
  runCli(['checkout', 'main']);
  assert(!fs.existsSync(path.join(sandboxDir, 'feature.txt')), 'feature.txt should NOT exist on main branch');

  // Switch back to feature-alpha
  runCli(['checkout', 'feature-alpha']);
  assert(fs.existsSync(path.join(sandboxDir, 'feature.txt')), 'feature.txt should be restored on feature-alpha');

  // 10. Test log
  console.log('10. Testing "gdif log"...');
  const fullLog = runCli(['log']);
  assert(fullLog.includes('feat: add feature alpha file'), 'Log should show feature commit');
  assert(fullLog.includes('chore: update greeting'), 'Log should show second commit');
  assert(fullLog.includes('feat: initial commit'), 'Log should show initial commit');

  const onelineLog = runCli(['log', '--oneline']);
  const lines = onelineLog.trim().split('\n');
  assert.strictEqual(lines.length, 3, 'Oneline log should show 3 commits');

  console.log('\nAll tests passed successfully! [10/10]');
} finally {
  cleanSandbox();
}
