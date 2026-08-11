/**
 * Overview -- North's status, this PC's vitals, and the live activity tail.
 *
 * Everything here is fed by the SSE `status` and `activity` events, so the page
 * costs no additional polling. Each block renders its own Result independently:
 * a dead gateway blanks the North column while the PC column keeps updating.
 */

import * as api from '../api.js';
import {
  h, clear, panel, stat, kv, meter, pill, whenOk, stateBlock, isOk,
  bytes, ms, duration, ago, clock, orDash, skeleton, sourceLine, emptyState,
} from '../ui.js';
import { sparkline, SERIES } from '../charts.js';
import { renderFeed } from './activity.js';

export const title = 'Overview';
export const subtitle = 'North, this machine, and what just happened';

/** Short rolling history so the tiles can carry a trend, not just a value. */
const history = { cpu: [], mem: [], probe: [] };
const HISTORY_MAX = 60;

function track(key, value) {
  if (!Number.isFinite(value)) return;
  history[key].push({ at: Date.now(), v: value });
  if (history[key].length > HISTORY_MAX) history[key].shift();
}

export function mount(root) {
  const northSlot = h('div', {});
  const pcSlot = h('div', {});
  const feedSlot = h('div', { class: 'feed' }, skeleton(5));

  root.append(
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'grid grid--2' }, northSlot, pcSlot),
      panel('Recent activity', feedSlot, {
        flush: true,
        actions: h('a', { class: 'btn btn--sm', href: '#/activity' }, 'Full feed'),
      }),
    ),
  );

  const drawStatus = (payload) => {
    clear(northSlot).append(renderNorth(payload?.north));
    clear(pcSlot).append(renderPc(payload?.system));
  };

  const drawActivity = (result) => {
    clear(feedSlot).append(
      isOk(result)
        ? result.data.length
          ? renderFeed(result.data.slice(0, 12))
          : emptyState('Nothing yet', 'North has not recorded any activity.')
        : stateBlock(result, 'Activity'),
    );
  };

  if (api.cache.has('status')) drawStatus(api.cache.get('status'));
  if (api.cache.has('activity')) drawActivity(api.cache.get('activity'));

  const offStatus = api.on('status', drawStatus);
  const offActivity = api.on('activity', drawActivity);
  return () => {
    offStatus();
    offActivity();
  };
}

// ------------------------------------------------------------------- north --

function renderNorth(result) {
  if (!isOk(result)) return panel('North', stateBlock(result, 'North status'));
  const d = result.data;
  track('probe', d.probeLatencyMs);

  const gw = d.gateway;
  const loop = gw.eventLoop;

  const body = h(
    'div',
    { class: 'stack', style: 'gap:15px' },

    h(
      'div',
      { class: 'row', style: 'gap:14px;align-items:flex-end' },
      stat('Status', d.online ? 'Online' : 'Offline', {
        hero: true,
        sub: gw.detail ?? `OpenClaw gateway on port ${gw.port}`,
      }),
      h('div', { class: 'spacer' }),
      pill(d.online ? 'online' : 'offline', d.online ? 'Gateway up' : 'Gateway down'),
    ),

    // Latency trend: the single number this user most wants to watch.
    d.probeLatencyMs != null
      ? h(
          'div',
          { class: 'stack', style: 'gap:3px' },
          h(
            'div',
            { class: 'row', style: 'justify-content:space-between' },
            h('span', { class: 'stat__k' }, 'Gateway probe latency'),
            h('span', { class: 'mono', style: 'font-size:12px' }, ms(d.probeLatencyMs)),
          ),
          sparkline(history.probe, { color: SERIES[1] }) ?? h('div', { style: 'height:30px' }),
        )
      : null,

    kv([
      ['Model', modelLabel(d)],
      ['Session', sessionLabel(d)],
      ['Context', contextLabel(d)],
      ['Uptime', d.uptimeMs != null ? duration(d.uptimeMs) : dim('not reported by gateway')],
      ['Last activity', d.session?.updatedAt ? ago(d.session.updatedAt) : dim('unknown')],
      ['Gateway version', orDash(gw.version)],
      loop
        ? [
            'Event loop',
            h(
              'span',
              { style: loop.degraded ? 'color:var(--st-warn)' : '' },
              `${loop.degraded ? 'degraded' : 'healthy'}${
                Number.isFinite(loop.delay) ? ` · ${ms(loop.delay)} delay` : ''
              }`,
            ),
          ]
        : null,
    ]),
  );

  return panel('North', body, { source: sourceLine(result) });
}

const dim = (t) => h('span', { style: 'color:var(--text-3)' }, t);

function modelLabel(d) {
  if (d.modelState !== 'ok') return dim(reasonShort(d.modelReason, 'unavailable'));
  const m = d.model;
  if (!m) return dim('none reported');
  return m.id ?? m.name ?? m.model ?? JSON.stringify(m).slice(0, 40);
}

