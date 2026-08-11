/**
 * Transport layer to OpenClaw.
 *
 * This is the only module that knows how to talk to OpenClaw. Everything above
 * it deals in RPC method names and Result envelopes, so if a better transport
 * appears (see the note on WebSocket below) it can be swapped here without
 * touching a single adapter or route.
 *
 * Why the CLI rather than the gateway WebSocket:
 *
 *   The gateway's WS control plane requires an Ed25519 device identity, a
 *   signed challenge/response handshake and an operator pairing approval
 *   before it will accept RPC. OpenClaw's own docs direct client authors at
 *   `@openclaw/gateway-client` rather than hand-rolling that flow -- but that
 *   package is currently a reserved 0.0.0 placeholder with no implementation.
 *   Reimplementing the handshake against docs alone would be exactly the
 *   brittle coupling we are trying to avoid.
 *
 *   `openclaw gateway call <method> --params <json> --json` is a documented,
 *   first-class RPC passthrough that reaches the same method surface and
 *   delegates authentication to OpenClaw itself. It costs a process spawn per
 *   call, which is why everything above this layer is cached and deduplicated.
 *
 * If the client package ships for real, implement `WsTransport` with the same
 * two methods as `CliTransport` and select it in `createTransport`.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { get as httpGet } from 'node:http';
import * as R from '../lib/result.js';
import { cleanError } from '../lib/redact.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * RPC method names are interpolated into an argument vector. Even though we
 * only ever pass names chosen by our own code, validating them keeps that
 * true if a future route ever forwards a user-supplied string.
 */
const METHOD_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** Locate the openclaw executable once, so we can spawn it without a shell. */
export function resolveOpenClawBinary(configured) {
  const candidates = [];
  if (configured && configured !== 'openclaw') candidates.push(configured);

  // Typical global-install locations, checked before shelling out to which/where.
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(join(appData, 'npm', 'openclaw.cmd'));
      candidates.push(join(appData, 'npm', 'openclaw.ps1'));
    }
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(join(localAppData, 'Programs', 'openclaw', 'openclaw.exe'));
    }
  } else {
    candidates.push('/usr/local/bin/openclaw', '/usr/bin/openclaw');
    candidates.push(join(homedir(), '.local', 'bin', 'openclaw'));
    candidates.push(join(homedir(), '.bun', 'bin', 'openclaw'));
  }

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }

  // Fall back to a PATH lookup.
  const lookup = IS_WINDOWS ? 'where.exe' : 'which';
  try {
    const out = execFileSync(lookup, [configured || 'openclaw'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && existsSync(first)) return first;
  } catch {
    // Not on PATH. Fall through -- the caller reports this as unavailable.
  }
  return null;
}

/**
 * Spawn a command and collect stdout/stderr with a hard timeout.
 * Never uses a shell: arguments are passed as a vector, so no quoting or
 * injection concerns even if a value contains spaces or metacharacters.
 */
