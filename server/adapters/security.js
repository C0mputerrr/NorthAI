/**
 * Capability and permission surface.
 *
 * Answers "what can North actually do right now", derived from the tools the
 * gateway reports as *effective* rather than from what is merely installed.
 *
 * This page deliberately shows no credentials. It reports that an auth mode is
 * configured, never the token; that a channel exists, never its session file.
 * The config reader upstream never loads secret fields into memory at all, so
 * there is nothing here to accidentally render.
 */

import * as R from '../lib/result.js';

/**
 * Capability buckets, in the order the user asked for them. `match` is tested
 * against tool names and descriptions reported by OpenClaw.
 */
const CAPABILITIES = [
  {
    id: 'read-system',
    label: 'Read system state',
    detail: 'Inspect processes, resource usage and window state on this PC.',
    risk: 'low',
    match: ['status', 'process', 'system', 'ps', 'top', 'sysinfo', 'read_system'],
  },
  {
    id: 'execute',
    label: 'Execute commands',
    detail: 'Run shell, PowerShell or terminal commands on this machine.',
    risk: 'high',
    match: ['exec', 'bash', 'shell', 'powershell', 'terminal', 'run', 'command', 'cmd'],
  },
  {
    id: 'files',
    label: 'Access files',
    detail: 'Read, write and delete files in permitted workspaces.',
    risk: 'high',
    match: ['file', 'read', 'write', 'edit', 'fs', 'glob', 'grep', 'workspace'],
  },
  {
    id: 'browser',
    label: 'Browser control',
    detail: 'Open pages and drive a browser session.',
    risk: 'medium',
    match: ['browser', 'web', 'fetch', 'playwright', 'puppeteer', 'navigate', 'url'],
  },
  {
    id: 'email',
    label: 'Email',
    detail: 'Read or send mail on your behalf.',
    risk: 'high',
    match: ['mail', 'email', 'outlook', 'gmail', 'imap', 'smtp'],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    detail: 'Read or modify calendar events.',
    risk: 'medium',
    match: ['calendar', 'event', 'schedule', 'cron'],
  },
  {
    id: 'messaging',
    label: 'Messaging',
    detail: 'Send and receive messages through connected chat channels.',
    risk: 'high',
    match: ['message', 'send', 'chat', 'telegram', 'signal', 'whatsapp', 'slack', 'discord', 'imessage'],
  },
  {
    id: 'devices',
    label: 'External devices',
    detail: 'Reach paired phones, vehicles, and home automation.',
    risk: 'high',
    match: ['node', 'device', 'tesla', 'home', 'hass', 'phone', 'speaker', 'tts'],
  },
];

function toolNames(result) {
  if (!R.isOk(result)) return [];
  const p = result.data;
  const list = Array.isArray(p)
    ? p
    : p?.tools ?? p?.items ?? p?.effective ?? p?.catalog ?? p?.commands ?? [];
  if (!Array.isArray(list)) {
    // A map of name -> definition.
    return Object.entries(p ?? {}).map(([name, def]) => ({
      name,
      description: def?.description ?? null,
      enabled: def?.enabled ?? true,
    }));
  }
  return list.map((t) =>
    typeof t === 'string'
      ? { name: t, description: null, enabled: true }
      : {
          name: String(t.name ?? t.id ?? t.tool ?? 'unknown'),
          description: t.description ?? t.summary ?? null,
          enabled: t.enabled !== false,
        },
  );
}

export async function resolveSecurity(adapter, config) {
  const [tools, approvals, commands, history] = await Promise.all([
    adapter.tools(),
    adapter.execApprovals(),
    adapter.commands(),
    adapter.approvalHistory(20),
  ]);

  const all = [...toolNames(tools), ...toolNames(commands)];
  // Deduplicate: tools.effective and commands.list overlap on some builds.
  const byName = new Map();
  for (const t of all) {
    if (!byName.has(t.name)) byName.set(t.name, t);
  }
  const unique = [...byName.values()];
  const determinable = R.isOk(tools) || R.isOk(commands);

  const capabilities = CAPABILITIES.map((cap) => {
    if (!determinable) {
      return {
        ...cap,
        granted: 'unknown',
        tools: [],
        note: 'OpenClaw did not report its effective tool list, so this cannot be determined.',
      };
    }
    const matched = unique.filter((t) => {
      const hay = `${t.name} ${t.description ?? ''}`.toLowerCase();
      return cap.match.some((m) => hay.includes(m));
    });
    const enabled = matched.filter((t) => t.enabled);
    return {
      ...cap,
      granted: enabled.length > 0 ? 'granted' : matched.length > 0 ? 'present-disabled' : 'not-granted',
      tools: enabled.slice(0, 12).map((t) => t.name),
      toolCount: enabled.length,
      note: null,
    };
  });

  return R.ok(
    {
      capabilities,
      determinable,
      toolTotal: unique.length,
      // Non-secret posture facts. Never the token itself.
      posture: {
        gatewayAuthMode: config.openclaw.authMode ?? 'unknown',
        gatewayBind: config.openclaw.bind ?? 'unknown',
        dashboardHost: config.host,
        dashboardLoopbackOnly: config.host === '127.0.0.1' || config.host === 'localhost',
        consoleEnabled: config.allowConsole,
        processActionsEnabled: config.allowProcessActions,
        configFound: config.openclaw.configFound,
        configError: config.openclaw.configError,
      },
      execApprovals: R.isOk(approvals) ? approvals.data : null,
      execApprovalsState: approvals.state,
      execApprovalsReason: approvals.reason,
      recentApprovals: R.isOk(history)
        ? (Array.isArray(history.data) ? history.data : history.data?.items ?? []).slice(0, 20)
        : [],
      recentApprovalsState: history.state,
      sources: {
        tools: { state: tools.state, reason: tools.reason },
        commands: { state: commands.state, reason: commands.reason },
      },
    },
    'security',
    null,
  );
}