function sessionLabel(d) {
  if (d.sessionsState !== 'ok') return dim(reasonShort(d.sessionsReason, 'unavailable'));
  const s = d.session;
  if (!s) return dim('no active session');
  const name = s.title ?? s.id ?? 'session';
  return `${name}${d.sessionCount > 1 ? ` (+${d.sessionCount - 1} more)` : ''}`;
}

function contextLabel(d) {
  if (d.usageState !== 'ok') return dim(reasonShort(d.usageReason, 'not reported'));
  const u = d.usage;
  if (!u) return dim('not reported');
  if (u.contextTokens != null && u.contextWindow) {
    const p = Math.round((u.contextTokens / u.contextWindow) * 100);
    return `${u.contextTokens.toLocaleString()} / ${u.contextWindow.toLocaleString()} (${p}%)`;
  }
  if (u.totalTokens != null) return `${u.totalTokens.toLocaleString()} tokens`;
  return dim('not reported');
}

/**
 * Condense an adapter reason to fit a one-line cell.
 *
 * The same root cause fills several rows at once (no CLI means no model, no
 * session and no context), so a truncated sentence repeated three times is
 * noise. Common causes get a terse label; the full text stays available on
 * hover and is shown in full by the panel-level state blocks.
 */
function reasonShort(reason, fallback) {
  if (!reason) return fallback;
  const terse =
    /command was not found/i.test(reason) ? 'openclaw CLI not found'
    : /not reachable|Nothing is listening|ECONNREFUSED/i.test(reason) ? 'gateway offline'
    : /timed out|timeout/i.test(reason) ? 'timed out'
    : /does not expose/i.test(reason) ? 'not supported by this build'
    : reason.length > 34 ? `${reason.slice(0, 32)}…`
    : reason;
  return h('span', { title: reason }, terse);
}

// ---------------------------------------------------------------------- pc --

function renderPc(result) {
  if (!isOk(result)) return panel('This PC', stateBlock(result, 'System telemetry'));

  const sys = result.data.system;
  const apps = result.data.apps;
  if (!sys) return panel('This PC', stateBlock({ state: 'unknown', reason: 'No system payload.' }));

  track('cpu', sys.cpuPercent);
  const mem = sys.memory ?? {};
  if (mem.totalBytes) track('mem', (mem.usedBytes / mem.totalBytes) * 100);

  const active = apps?.activeWindow;

  const body = h(
    'div',
    { class: 'stack', style: 'gap:14px' },

    h(
      'div',
      { class: 'row', style: 'gap:18px;align-items:flex-end' },
      stat('CPU', Number.isFinite(sys.cpuPercent) ? `${Math.round(sys.cpuPercent)}` : '--', {
        hero: true,
        unit: '%',
        sub: `${sys.cpuCount ?? '?'} logical cores`,
      }),
      h('div', { class: 'spacer' }),
      h('div', { style: 'width:120px' }, sparkline(history.cpu, { color: SERIES[1] })),
    ),

    meter('Memory', mem.usedBytes, mem.totalBytes),

    ...(sys.disks ?? []).slice(0, 3).map((d) =>
      meter(`Disk ${d.drive}${d.label ? ` (${d.label})` : ''}`, d.totalBytes - d.freeBytes, d.totalBytes, {
        foot: `${bytes(d.freeBytes)} free of ${bytes(d.totalBytes)}`,
      }),
    ),

    sys.battery
      ? meter('Battery', sys.battery.percent, 100, {
          format: (v) => `${Math.round(v)}%`,
          foot: `${sys.battery.charging ? 'Charging' : 'On battery'}${
            sys.battery.runtimeMinutes ? ` · ~${sys.battery.runtimeMinutes}m remaining` : ''
          }`,
        })
      : null,

    kv([
      ['Host', orDash(sys.host)],
      ['Network', sys.network?.online ? `Connected · ${adapters(sys.network)}` : dim('No active connection')],
      [
        'Active window',
        active
          ? h('span', {}, h('strong', { style: 'font-weight:560' }, active.name), ' — ', truncate(active.title, 40))
          : dim('none detected'),
      ],
      ['Open windows', apps ? String(apps.windowCount ?? 0) : '--'],
      ['PC uptime', sys.uptimeMs != null ? duration(sys.uptimeMs) : '--'],
    ]),
  );

  return panel('This PC', body, {
    source: sourceLine(result),
    actions: h('a', { class: 'btn btn--sm', href: '#/system' }, 'Apps'),
  });
}

function adapters(net) {
  const names = (net.adapters ?? []).map((a) => a.name).filter(Boolean);
  return names.length ? names.join(', ') : 'active';
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}...` : t;
}
