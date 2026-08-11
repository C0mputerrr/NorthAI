#!/usr/bin/env node
/**
 * A stand-in for the real `openclaw` CLI, for developing and testing the
 * dashboard without a live gateway.
 *
 * It implements the two surfaces the transport actually uses --
 * `gateway call <method> --params <json> --json` and an HTTP `/healthz` probe
 * -- with representative payloads in the shapes OpenClaw documents.
 *
 * This exists so the adapter chain can be exercised end to end. It is a test
 * fixture and is never used at runtime: the dashboard resolves the real
 * binary unless `openclawBin` is deliberately pointed here.
 *
 *   Serve the fake gateway:  node tests/fixtures/fake-openclaw.mjs --serve
 *   Act as the CLI:          node tests/fixtures/fake-openclaw.mjs gateway call status --json
 */

import { createServer } from 'node:http';

const now = Date.now();
const BOOT = now - 3 * 3600 * 1000;

const SESSIONS = [
  {
    id: 'sess_main',
    title: 'Desktop control',
    agentId: 'north',
    channel: 'cli',
    model: 'claude-opus-5',
    messageCount: 42,
    tokens: 38210,
    contextWindow: 200000,
    updatedAt: new Date(now - 45_000).toISOString(),
    createdAt: new Date(BOOT).toISOString(),
    status: 'idle',
  },
  {
    id: 'sess_tg',
    title: 'Telegram',
    agentId: 'north',
    channel: 'telegram',
    model: 'claude-opus-5',
    messageCount: 7,
    updatedAt: new Date(now - 1_800_000).toISOString(),
    status: 'idle',
  },
];

/** Synthetic log lines carrying the documented timing fields. */
function logLines(limit = 200) {
  const out = [];
  for (let i = 0; i < Math.min(limit, 60); i++) {
    const at = new Date(now - i * 47_000).toISOString();
    const isTool = i % 3 === 1;
    out.push(
      JSON.stringify(
        isTool
          ? {
              time: at,
              level: 'info',
              message: 'tool execution complete',
              toolName: ['bash', 'read_file', 'browser.open', 'powershell'][i % 4],
              durationMs: 120 + ((i * 37) % 900),
              session_id: 'sess_main',
              spanId: `span_tool_${i}`,
            }
          : {
              time: at,
              level: 'info',
              message: 'model call complete',
              model: 'claude-opus-5',
              durationMs: 900 + ((i * 211) % 4200),
              timeToFirstByteMs: 220 + ((i * 53) % 700),
              requestPayloadBytes: 18_000 + ((i * 977) % 40_000),
              responseStreamBytes: 1_400 + ((i * 313) % 9_000),
              session_id: 'sess_main',
              spanId: `span_model_${i}`,
            },
      ),
    );
  }
  return out;
}

