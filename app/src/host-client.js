import { EventEmitter } from 'node:events';
import { utilityProcess } from 'electron';

/**
 * Talks to the engine process (engine-host.mjs). Requests resolve with the host's
 * answer; host events are re-emitted as 'event:<name>'. If the process dies, every
 * waiting request is rejected and 'exit' is emitted so the app can restart it.
 */
export class HostClient extends EventEmitter {
  constructor({ entry, env = {}, onOutput = () => {} }) {
    super();
    this.entry = entry;
    this.env = env;
    this.onOutput = onOutput;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stopping = false;
  }

  /** Starts the process and resolves once it says it is ready. */
  start() {
    this.stopping = false;
    this.proc = utilityProcess.fork(this.entry, [], {
      env: { ...process.env, ...this.env },
      stdio: 'pipe',
      serviceName: 'MySync engine',
    });
    this.proc.stdout?.on('data', (d) => this.onOutput(String(d)));
    this.proc.stderr?.on('data', (d) => this.onOutput(String(d)));
    this.proc.on('message', (msg) => this._onMessage(msg));
    this.proc.on('exit', (code) => this._onExit(code));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The sync engine did not start')), 20_000);
      this.once('event:ready', () => {
        clearTimeout(timer);
        resolve();
      });
      this.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('The sync engine stopped while starting'));
      });
    });
  }

  call(cmd, args = {}, timeoutMs = 10 * 60 * 1000) {
    if (!this.proc) return Promise.reject(new Error('The sync engine is not running'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The sync engine took too long to answer'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.postMessage({ id, cmd, args });
    });
  }

  async stop() {
    this.stopping = true;
    if (!this.proc) return;
    try {
      await this.call('shutdown', {}, 3000);
    } catch {
      // fall through to kill
    }
    setTimeout(() => this.proc?.kill(), 500).unref?.();
  }

  _onMessage(msg) {
    if (msg?.event) {
      this.emit(`event:${msg.event}`, msg.data);
      return;
    }
    const waiting = this.pending.get(msg?.id);
    if (!waiting) return;
    this.pending.delete(msg.id);
    clearTimeout(waiting.timer);
    if (msg.ok) waiting.resolve(msg.result);
    else waiting.reject(Object.assign(new Error(msg.error?.message || 'Something went wrong'), { code: msg.error?.code }));
  }

  _onExit(code) {
    this.proc = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('The sync engine stopped unexpectedly'));
    }
    this.pending.clear();
    this.emit('exit', { code, expected: this.stopping });
  }
}
