/**
 * The North adapter.
 *
 * Translates OpenClaw's RPC surface into the shapes the dashboard's pages
 * consume. Nothing above this file knows an RPC method name; nothing below it
 * knows what a "page" is.
 *
 * Every method returns a Result envelope. When OpenClaw cannot answer, the
 * envelope says so and the UI renders an explicit unavailable state -- we
 * never substitute a plausible-looking number.
 */

import * as R from '../lib/result.js';

/** Pull the first present key from an object, tolerating naming drift. */
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** Coerce the many shapes a list-ish RPC payload can take into an array. */
function toArray(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const k of keys) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  // Some methods return a map keyed by id.
  const values = Object.values(payload);
  if (values.length && values.every((v) => v && typeof v === 'object')) return values;
  return [];
}

export class NorthAdapter {
  /**
   * @param {import('./transport.js').CliTransport} transport
   * @param {import('../lib/cache.js').TtlCache} cache
   * @param {object} config
   */
  constructor(transport, cache, config) {
    this.transport = transport;
    this.cache = cache;
    this.config = config;
    this.startedAt = Date.now();
  }

  /**
   * Stretch a configured cache lifetime to match what the transport costs.
   *
   * The configured intervals assume a responsive gateway. Where a single RPC
   * costs 11 seconds, re-fetching every 4 would mean the dashboard spends all
   * its time refetching and none of it idle -- and the extra freshness is
   * imaginary, since the value is already seconds old the moment it arrives.
   * Fast transports keep the configured value.
   */
  ttl(base) {
    const cost = this.transport.medianCost?.() ?? 0;
    return Math.max(base, Math.round(cost * 4));
  }

  /**
   * Try a list of RPC methods in order, returning the first that answers.
   * OpenClaw's method surface shifts between releases, and a method this build
   * does not expose comes back as `not_configured` rather than a hard failure.
   * This keeps a panel alive on older or newer builds without version sniffing.
   */
  async firstAvailable(candidates, { ttl = 0, key } = {}) {
    const attempt = async () => {
      let last = null;
      for (const [method, params] of candidates) {
        const res = await this.transport.rpc(method, params);
        if (R.isOk(res)) return { ...res, method };
        last = res;
        // Keep trying when this build lacks the method, or rejected our
        // params -- a later candidate may take a different shape. But stop
        // immediately when the gateway itself is unreachable: every candidate
        // would fail identically, and each attempt costs a process launch.
        if (res.state === 'unavailable') break;
      }
      return last ?? R.unknown('No RPC candidates were attempted.', 'openclaw-cli');
    };
    if (!key || ttl <= 0) return attempt();
    return this.cache.get(key, ttl, attempt);
  }

  // ---------------------------------------------------------------- status --

  /** Fast liveness signal: is the gateway process answering HTTP at all? */
  async gatewayHealth() {
    return this.cache.get('health', 1500, () => this.transport.health('/healthz'));
  }

  /** Richer service view: managed-service state plus a connectivity probe. */
  async gatewayStatus() {
    return this.cache.get('gateway.status', this.ttl(this.config.intervals.status), async () => {
      const rpc = await this.transport.rpc('status');
      if (R.isOk(rpc)) return rpc;
      // The RPC needs a live gateway. The CLI's own status command also reports
      // the OS service state, which is exactly what we want when it is down.
      return this.transport.cli(['gateway', 'status', '--json']);
    });
  }

