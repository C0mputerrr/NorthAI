/**
 * North Command Center -- local HTTP server.
 *
 * Zero runtime dependencies: Node's own http, child_process and fs are enough
 * for a localhost dashboard, and every dependency avoided is startup time and
 * resident memory saved.
 *
 * Live updates use Server-Sent Events rather than WebSocket. The data flow is
 * one-directional (server pushes state, client POSTs the rare command), SSE
 * needs no handshake library, and it reconnects on its own.
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { TtlCache } from './lib/cache.js';
import { createTransport } from './adapters/transport.js';
import { NorthAdapter } from './adapters/openclaw.js';
import { WindowsAdapter } from './adapters/windows.js';
import { MetricsStore } from './adapters/metrics.js';
import { resolveIntegrations } from './adapters/integrations.js';
import { resolveSecurity } from './adapters/security.js';
import { serveStatic } from './static.js';
import * as R from './lib/result.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WEB = join(ROOT, 'web');

const config = loadConfig(ROOT);
const cache = new TtlCache();
const transport = createTransport(config);
const north = new NorthAdapter(transport, cache, config);
const windows = new WindowsAdapter(config);
const metrics = new MetricsStore(north, config);

// ---------------------------------------------------------------- helpers --

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Reject requests whose Host header is not a loopback name.
 *
 * The server already binds to 127.0.0.1, so it is not reachable from the
 * network. This additionally blocks DNS rebinding, where a hostile page
 * resolves its own domain to 127.0.0.1 and drives this API from the user's
 * browser. Without the check, binding to loopback alone would not save us.
 */
function hostAllowed(req) {
  const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

// -------------------------------------------------------------- SSE clients --

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();
let pollTimers = [];

function broadcast(event, payload) {
  if (clients.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    // A slow client must not stall the loop; write() buffers and we let Node
    // handle backpressure, dropping the client if the socket is already gone.
    if (!res.writableEnded) res.write(frame);
  }
}

/**
 * Observed cost of one CLI round trip, as a rough median.
 *
 * The configured intervals assume a fast transport. On a machine where each
 * `openclaw` launch costs seconds, polling every 3s would queue work faster
 * than it completes and peg a core for nothing.
 */
function observedRpcCost() {
  const samples = transport.samples.slice(-12).map((s) => s.ms).filter(Number.isFinite);
  if (samples.length < 3) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Polling only runs while at least one browser tab is listening. With no
 * dashboard open, the process sits idle at effectively zero CPU instead of
 * spawning PowerShell and openclaw calls into the void.
 *
 * Each loop reschedules itself *after* its work finishes rather than on a
 * fixed interval, and stretches its delay to match what the transport
 * actually costs. A slow OpenClaw CLI therefore makes the dashboard refresh
 * less often instead of falling further behind.
 */
/**
 * Incremented on every stop. In-flight loops compare against it and exit, so a
 * poll that was already awaiting a slow call cannot resurrect itself after the
 * last browser tab closed.
 */
let pollGeneration = 0;
let polling = false;

function startPolling() {
  if (polling) return;
  polling = true;
  const generation = pollGeneration;

  const loop = async (fn, baseInterval) => {
    while (generation === pollGeneration && clients.size > 0) {
      try {
        await fn();
      } catch (err) {
        console.error('[poll]', err.message);
      }
      if (generation !== pollGeneration || clients.size === 0) break;
      // Never spend more than roughly half the wall clock polling.
      const delay = Math.max(baseInterval, observedRpcCost() * 2);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        pollTimers.push(timer);
      });
    }
  };

  loop(async () => broadcast('status', await buildOverview()), config.intervals.status);
  loop(async () => {
    const activity = await north.activity(60);
    broadcast('activity', activity);
    await metrics.refresh();
    broadcast('metrics', metrics.snapshot());
  }, config.intervals.activity);
}

function stopPolling() {
  pollGeneration++;
  polling = false;
  for (const t of pollTimers) clearTimeout(t);
  pollTimers = [];
}

// ------------------------------------------------------------ compositions --

async function buildOverview() {
  const [status, system] = await Promise.all([
    north.northStatus(),
    windows.supported ? windows.all() : Promise.resolve(R.unavailable(windows.unavailableReason, 'powershell')),
  ]);
  return { north: status, system };
}

// ----------------------------------------------------------------- routing --