export function run(command, args, { timeout = 8000, cwd, input } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let child;

    // .cmd/.bat shims cannot be exec'd directly on Windows; they need the
    // command processor. We invoke ComSpec explicitly with an argument vector
    // rather than enabling `shell: true`, which would concatenate and re-parse
    // the whole command line.
    const needsComSpec = IS_WINDOWS && /\.(cmd|bat)$/i.test(command);
    const spawnCmd = needsComSpec ? process.env.ComSpec || 'cmd.exe' : command;
    const spawnArgs = needsComSpec ? ['/d', '/s', '/c', command, ...args] : args;

    try {
      child = spawn(spawnCmd, spawnArgs, {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: err.message, ms: 0 });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ ...result, ms });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, code: -1, stdout, stderr: `Timed out after ${timeout}ms`, timedOut: true });
    }, timeout);

    // Bound the buffers. A runaway log tail should not become a memory leak.
    const LIMIT = 8 * 1024 * 1024;
    child.stdout.on('data', (d) => {
      if (stdout.length < LIMIT) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < LIMIT) stderr += d;
    });
    child.on('error', (err) => finish({ ok: false, code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * OpenClaw prints human-readable preamble before JSON on some commands.
 * Extract the first complete JSON value rather than assuming a clean stdout.
 */
export function extractJson(stdout) {
  const text = stdout.trim();
  if (!text) return { ok: false, error: 'Empty output' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // Fall through to scanning.
  }
  const start = text.search(/[[{]/);
  if (start === -1) return { ok: false, error: 'No JSON found in output' };

  // Walk forward tracking depth so we stop at the end of the first value,
  // ignoring braces that appear inside strings.
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        try {
          return { ok: true, value: JSON.parse(text.slice(start, i + 1)) };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      }
    }
  }
  return { ok: false, error: 'Truncated JSON in output' };
}

export class CliTransport {
  constructor(config) {
    this.config = config;
    this.bin = null;
    this.binResolved = false;
    this.version = null;
    /** Observed transport latency, newest last. Feeds the Performance page. */
    this.samples = [];
  }

  get name() {
    return 'openclaw-cli';
  }

  /** Resolve the binary lazily and remember the answer. */
  binary() {
    if (!this.binResolved) {
      this.bin = resolveOpenClawBinary(this.config.openclawBin);
      this.binResolved = true;
    }
    return this.bin;
  }

  /** Re-run discovery, e.g. after the user installs OpenClaw mid-session. */
  reset() {
    this.binResolved = false;
    this.bin = null;
    this.version = null;
  }

  recordSample(method, ms, ok) {
    this.samples.push({ method, ms, ok, at: Date.now() });
    if (this.samples.length > 500) this.samples.splice(0, this.samples.length - 500);
  }

  /**
   * Invoke an OpenClaw gateway RPC method.
   * @param {string} method  e.g. "sessions.list"
   * @param {object} params
   * @returns {Promise<import('../lib/result.js').ResultState extends never ? never : object>}
   */
  async rpc(method, params = {}, { timeout } = {}) {
    if (!METHOD_RE.test(method)) {
      return R.error(`Refusing to call malformed RPC method "${method}"`, this.name);
    }
    const bin = this.binary();
    if (!bin) {
      return R.unavailable(
        'The `openclaw` command was not found. Set `openclawBin` in north.config.json to its full path.',
        this.name,
      );
    }

    const args = ['gateway', 'call', method, '--json'];
    if (params && Object.keys(params).length > 0) {
      args.push('--params', JSON.stringify(params));
    }
    // No port/url flag by default. `gateway call` on current builds rejects
    // `--port` outright ("does not recognize option"), and it does not need
    // one: the CLI resolves the gateway from the same ~/.openclaw/openclaw.json
    // we read. Only pass an explicit target when the user deliberately
    // overrode it, in which case the CLI's own config would be wrong.
    if (this.config.gatewayUrlOverride) {
      args.push('--url', this.config.gatewayUrlOverride);
    }

    const res = await run(bin, args, { timeout: timeout ?? this.config.timeouts.rpc });
    this.recordSample(method, res.ms, res.ok);

    if (!res.ok) {
      const detail = cleanError(res.stderr || res.stdout) || `exit code ${res.code}`;
      if (res.timedOut) {
        return R.unavailable(`Gateway did not answer ${method} within the timeout.`, this.name, res.ms);
      }
      // A refused connection means the gateway is down, which is a normal
      // state to be in -- not an error to shout about.
      if (/ECONNREFUSED|not running|connection refused|unable to connect/i.test(detail)) {
        return R.unavailable('OpenClaw gateway is not reachable.', this.name, res.ms);
      }
      if (/unknown method|method not found|unsupported/i.test(detail)) {
        return R.notConfigured(`This OpenClaw build does not expose ${method}.`, this.name);
      }
      return R.error(detail, this.name, res.ms);
    }

    const parsed = extractJson(res.stdout);
    if (!parsed.ok) {
      return R.error(`Could not parse ${method} output: ${parsed.error}`, this.name, res.ms);
    }
    // `gateway call` wraps successful payloads; unwrap when present so callers
    // see the method's own shape either way.
    const v = parsed.value;
    const payload =
      v && typeof v === 'object' && !Array.isArray(v) && 'payload' in v && ('ok' in v || 'type' in v)
        ? v.payload
        : v;
    return R.ok(payload, this.name, res.ms);
  }

  /** Run a non-RPC openclaw subcommand (e.g. `gateway status`). */
  async cli(args, { timeout, json = true } = {}) {
    const bin = this.binary();
    if (!bin) {
      return R.unavailable('The `openclaw` command was not found.', this.name);
    }
    const res = await run(bin, args, { timeout: timeout ?? this.config.timeouts.rpc });
    this.recordSample(args.join(' '), res.ms, res.ok);
    if (!res.ok) {
      if (res.timedOut) return R.unavailable(`\`openclaw ${args[0]}\` timed out.`, this.name, res.ms);
      return R.error(cleanError(res.stderr || res.stdout) || `exit code ${res.code}`, this.name, res.ms);
    }
    if (!json) return R.ok(res.stdout, this.name, res.ms);
    const parsed = extractJson(res.stdout);
    if (!parsed.ok) return R.error(`Unparseable output: ${parsed.error}`, this.name, res.ms);
    return R.ok(parsed.value, this.name, res.ms);
  }

  /**
   * Cheap liveness check straight to the gateway's HTTP probe. Costs no
   * process spawn, so this is what the status strip polls most often.
   * `/healthz` is documented as answering as soon as the server can serve HTTP.
   */
  health(path = '/healthz', timeoutMs = 2000) {
    return new Promise((resolve) => {
      const started = Date.now();
      const url = `${this.config.healthUrl}${path}`;
      const req = httpGet(url, { timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          if (body.length < 64 * 1024) body += d;
        });
        res.on('end', () => {
          const ms = Date.now() - started;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let parsed = null;
            try { parsed = JSON.parse(body); } catch { /* plain-text probe is fine */ }
            resolve(R.ok(parsed ?? { raw: body.trim() || 'ok' }, 'gateway-http', ms));
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            // Answering at all proves the process is up, even if it won't
            // tell an unauthenticated caller anything else.
            resolve(R.ok({ authenticated: false, note: 'Gateway is up but requires auth for details.' }, 'gateway-http', ms));
          } else {
            resolve(R.unavailable(`Gateway probe returned HTTP ${res.statusCode}.`, 'gateway-http', ms));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(R.unavailable(`No response from ${url} within ${timeoutMs}ms.`, 'gateway-http', Date.now() - started));
      });
      req.on('error', (err) => {
        const ms = Date.now() - started;
        if (err.code === 'ECONNREFUSED') {
          resolve(R.unavailable(`Nothing is listening on port ${this.config.gatewayPort}.`, 'gateway-http', ms));
        } else {
          resolve(R.unavailable(cleanError(err.message), 'gateway-http', ms));
        }
      });
    });
  }
}

export function createTransport(config) {
  return new CliTransport(config);
}
