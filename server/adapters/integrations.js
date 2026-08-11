/**
 * Integration status resolution.
 *
 * The rule this file exists to enforce: never claim connectivity we have not
 * observed. Every verdict carries the evidence that produced it, and the
 * absence of evidence produces UNKNOWN or NOT CONFIGURED -- never NOT
 * CONNECTED, which is itself a claim.
 *
 * In particular, when the gateway is unreachable we do not mark every service
 * disconnected. We do not know their state; we only know we cannot ask.
 */

import * as R from '../lib/result.js';

/** @typedef {'connected'|'partial'|'not_connected'|'error'|'unknown'|'not_configured'} IntegrationState */

/**
 * The services the dashboard knows how to look for.
 *
 * `match` is tested against channel ids, plugin names and node names reported
 * by OpenClaw. `kind` only affects presentation.
 */
const CATALOG = [
  { id: 'openclaw',       label: 'OpenClaw',        kind: 'core',      match: ['openclaw', 'gateway'] },
  { id: 'windows',        label: 'Windows',         kind: 'core',      match: ['windows', 'win32'] },
  { id: 'claude-code',    label: 'Claude Code',     kind: 'agent',     match: ['claude-code', 'claudecode', 'claude'] },
  { id: 'chatgpt',        label: 'ChatGPT',         kind: 'agent',     match: ['chatgpt', 'openai', 'codex'] },
  { id: 'browser',        label: 'Browser',         kind: 'tool',      match: ['browser', 'chrome', 'chromium', 'playwright', 'puppeteer', 'edge'] },
  { id: 'telegram',       label: 'Telegram',        kind: 'channel',   match: ['telegram'] },
  { id: 'spotify',        label: 'Spotify',         kind: 'service',   match: ['spotify'] },
  { id: 'outlook',        label: 'Outlook',         kind: 'service',   match: ['outlook', 'microsoft-graph', 'msgraph'] },
  { id: 'calendar',       label: 'Calendar',        kind: 'service',   match: ['calendar', 'gcal', 'google-calendar', 'caldav'] },
  { id: 'github',         label: 'GitHub',          kind: 'service',   match: ['github', 'gh'] },
  { id: 'phone',          label: 'Phone',           kind: 'device',    match: ['phone', 'mobile', 'android', 'ios', 'imessage'] },
  { id: 'tesla',          label: 'Tesla',           kind: 'device',    match: ['tesla'] },
  { id: 'home-assistant', label: 'Home Assistant',  kind: 'device',    match: ['home-assistant', 'homeassistant', 'hass'] },
];

/** Local process names that hint an app is running. Evidence, not connection. */
const LOCAL_HINTS = {
  spotify: ['spotify'],
  browser: ['chrome', 'msedge', 'firefox', 'brave', 'arc'],
  outlook: ['outlook'],
  telegram: ['telegram'],
  'claude-code': ['claude'],
};

const CONNECTED_RE = /^(connected|ready|ok|online|active|running|authenticated|healthy|enabled)$/i;
const PARTIAL_RE = /^(partial|degraded|connecting|starting|pending|reconnecting|limited|idle)$/i;
const ERROR_RE = /^(error|failed|failure|unauthorized|denied|crashed|invalid)$/i;
const DISCONNECTED_RE = /^(disconnected|offline|stopped|logged.?out|disabled|inactive)$/i;

/** Interpret whatever status word OpenClaw reported for an entry. */
function readState(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const word = String(
    entry.status ?? entry.state ?? entry.connection ?? entry.health ?? '',
  ).trim();

  if (word) {
    if (CONNECTED_RE.test(word)) return 'connected';
    if (PARTIAL_RE.test(word)) return 'partial';
    if (ERROR_RE.test(word)) return 'error';
    if (DISCONNECTED_RE.test(word)) return 'not_connected';
  }
  if (entry.error) return 'error';
  // Booleans are the other common encoding.
  if (entry.connected === true) return 'connected';
  if (entry.connected === false) return 'not_connected';
  if (entry.enabled === true && entry.ready === false) return 'partial';
  if (entry.enabled === true) return 'partial'; // enabled but liveness unproven
  if (entry.enabled === false) return 'not_connected';
  return null;
}

/** Flatten an RPC payload into `[id, entry]` pairs regardless of its shape. */
function entriesOf(result) {
  if (!R.isOk(result)) return [];
  const p = result.data;
  if (Array.isArray(p)) {
    return p.map((e) => [String(e?.id ?? e?.name ?? e?.channel ?? e?.type ?? ''), e]);
  }
  if (p && typeof p === 'object') {
    const nested = p.channels ?? p.plugins ?? p.items ?? p.nodes ?? p.entries;
    if (nested) return entriesOf({ state: 'ok', data: nested });
    return Object.entries(p);
  }
  return [];
}