const routes = {
  'GET /api/meta': async () => ({
    name: 'North Command Center',
    version: '1.0.0',
    platform: process.platform,
    node: process.version,
    startedAt: north.startedAt,
    gateway: {
      port: config.gatewayPort,
      url: config.gatewayUrl,
      binary: transport.binary(),
      binaryFound: Boolean(transport.binary()),
      openclawHome: config.openclawHome,
      configFound: config.openclaw.configFound,
      configError: config.openclaw.configError,
    },
    capabilities: {
      windows: windows.supported,
      windowsReason: windows.supported ? null : windows.unavailableReason,
      console: config.allowConsole,
      processActions: config.allowProcessActions,
    },
  }),

  'GET /api/overview': buildOverview,

  'GET /api/system': async () => ({
    system: windows.supported
      ? await windows.system()
      : R.unavailable(windows.unavailableReason, 'powershell'),
    apps: windows.supported
      ? await windows.apps()
      : R.unavailable(windows.unavailableReason, 'powershell'),
  }),

  'GET /api/activity': async (url) => {
    const limit = Math.min(300, Number(url.searchParams.get('limit') ?? 100) || 100);
    return north.activity(limit);
  },

  'GET /api/integrations': () => resolveIntegrations(north, windows, config),

  'GET /api/skills': () => north.skills(),

  'GET /api/security': () => resolveSecurity(north, config),

  'GET /api/performance': async () => {
    await metrics.refresh();
    return metrics.snapshot();
  },

  'GET /api/sessions': () => north.sessions(),

  'POST /api/console': async (_url, body) => {
    if (!config.allowConsole) {
      return R.notConfigured('The console is disabled in north.config.json.', 'console');
    }
    const text = String(body.text ?? '').trim();
    if (!text) return R.error('Empty command.', 'console');
    if (text.length > 8000) return R.error('Command is too long.', 'console');

    const started = Date.now();
    const result = await north.send(text, { sessionId: body.sessionId });
    metrics.recordRequest({
      text,
      totalMs: Date.now() - started,
      ok: R.isOk(result),
      method: result.source,
      sessionId: body.sessionId,
    });
    // A command usually changes what the other panels should show.
    cache.invalidate();
    return result;
  },

  'POST /api/system/action': async (_url, body) => {
    const op = String(body.op ?? '');
    const params = { target: body.target, pid: body.pid };
    const result = await windows.action(op, params);
    cache.invalidate();
    return result;
  },
};

const server = createServer(async (req, res) => {
  if (!hostAllowed(req)) {
    return sendJson(res, 403, { error: 'Only loopback hosts may reach this dashboard.' });
  }
  // No CORS headers by design: nothing off-origin should be calling this.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  // --- live stream ---
  if (key === 'GET /api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    startPolling();

    // Send the current state immediately so a new tab is never blank.
    buildOverview().then((payload) => {
      if (!res.writableEnded) res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
    });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
      if (clients.size === 0) stopPolling();
    });
    return;
  }

  // --- json api ---
  const handler = routes[key];
  if (handler) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : null;
      const payload = await handler(url, body);
      return sendJson(res, 200, payload);
    } catch (err) {
      console.error(`[api] ${key}:`, err.message);
      return sendJson(res, 500, { state: 'error', reason: err.message, source: 'server' });
    }
  }

  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: `No such endpoint: ${url.pathname}` });
  }

  // --- static, with SPA fallback ---
  if (req.method === 'GET') {
    if (await serveStatic(WEB, url.pathname, res)) return;
    if (await serveStatic(WEB, '/index.html', res)) return;
  }
  res.writeHead(404).end('Not found');
});

// A busy port is the most likely startup failure and almost always means the
// dashboard is already running. Say that, rather than printing a stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use.`);
    console.error(`  North Command Center may already be running: http://${config.host}:${config.port}`);
    console.error(`  To use a different port, set "port" in north.config.json.\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n  Not permitted to bind ${config.host}:${config.port}.\n`);
  } else {
    console.error(`\n  Could not start the server: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const bin = transport.binary();
  console.log(`\n  North Command Center`);
  console.log(`  http://${config.host}:${config.port}\n`);
  console.log(`  OpenClaw binary   ${bin ?? 'not found on PATH'}`);
  console.log(`  OpenClaw home     ${config.openclawHome}${config.openclaw.configFound ? '' : ' (no openclaw.json)'}`);
  console.log(`  Gateway port      ${config.gatewayPort}`);
  console.log(`  System telemetry  ${windows.supported ? 'PowerShell' : `unavailable (${process.platform})`}`);
  console.log(`  Console writes    ${config.allowConsole ? 'enabled' : 'disabled'}`);
  console.log(`  Process actions   ${config.allowProcessActions ? 'enabled' : 'disabled'}\n`);
});

function shutdown() {
  stopPolling();
  windows.shutdown();
  for (const c of clients) c.end();
  server.close(() => process.exit(0));
  // Do not let a lingering socket hold the process open forever.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