  /**
   * The Overview page's headline block. Composed from several sources so a
   * partial outage degrades field-by-field instead of blanking the panel.
   */
  async northStatus() {
    const [health, status, sessions, models, usage] = await Promise.all([
      this.gatewayHealth(),
      this.gatewayStatus(),
      this.sessions(),
      this.models(),
      this.usage(),
    ]);

    const online = R.isOk(health) || R.isOk(status);
    const s = R.isOk(status) ? status.data : null;

    // Uptime: prefer whatever the gateway reports about itself. We do not
    // substitute the dashboard's own uptime, which would be a different fact
    // wearing the same label.
    let uptimeMs = null;
    const rawUptime = pick(s ?? {}, 'uptimeMs', 'uptime', 'uptimeSeconds', 'startedAt');
    if (typeof rawUptime === 'number') {
      uptimeMs = rawUptime > 1e11 ? Date.now() - rawUptime // epoch ms
        : rawUptime > 1e6 ? rawUptime                       // already ms
        : rawUptime * 1000;                                 // seconds
    } else if (typeof rawUptime === 'string') {
      const t = Date.parse(rawUptime);
      if (!Number.isNaN(t)) uptimeMs = Date.now() - t;
    }

    const sessionList = R.isOk(sessions) ? sessions.data : [];
    // "Current session" = most recently active, which is what a person means.
    const current = sessionList.length
      ? [...sessionList].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
      : null;

    return R.ok(
      {
        online,
        gateway: {
          state: online ? 'online' : 'offline',
          detail: online ? null : (health.reason ?? status.reason),
          version: pick(s ?? {}, 'version', 'gatewayVersion') ?? null,
          port: this.config.gatewayPort,
          service: pick(s ?? {}, 'service') ?? null,
          // /healthz exposes an event-loop block on local connections; a
          // degraded loop is the single best early warning of a slow North.
          eventLoop: R.isOk(health) ? pick(health.data ?? {}, 'eventLoop') ?? null : null,
        },
        model: R.isOk(models) ? models.data.active : null,
        modelState: models.state,
        modelReason: models.reason,
        session: current,
        sessionCount: sessionList.length,
        sessionsState: sessions.state,
        sessionsReason: sessions.reason,
        usage: R.isOk(usage) ? usage.data : null,
        usageState: usage.state,
        usageReason: usage.reason,
        uptimeMs,
        dashboardUptimeMs: Date.now() - this.startedAt,
        probeLatencyMs: health.ms ?? null,
      },
      'north-adapter',
      health.ms ?? null,
    );
  }

  async sessions() {
    const res = await this.firstAvailable([['sessions.list', {}]], {
      ttl: this.ttl(this.config.intervals.status),
      key: 'sessions',
    });
    return R.mapOk(res, (payload) =>
      toArray(payload, 'sessions', 'items', 'data').map((raw) => ({
        id: pick(raw, 'id', 'sessionId', 'key') ?? null,
        title: pick(raw, 'title', 'name', 'label') ?? null,
        agent: pick(raw, 'agentId', 'agent') ?? null,
        channel: pick(raw, 'channel', 'source') ?? null,
        model: pick(raw, 'model', 'modelId') ?? null,
        messageCount: pick(raw, 'messageCount', 'messages', 'count') ?? null,
        tokens: pick(raw, 'tokens', 'tokenCount', 'contextTokens') ?? null,
        contextWindow: pick(raw, 'contextWindow', 'maxTokens') ?? null,
        updatedAt: normalizeTime(pick(raw, 'updatedAt', 'lastActivity', 'lastMessageAt', 'mtime')),
        createdAt: normalizeTime(pick(raw, 'createdAt', 'started', 'startedAt')),
        status: pick(raw, 'status', 'state') ?? null,
      })),
    );
  }

  async models() {
    const res = await this.firstAvailable([['models.list', {}]], {
      ttl: this.ttl(this.config.intervals.slow),
      key: 'models',
    });
    return R.mapOk(res, (payload) => {
      const list = toArray(payload, 'models', 'items', 'data');
      const active =
        pick(payload ?? {}, 'active', 'current', 'default') ??
        list.find((m) => m && (m.active || m.default || m.selected)) ??
        null;
      return {
        active: typeof active === 'string' ? { id: active } : active,
        count: list.length,
        models: list.slice(0, 50),
      };
    });
  }

  /** Token/cost accounting. Drives the context-usage readout. */
  async usage() {
    const res = await this.firstAvailable(
      [
        ['usage.status', {}],
        ['usage.cost', {}],
      ],
      { ttl: this.ttl(this.config.intervals.slow), key: 'usage' },
    );
    return R.mapOk(res, (payload) => ({
      inputTokens: pick(payload, 'inputTokens', 'input', 'promptTokens') ?? null,
      outputTokens: pick(payload, 'outputTokens', 'output', 'completionTokens') ?? null,
      totalTokens: pick(payload, 'totalTokens', 'tokens', 'total') ?? null,
      contextTokens: pick(payload, 'contextTokens', 'contextSize') ?? null,
      contextWindow: pick(payload, 'contextWindow', 'maxContextTokens', 'window') ?? null,
      costUsd: pick(payload, 'costUsd', 'cost', 'totalCost') ?? null,
      raw: payload,
    }));
  }

  // -------------------------------------------------------------- activity --