export async function resolveIntegrations(adapter, windows, config) {
  const [channels, plugins, nodes, health, apps] = await Promise.all([
    adapter.channels(),
    adapter.plugins(),
    adapter.nodes(),
    adapter.gatewayHealth(),
    windows.supported ? windows.apps() : Promise.resolve(R.unavailable('Not Windows', 'powershell')),
  ]);

  const gatewayUp = R.isOk(health);
  // If we cannot reach OpenClaw at all, we cannot speak to any of its
  // integrations. Say so once, rather than 13 misleading "not connected"s.
  const blind =
    !gatewayUp && !R.isOk(channels) && !R.isOk(plugins) && !R.isOk(nodes);

  const pools = [
    { source: 'channels.status', pairs: entriesOf(channels) },
    { source: 'plugins.list', pairs: entriesOf(plugins) },
    { source: 'node.list', pairs: entriesOf(nodes) },
  ];

  const runningProcesses = R.isOk(apps)
    ? new Set(
        [...(apps.data.windowed ?? []), ...(apps.data.topMemory ?? [])].map((p) =>
          String(p.name ?? '').toLowerCase(),
        ),
      )
    : null;

  const declared = new Set(
    [...(config.openclaw.configuredChannels ?? []), ...(config.openclaw.configuredPlugins ?? [])].map(
      (s) => s.toLowerCase(),
    ),
  );

  const results = CATALOG.map((svc) => {
    const evidence = [];
    let state = null;
    /** Every distinct verdict seen for this service, across all pools. */
    const observedStates = new Set();

    // --- special cases we can answer directly, without the gateway ---------
    if (svc.id === 'openclaw') {
      state = gatewayUp ? 'connected' : R.isOk(channels) ? 'partial' : 'not_connected';
      evidence.push(
        gatewayUp
          ? `Gateway answered /healthz on port ${config.gatewayPort}.`
          : health.reason ?? 'Gateway did not answer.',
      );
      return finalize(svc, state, evidence);
    }
    if (svc.id === 'windows') {
      if (process.platform === 'win32') {
        state = windows.supported && !windows.startFailure ? 'connected' : 'partial';
        evidence.push(
          state === 'connected'
            ? 'PowerShell probe is responding.'
            : windows.unavailableReason ?? 'PowerShell probe not yet started.',
        );
      } else {
        state = 'not_connected';
        evidence.push(`Dashboard host is ${process.platform}, not Windows.`);
      }
      return finalize(svc, state, evidence);
    }

    // --- evidence from OpenClaw's own reporting ---------------------------
    for (const pool of pools) {
      for (const [id, entry] of pool.pairs) {
        const haystack = `${id} ${entry?.name ?? ''} ${entry?.type ?? ''}`.toLowerCase();
        if (!svc.match.some((m) => haystack.includes(m))) continue;

        const observed = readState(entry);
        evidence.push(
          observed
            ? `${pool.source}: "${id || svc.id}" reports ${observed.replace('_', ' ')}.`
            : `${pool.source}: "${id || svc.id}" is present but reports no status.`,
        );
        if (observed) observedStates.add(observed);
        else if (!state) state = 'unknown';
        // Strongest signal wins: a connected report beats an enabled-only one.
        if (observed && rank(observed) > rank(state)) state = observed;
      }
    }

    // --- configuration presence -------------------------------------------
    if (!state && svc.match.some((m) => [...declared].some((d) => d.includes(m)))) {
      state = 'unknown';
      evidence.push('Named in openclaw.json but the gateway reported no live status.');
    }

    // --- local process hint (never sufficient on its own) -----------------
    const hints = LOCAL_HINTS[svc.id];
    if (hints && runningProcesses) {
      const found = hints.find((h) => [...runningProcesses].some((p) => p.includes(h)));
      if (found) {
        evidence.push(`"${found}" is running locally (app present; not proof North can drive it).`);
        if (!state) state = 'unknown';
      }
    }

    if (!state) {
      if (blind) {
        return finalize(svc, 'unknown', [
          'Cannot determine: OpenClaw gateway is unreachable, so its integrations cannot be queried.',
        ]);
      }
      return finalize(svc, 'not_configured', [
        'No matching channel, plugin or node is configured in OpenClaw.',
      ]);
    }

    // A service can be reported by several sources at once -- e.g. a phone
    // node that is paired while its iMessage channel is failing. Reporting
    // that as flatly "connected" would bury the failure, so any mix of a
    // healthy and an unhealthy signal resolves to PARTIAL and both lines of
    // evidence stay on the card.
    if (observedStates.has('connected') && (observedStates.has('error') || observedStates.has('not_connected'))) {
      state = 'partial';
    }
    return finalize(svc, state, evidence);
  });

  return R.ok(
    {
      integrations: results,
      blind,
      sources: {
        channels: { state: channels.state, reason: channels.reason },
        plugins: { state: plugins.state, reason: plugins.reason },
        nodes: { state: nodes.state, reason: nodes.reason },
      },
    },
    'integrations',
    null,
  );
}

function rank(state) {
  return { connected: 4, error: 3, partial: 2, not_connected: 1, unknown: 0 }[state] ?? -1;
}

function finalize(svc, state, evidence) {
  return {
    id: svc.id,
    label: svc.label,
    kind: svc.kind,
    state,
    evidence: evidence.filter(Boolean),
  };
}

export { CATALOG };
