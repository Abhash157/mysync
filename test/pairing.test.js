import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Agent,
  PairingBook,
  join,
  decodeInvite,
  isLocalAddress,
  requestPairing,
  pollPairing,
  cancelPairing,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandbox = path.resolve(__dirname, 'sandbox_pairing');
const d = (name) => path.join(sandbox, name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(sandbox, { recursive: true, force: true });
for (const n of ['owner', 'laptop', 'plain']) fs.mkdirSync(d(n), { recursive: true });
process.env.MYSYNC_DISCOVERY_PORT = '41955';
process.env.MYSYNC_GLOBAL_CONFIG = path.join(sandbox, 'global.json');

async function until(check, what, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await check()) return; } catch { /* keep waiting */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const rejects = async (promise, status) => {
  try { await promise; } catch (err) { assert.strictEqual(err.status, status, `expected HTTP ${status}, got ${err.status}: ${err.message}`); return err; }
  throw new Error(`expected HTTP ${status}`);
};

console.log('Running mysync pairing test suite...\n');

const agents = [];
try {
  console.log('1. Address checks and the request book...');
  for (const ok of ['10.1.2.3', '192.168.0.9', '172.16.5.5', '172.31.0.1', '169.254.1.1', 'fe80::1', 'fd12::1', '::ffff:192.168.1.7']) {
    assert.ok(isLocalAddress(ok), `${ok} is local`);
  }
  for (const no of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.64.1.1', '2001:db8::1', '127.0.0.1', '::1', '::ffff:127.0.0.1', '', undefined, 'garbage']) {
    assert.ok(!isLocalAddress(no), `${no} is not local`);
  }
  {
    const book = new PairingBook();
    const events = [];
    book.on('request', (r) => events.push(['request', r.device]));
    book.on('end', (e) => events.push(['end', e.status]));
    const ask = (address) => book.request({ folderId: 'f'.repeat(16), name: 'N', device: 'Dev', address, via: '10.0.0.1' });
    const first = ask('10.0.0.5');
    assert.strictEqual(ask('10.0.0.5').id, first.id, 'asking twice returns the same request');
    assert.match(first.code, /^\d{4}$/);
    for (let i = 6; i < 10; i++) ask(`10.0.0.${i}`);
    assert.throws(() => ask('10.0.0.99'), (err) => err.status === 429, 'at most five requests at once');
    assert.strictEqual(book.list().length, 5);
    assert.ok(!('invite' in book.list()[0]), 'the invite is never part of what the UI is shown');

    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60 * 1000;
    try { book.sweep(); } finally { Date.now = realNow; }
    assert.strictEqual(book.list().length, 0, 'unanswered requests expire');
    assert.strictEqual(book.get(first.id).status, 'expired');
    assert.ok(events.filter((e) => e[0] === 'end' && e[1] === 'expired').length === 5);
  }

  console.log('2. A device with pairing on is found by one without a folder...');
  fs.writeFileSync(path.join(d('owner'), 'hello.txt'), 'hello from the owner\n');
  fs.writeFileSync(path.join(d('plain'), 'secret.txt'), 'not open to pairing\n');
  const plain = new Agent({ port: 3090, interval: 1, debounce: 100 }); // pairing off, as in MySync today
  const owner = new Agent({ port: 3091, interval: 1, debounce: 100, pairing: true });
  const laptop = new Agent({ port: 3092, interval: 1, debounce: 100, pairing: true });
  agents.push(plain, owner, laptop);
  const pairEvents = [];
  const endEvents = [];
  owner.on('pair', (r) => pairEvents.push(r));
  owner.on('pairEnd', (e) => endEvents.push(e));
  await plain.start();
  await owner.start();
  await laptop.start();
  const plainWs = plain.addWorkspace(d('plain'));
  const ownerWs = owner.addWorkspace(d('owner'));
  await until(() => laptop.nearby().length === 1, 'laptop sees the owner');
  const found = laptop.nearby()[0];
  assert.strictEqual(found.name, 'owner');
  assert.ok(found.urls[0].endsWith(`/f/${ownerWs.folderId}`), 'announced url points at the folder');
  assert.ok(!laptop.nearby().some((n) => n.folderId === plainWs.folderId), 'a device without pairing is not offered');

  console.log('3. Asking to join waits for a person, and a request can be withdrawn...');
  const asked = await requestPairing(found.urls, 'Laptop');
  assert.match(asked.code, /^\d{4}$/);
  assert.strictEqual(pairEvents.length, 1);
  assert.strictEqual(pairEvents[0].device, 'Laptop');
  assert.strictEqual(pairEvents[0].code, asked.code, 'both sides see the same code');
  const heardOn = new URL(found.urls[0]).hostname;
  assert.ok(isLocalAddress(pairEvents[0].address), 'the owner sees which device is asking');
  assert.deepStrictEqual(await pollPairing(asked.url, asked.id), { status: 'pending' });
  assert.strictEqual((await requestPairing(found.urls, 'Laptop')).id, asked.id, 'a retry reuses the open request');
  assert.strictEqual(owner.pendingPairs().length, 1);

  await cancelPairing(asked.url, asked.id);
  assert.strictEqual(owner.pendingPairs().length, 0, 'withdrawn request is gone from the owner');
  assert.strictEqual(endEvents.at(-1).status, 'expired');
  assert.strictEqual((await pollPairing(asked.url, asked.id)).status, 'expired');

  console.log('4. Declining blocks the same device for a while...');
  const second = await requestPairing(found.urls, 'Laptop');
  assert.strictEqual(owner.answerPair(second.id, false), true);
  assert.deepStrictEqual(await pollPairing(second.url, second.id), { status: 'denied' });
  const blocked = await rejects(requestPairing(found.urls, 'Laptop'), 429);
  assert.match(blocked.message, /declined/);
  assert.strictEqual(owner.answerPair(second.id, true), false, 'an answered request cannot be answered again');

  console.log('5. The endpoints stay shut when they should...');
  const base = found.urls[0];
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.strictEqual((await post(`${base}/pair`, 'x'.repeat(5000))).status, 413, 'oversized body is refused');
  assert.strictEqual((await post(`http://127.0.0.1:3091/f/${'0'.repeat(16)}/pair`, '{}')).status, 404, 'unknown folder');
  assert.ok([401, 404].includes((await post(`http://127.0.0.1:3090/f/${plainWs.folderId}/pair`, '{}')).status), 'no pairing unless the agent opted in');
  assert.strictEqual((await fetch(`${base}/pair/${'0'.repeat(32)}`)).status, 404, 'unknown request id');
  assert.strictEqual((await post(`http://127.0.0.1:3091/f/${ownerWs.folderId}/pair`, '{}')).status, 403, 'a request from this very machine (a tunnel, say) is not "my network"');
  ownerWs.pause();
  assert.strictEqual((await post(`${base}/pair`, '{}')).status, 503, 'paused folders do not take requests');
  await until(() => laptop.nearby().length === 0, 'a paused folder stops being offered', 25000);
  ownerWs.resume();
  await until(() => laptop.nearby().length === 1, 'and is offered again once resumed');

  console.log('6. Allowing hands over an invite and the folders sync...');
  owner.pairing.declined.clear(); // the cooldown from step 4 is not what this step is about
  const third = await requestPairing(laptop.nearby()[0].urls, 'Laptop');
  assert.strictEqual(owner.answerPair(third.id, true), true);
  assert.strictEqual(endEvents.at(-1).status, 'approved');
  const answer = await pollPairing(third.url, third.id);
  assert.strictEqual(answer.status, 'approved');
  assert.match(answer.invite, /^mys1\./);
  const invite = decodeInvite(answer.invite);
  assert.ok(invite.l[0].startsWith(`http://${heardOn}:3091/f/`), 'the address the laptop already reached is tried first');
  assert.strictEqual((await pollPairing(third.url, third.id)).status, 'approved', 'a lost answer can be read again');

  await join(answer.invite, d('laptop'), { initialSync: false });
  laptop.addWorkspace(d('laptop'), { validate: false });
  await until(() => fs.existsSync(path.join(d('laptop'), 'hello.txt')), 'the owner file reaches the laptop');
  assert.strictEqual(fs.readFileSync(path.join(d('laptop'), 'hello.txt'), 'utf8'), 'hello from the owner\n');
  assert.ok(!laptop.nearby().some((n) => n.folderId === ownerWs.folderId), 'a folder this device already syncs is no longer offered');
  fs.writeFileSync(path.join(d('laptop'), 'reply.txt'), 'from the laptop\n');
  await until(() => fs.existsSync(path.join(d('owner'), 'reply.txt')), 'and the other way');
  assert.ok(ownerWs.activity.some((a) => /Allowed Laptop/.test(a.text)), 'the owner log shows who was allowed');

  console.log('\nAll pairing tests passed.');
} finally {
  for (const a of agents) a.stop();
  await sleep(200);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
process.exit(0);
