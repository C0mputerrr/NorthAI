/**
 * Windows system adapter.
 *
 * Owns one long-lived PowerShell worker (see windows/worker.ps1) and speaks a
 * newline-delimited JSON request/response protocol to it. Requests are matched
 * to responses by id, so concurrent probes cannot cross wires.
 *
 * On a non-Windows host every method returns `unavailable` with a truthful
 * reason rather than inventing plausible numbers.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import * as R from '../lib/result.js';
import { cleanError } from '../lib/redact.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'windows', 'worker.ps1');
const SOURCE = 'powershell';

/** Prefer PowerShell 7 when present -- it starts faster and is better behaved. */
function findPowerShell() {
  const candidates = [];
  const pf = process.env.ProgramFiles;
  if (pf) candidates.push(join(pf, 'PowerShell', '7', 'pwsh.exe'));
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  candidates.push(join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export class WindowsAdapter {
  constructor(config) {
    this.config = config;
    this.supported = process.platform === 'win32';
    this.shell = this.supported ? findPowerShell() : null;
    this.child = null;
    this.ready = false;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    this.startFailure = null;
    this.restarts = 0;
  }

  get unavailableReason() {
    if (!this.supported) {
      return `System telemetry needs Windows; this dashboard is running on ${process.platform}.`;
    }
    if (!this.shell) return 'Could not locate powershell.exe or pwsh.exe.';
    if (!existsSync(WORKER)) return 'The PowerShell probe script is missing from the install.';
    return this.startFailure;
  }

  /** Boot the worker, or return false with `startFailure` set. */
  ensureWorker() {
    if (this.child && !this.child.killed) return true;
    if (!this.supported || !this.shell || !existsSync(WORKER)) return false;

    // Restarting forever would mask a real problem and spin the CPU.
    if (this.restarts > 8) {
      this.startFailure = 'The PowerShell worker kept exiting; giving up until restart.';
      return false;
    }

    try {
      this.child = spawn(
        this.shell,
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', WORKER],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err) {
      this.startFailure = cleanError(err.message);
      return false;
    }
    this.restarts++;

    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.handleLine(line));

    let stderrBuf = '';
    this.child.stderr.on('data', (d) => {
      if (stderrBuf.length < 8192) stderrBuf += d;
    });

    this.child.on('exit', (code) => {
      this.ready = false;
      this.child = null;
      const detail = cleanError(stderrBuf) || `exit code ${code}`;
      this.startFailure = `PowerShell worker exited (${detail}).`;
      // Fail every in-flight request rather than leaving callers hanging.
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, error: this.startFailure });
        this.pending.delete(id);
      }
    });

    this.startFailure = null;
    return true;
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray output; ignore rather than crash the reader
    }
    if (msg.ready) {
      this.ready = true;
      this.restarts = 0; // a clean start clears the backoff budget
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    entry.resolve(msg);
  }

  /** Send one request and await its matching reply. */
  request(op, params = {}, timeoutMs) {
    return new Promise((resolve) => {
      if (!this.ensureWorker()) {
        return resolve({ ok: false, error: this.unavailableReason });
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `PowerShell probe "${op}" timed out.` });
      }, timeoutMs ?? this.config.timeouts.system);

      this.pending.set(id, { resolve, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: cleanError(err.message) });
      }
    });
  }

  async call(op, params, timeoutMs) {
    if (!this.supported) return R.unavailable(this.unavailableReason, SOURCE);
    const started = Date.now();
    const res = await this.request(op, params, timeoutMs);
    const ms = Date.now() - started;
    if (!res.ok) return R.unavailable(res.error || 'PowerShell probe failed.', SOURCE, ms);
    return R.ok(res.data, SOURCE, ms);
  }

  /** Machine vitals: CPU, memory, disks, battery, network. */
  system() {
    return this.call('snapshot');
  }

  /** Windowed applications, the foreground window, and top memory consumers. */
  apps() {
    return this.call('apps');
  }

  /** Both in a single round trip -- what the Overview page wants. */
  all() {
    return this.call('all');
  }

  /**
   * Safe, explicitly-gated actions. Guarded twice: here, and again inside the
   * worker's protected-process check, so a bug in this layer still cannot
   * close lsass.
   */
  async action(op, params) {
    if (!['open', 'focus', 'close'].includes(op)) {
      return R.error(`Unsupported action "${op}".`, SOURCE);
    }
    if (!this.config.allowProcessActions) {
      return R.notConfigured(
        'Process actions are disabled. Set "allowProcessActions": true in north.config.json to enable Open/Focus/Close.',
        SOURCE,
      );
    }
    return this.call(op, params, 15000);
  }

  shutdown() {
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill();
      } catch { /* already gone */ }
      this.child = null;
    }
  }
}