  /**
   * The activity feed. `audit.activity.list` is the structured source and is
   * strongly preferred; the log tail is a fallback so the feed still shows
   * something on builds without the audit surface.
   */
  async activity(limit = 80) {
    const res = await this.firstAvailable([['audit.activity.list', { limit }]], {
      ttl: this.ttl(this.config.intervals.activity),
      key: `activity:${limit}`,
    });
    if (R.isOk(res)) {
      const items = toArray(res.data, 'items', 'activity', 'entries', 'events');
      if (items.length) return R.ok(items.map(normalizeActivity).filter(Boolean), 'audit.activity.list', res.ms);
    }
    return res;
  }

  /** Raw structured log lines, used for the activity fallback and latency. */
  async logs(limit = 300) {
    return this.firstAvailable([['logs.tail', { limit }]], {
      ttl: this.ttl(this.config.intervals.activity),
      key: `logs:${limit}`,
    });
  }

  // ---------------------------------------------------------------- skills --

  async skills() {
    const res = await this.firstAvailable([['skills.status', {}]], {
      ttl: this.ttl(this.config.intervals.slow),
      key: 'skills',
    });
    return R.mapOk(res, (payload) =>
      toArray(payload, 'skills', 'items', 'installed', 'entries').map((raw) => ({
        name: pick(raw, 'name', 'id', 'slug') ?? 'unnamed',
        description: pick(raw, 'description', 'summary', 'about') ?? null,
        enabled: firstBoolean(raw, 'enabled', 'active', 'installed'),
        version: pick(raw, 'version') ?? null,
        source: pick(raw, 'source', 'origin', 'scope') ?? null,
        lastUsed: normalizeTime(pick(raw, 'lastUsed', 'lastUsedAt', 'lastInvokedAt', 'usedAt')),
      })),
    );
  }

  // ---------------------------------------------------------- integrations --

  /** Channel connectivity as OpenClaw itself reports it. */
  async channels() {
    return this.firstAvailable([['channels.status', {}]], {
      ttl: this.ttl(this.config.intervals.slow),
      key: 'channels',
    });
  }

  async plugins() {
    return this.firstAvailable([['plugins.list', {}]], {
      ttl: this.ttl(this.config.intervals.slow),
      key: 'plugins',
    });
  }

  async nodes() {
    return this.firstAvailable([['node.list', {}]], {
      ttl: this.ttl(this.config.intervals.slow),
      key: 'nodes',
    });
  }

  // -------------------------------------------------------------- security --

  /**
   * Tools actually in effect, which is what North can really do right now.
   *
   * `tools.effective` is scoped to a session and rejects a call without one
   * ("must have required property 'sessionKey'"). "main" is OpenClaw's default
   * session key; the unscoped catalog is the fallback for builds that differ.
   */
  async tools() {
    return this.firstAvailable(
      [
        ['tools.effective', { sessionKey: 'main' }],
        ['tools.effective', {}],
        ['tools.catalog', {}],
      ],
      { ttl: this.ttl(this.config.intervals.slow), key: 'tools' },
    );
  }

  async execApprovals() {
    return this.firstAvailable([['exec.approvals.get', {}]], {
      ttl: this.ttl(this.config.intervals.slow),
      key: 'exec.approvals',
    });
  }

  async approvalHistory(limit = 25) {
    return this.firstAvailable([['approval.history', { limit }]], {
      ttl: this.ttl(this.config.intervals.slow),
      key: 'approval.history',
    });
  }

  async commands() {
    return this.firstAvailable([['commands.list', {}]], {
      ttl: this.ttl(this.config.intervals.slow),
      key: 'commands',
    });
  }

  // --------------------------------------------------------------- console --