const METHODS = {
  status: () => ({
    version: '2026.7.1-2',
    uptimeMs: now - BOOT,
    service: { state: 'running', manager: 'schtasks' },
  }),
  health: () => ({ ok: true, eventLoop: { delay: 1.8, utilization: 0.06, degraded: false } }),
  'sessions.list': () => ({ sessions: SESSIONS }),
  'models.list': () => ({
    active: { id: 'claude-opus-5', provider: 'anthropic' },
    models: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }],
  }),
  'usage.status': () => ({
    inputTokens: 812_400,
    outputTokens: 96_120,
    contextTokens: 38_210,
    contextWindow: 200_000,
    costUsd: 4.12,
  }),
  'audit.activity.list': ({ limit = 50 }) =>
    ({
      items: Array.from({ length: Math.min(limit, 30) }, (_, i) => {
        const kinds = ['request', 'thinking', 'tool', 'result', 'error'];
        const kind = kinds[i % 5];
        return {
          id: `evt_${i}`,
          at: new Date(now - i * 96_000).toISOString(),
          kind,
          message:
            {
              request: 'Open my Socria project',
              thinking: 'Resolving project path and checking git status',
              tool: 'powershell: Start-Process code',
              result: 'Opened Socria in VS Code',
              error: 'Spotify is not running; cannot attach',
            }[kind],
          toolName: kind === 'tool' ? 'powershell' : undefined,
          durationMs: kind === 'tool' ? 340 + i * 11 : kind === 'result' ? 2100 + i * 31 : undefined,
          sessionId: 'sess_main',
          channel: 'cli',
          error: kind === 'error' ? 'process not found' : undefined,
        };
      }),
    }),
  'logs.tail': ({ limit }) => ({ lines: logLines(limit) }),
  'skills.status': () => ({
    skills: [
      { name: 'windows-control', description: 'Drive Windows applications and windows.', enabled: true, version: '1.4.0', source: 'local', lastUsed: new Date(now - 300_000).toISOString() },
      { name: 'spotify', description: 'Control Spotify playback.', enabled: true, version: '0.9.1', source: 'clawhub' },
      { name: 'browser', description: 'Open and drive a browser session.', enabled: true, version: '2.0.0', source: 'builtin', lastUsed: new Date(now - 86_400_000).toISOString() },
      { name: 'home-assistant', description: 'Home automation bridge.', enabled: false, version: '0.3.0', source: 'clawhub' },
    ],
  }),
  'channels.status': () => ({
    telegram: { status: 'connected', name: 'telegram' },
    imessage: { status: 'error', error: 'not paired' },
    slack: { enabled: true, connected: false },
  }),
  'plugins.list': () => ([
    { id: 'diagnostics-prometheus', name: 'diagnostics-prometheus', enabled: true },
    { id: 'github', name: 'github', enabled: true, status: 'connected' },
    { id: 'spotify', name: 'spotify', enabled: true, status: 'connected' },
  ]),
  'node.list': () => ({ nodes: [{ id: 'phone-pixel', name: 'phone', status: 'connected' }] }),
  'tools.effective': () => ({
    tools: [
      { name: 'bash', description: 'Execute shell commands', enabled: true },
      { name: 'powershell', description: 'Execute PowerShell commands', enabled: true },
      { name: 'read_file', description: 'Read files from disk', enabled: true },
      { name: 'write_file', description: 'Write files to disk', enabled: true },
      { name: 'browser_open', description: 'Open a browser page', enabled: true },
      { name: 'telegram_send', description: 'Send a chat message', enabled: true },
      { name: 'calendar_list', description: 'Read calendar events', enabled: false },
    ],
  }),
  'commands.list': () => ({ commands: [{ name: 'status' }, { name: 'restart' }] }),
  'exec.approvals.get': () => ({ mode: 'ask', allowlist: ['git status', 'ls'] }),
  'approval.history': () => ({
    items: [
      { at: new Date(now - 600_000).toISOString(), summary: 'Start-Process spotify', decision: 'approved' },
      { at: new Date(now - 7_200_000).toISOString(), summary: 'Remove-Item C:\\temp\\*', decision: 'denied' },
    ],
  }),
  'sessions.dispatch': ({ message }) => ({
    reply: `(fake gateway) I received: "${message}". A real North would act on this.`,
    sessionId: 'sess_main',
  }),
  'chat.send': ({ message }) => ({ reply: `(fake gateway) echo: ${message}` }),
};

// ---------------------------------------------------------------- HTTP mode --

if (process.argv.includes('--serve')) {
  const port = Number(process.env.OPENCLAW_GATEWAY_PORT ?? 18789);
  createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/readyz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, eventLoop: { delay: 1.8, utilization: 0.06, degraded: false } }));
      return;
    }
    res.writeHead(404).end('{}');
  }).listen(port, '127.0.0.1', () => console.log(`fake gateway on :${port}`));
} else {
  // ------------------------------------------------------------- CLI mode --
  const args = process.argv.slice(2);
  const idx = args.indexOf('call');

  if (args[0] === 'gateway' && idx !== -1) {
    const method = args[idx + 1];
    const pIdx = args.indexOf('--params');
    let params = {};
    if (pIdx !== -1) {
      try { params = JSON.parse(args[pIdx + 1]); } catch { /* keep defaults */ }
    }
    const fn = METHODS[method];
    if (!fn) {
      process.stderr.write(`unknown method ${method}\n`);
      process.exit(1);
    }
    // Mirror the documented envelope so the transport's unwrapping is exercised.
    process.stdout.write(JSON.stringify({ ok: true, payload: fn(params) }));
    process.exit(0);
  }

  if (args[0] === 'gateway' && args[1] === 'status') {
    process.stdout.write(JSON.stringify({ service: { state: 'running' }, gateway: { version: '2026.7.1-2' } }));
    process.exit(0);
  }

  process.stderr.write(`fake-openclaw: unsupported invocation: ${args.join(' ')}\n`);
  process.exit(1);
}