  /**
   * Send a natural-language request to North.
   *
   * Uses an existing session when given one so the conversation keeps its
   * context, and reports precise timings for the Performance page. This is the
   * one write path in the dashboard.
   */
  async send(text, { sessionId } = {}) {
    const started = Date.now();

    // Current builds address a conversation by `sessionKey` and reject a call
    // without one ("invalid chat.send params: must have required property
    // 'sessionKey'"). "main" is the default key. The later candidates carry
    // older parameter spellings so this keeps working across versions.
    const key = sessionId || 'main';
    const candidates = [
      ['chat.send', { sessionKey: key, message: text }],
      ['sessions.send', { sessionKey: key, message: text }],
      ['sessions.dispatch', { sessionKey: key, message: text }],
      ['chat.send', sessionId ? { sessionId, message: text } : { message: text }],
      ['sessions.dispatch', { message: text }],
      ['send', { message: text }],
    ];

    let last = null;
    for (const [method, p] of candidates) {
      const res = await this.transport.rpc(method, p, { timeout: this.config.timeouts.console });
      if (R.isOk(res)) {
        return R.ok(
          { method, reply: extractReply(res.data), raw: res.data, totalMs: Date.now() - started },
          method,
          res.ms,
        );
      }
      last = res;
      // Keep trying when the method is missing or our params were rejected --
      // a later candidate may use the shape this build wants. Stop only when
      // the gateway is unreachable, where every attempt would fail the same
      // way and each one costs a process launch.
      if (res.state === 'unavailable') break;
    }
    return last ?? R.error('No send method available on this OpenClaw build.', 'north-adapter');
  }
}

// ------------------------------------------------------------------ helpers --

function firstBoolean(obj, ...keys) {
  for (const k of keys) {
    if (typeof obj?.[k] === 'boolean') return obj[k];
  }
  return null;
}

/** Normalize the several timestamp encodings OpenClaw payloads use. */
export function normalizeTime(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    // Heuristic: anything below ~1e12 is seconds, above is milliseconds.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Classify an activity record into the five kinds the UI distinguishes:
 * request / thinking / tool / result / error.
 */
export function classifyActivity(raw) {
  const explicit = String(
    pick(raw, 'kind', 'type', 'category', 'event') ?? '',
  ).toLowerCase();

  if (/error|fail|denied|reject|abort/.test(explicit)) return 'error';
  if (/tool|invoke|exec|command|bash|shell/.test(explicit)) return 'tool';
  if (/request|prompt|user|message.in|inbound|received/.test(explicit)) return 'request';
  if (/think|reason|plan|process/.test(explicit)) return 'thinking';
  if (/result|complete|done|response|assistant|out/.test(explicit)) return 'result';

  // Fall back to signals in the record itself.
  if (raw?.error || raw?.ok === false || raw?.success === false) return 'error';
  if (raw?.toolName || raw?.tool) return 'tool';
  if (raw?.role === 'user') return 'request';
  if (raw?.role === 'assistant') return 'result';
  const level = String(pick(raw, 'level', 'severity') ?? '').toLowerCase();
  if (level === 'error' || level === 'fatal') return 'error';
  return 'result';
}

export function normalizeActivity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at =
    normalizeTime(pick(raw, 'at', 'ts', 'time', 'timestamp', 'createdAt', 'startedAt')) ?? Date.now();

  const tool = pick(raw, 'toolName', 'tool', 'name');
  const message =
    pick(raw, 'message', 'text', 'summary', 'title', 'description', 'msg') ??
    (tool ? String(tool) : null);

  return {
    id: pick(raw, 'id', 'eventId', 'traceId') ?? `${at}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    kind: classifyActivity(raw),
    message: message ? String(message).slice(0, 800) : '(no detail)',
    tool: tool ? String(tool) : null,
    session: pick(raw, 'sessionId', 'session_id', 'session') ?? null,
    agent: pick(raw, 'agentId', 'agent_id', 'agent') ?? null,
    channel: pick(raw, 'channel') ?? null,
    // Duration is the point of the whole exercise -- surface every spelling.
    durationMs: pick(raw, 'durationMs', 'duration_ms', 'elapsedMs', 'tookMs') ?? null,
    ttftMs: pick(raw, 'timeToFirstByteMs', 'timeToFirstTokenMs', 'ttftMs') ?? null,
    ok: raw.ok ?? raw.success ?? (raw.error ? false : null),
    error: raw.error ? String(raw.error).slice(0, 400) : null,
  };
}

/** Dig a human-readable reply out of whatever shape the send RPC returned. */
function extractReply(payload) {
  if (payload == null) return null;
  if (typeof payload === 'string') return payload;
  const direct = pick(payload, 'reply', 'text', 'message', 'content', 'output', 'response');
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct)) {
    const parts = direct
      .map((p) => (typeof p === 'string' ? p : p?.text ?? p?.content ?? null))
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  const messages = pick(payload, 'messages', 'items');
  if (Array.isArray(messages) && messages.length) {
    const lastAssistant = [...messages].reverse().find((m) => m?.role === 'assistant') ?? messages.at(-1);
    return extractReply(lastAssistant);
  }
  return null;
}
