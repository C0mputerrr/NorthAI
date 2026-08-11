/**
 * Performance -- where North's time actually goes.
 *
 * Three measurements are kept apart on purpose, because conflating them hides
 * the bottleneck:
 *
 *   model      what the gateway measured for the model call itself
 *   tool       what tool execution cost
 *   transport  what this dashboard spent talking to the OpenClaw CLI
 *
 * Transport is dashboard overhead, not North's speed. It is charted separately
 * and labelled as such so a slow panel is never mistaken for a slow assistant.
 *
 * Each chart has one y-axis. Where two measures share a unit and scale (total
 * duration vs time-to-first-byte, both ms) they share a chart; otherwise they
 * get their own.
 */

import * as api from '../api.js';
import {
  h, clear, panel, stat, stateBlock, isOk, emptyState, ms, clock,
  skeleton, note, orDash,
} from '../ui.js';
import { lineChart, legend, barList, SERIES } from '../charts.js';

export const title = 'Performance';
export const subtitle = 'Latency, token throughput, and the slowest recent work';

export function mount(root) {
  const slot = h('div', { class: 'stack' }, skeleton(6));
  root.append(slot);

  const draw = (result) => {
    if (!isOk(result)) {
      clear(slot).append(stateBlock(result, 'Performance data'));
      return;
    }
    clear(slot).append(render(result.data));
  };

  if (api.cache.has('metrics')) draw(api.cache.get('metrics'));
  else api.get('/api/performance').then(draw).catch((e) => draw({ state: 'error', reason: e.message }));

  return api.on('metrics', draw);
}

function render(d) {
  const s = d.summary;
  const hasModel = Boolean(s.model);

  return h(
    'div',
    { class: 'stack' },

    !hasModel
      ? note(
          'No model-call timings have been observed yet. These come from OpenClaw’s structured logs (durationMs / timeToFirstByteMs) and appear once North handles a request while this dashboard is running.',
        )
      : null,

    // --- headline numbers ------------------------------------------------
    panel(
      'Latency summary',
      h(
        'div',
        { class: 'grid grid--4' },
        stat('Avg model call', s.model ? ms(s.model.avg) : '--', {
          hero: true,
          sub: s.model ? `${s.model.count} calls measured` : 'no samples',
        }),
        stat('Median (p50)', s.model ? ms(s.model.p50) : '--'),
        stat('p95', s.model ? ms(s.model.p95) : '--', { sub: 'slow tail' }),
        stat('Time to first byte', s.modelTtft ? ms(s.modelTtft.avg) : '--', {
          sub: s.modelTtft ? `avg of ${s.modelTtft.count}` : 'not reported',
        }),
        stat('Avg tool call', s.tool ? ms(s.tool.avg) : '--', {
          sub: s.tool ? `${s.tool.count} executions` : 'no samples',
        }),
        stat('Tools per request', d.counts.toolsPerRequest != null ? d.counts.toolsPerRequest.toFixed(1) : '--', {
          sub: 'console requests only',
        }),
        stat('Last 15 min', s.recentModel ? ms(s.recentModel.avg) : '--', {
          sub: s.recentModel ? `${s.recentModel.count} calls` : 'idle',
        }),
        stat('Dashboard overhead', s.transport ? ms(s.transport.avg) : '--', {
          sub: 'CLI round trip',
        }),
      ),
    ),

    // --- model latency over time -----------------------------------------
    panel(
      'Model latency over time',
      h(
        'div',
        {},
        legend([
          { name: 'Total duration', color: SERIES[1] },
          { name: 'Time to first byte', color: SERIES[2] },
        ]),
        lineChart({
          series: [
            { name: 'Total duration', color: SERIES[1], points: pts(d.series.model, 'ms') },
            { name: 'Time to first byte', color: SERIES[2], points: pts(d.series.model, 'ttftMs') },
          ],
          height: 190,
          emptyMessage:
            'OpenClaw reports these in its logs once North completes a model call.',
        }),
        tableView(d.series.model, ['Time', 'Duration', 'TTFT'], (p) => [
          clock(p.at),
          ms(p.ms),
          p.ttftMs != null ? ms(p.ttftMs) : '--',
        ]),
      ),
      { source: 'openclaw logs · durationMs, timeToFirstByteMs' },
    ),

    h(
      'div',
      { class: 'grid grid--2' },

      // --- tool latency -------------------------------------------------
      panel(
        'Tool execution latency',
        h(
          'div',
          {},
          lineChart({
            series: [{ name: 'Tool execution', color: SERIES[3], points: pts(d.series.tool, 'ms') }],
            height: 150,
            emptyMessage: 'No tool executions have been timed yet.',
          }),
          tableView(d.series.tool, ['Time', 'Tool', 'Duration'], (p) => [
            clock(p.at),
            p.name ?? '--',
            ms(p.ms),
          ]),
        ),
        { source: 'openclaw logs · tool spans' },
      ),

      // --- transport ------------------------------------------------------
      panel(
        'Dashboard → gateway overhead',
        h(
          'div',
          {},
          lineChart({
            series: [{ name: 'CLI round trip', color: SERIES[1], points: pts(d.series.transport, 'ms') }],
            height: 150,
            emptyMessage: 'No calls made yet.',
          }),
          h(
            'p',
            { style: 'font-size:11px;color:var(--text-3);margin-top:8px;line-height:1.5' },
            'This is what the dashboard spends invoking the OpenClaw CLI, not North’s own speed. ' +
              'A high value here slows the panels, not your assistant.',
          ),
        ),
        { source: 'measured locally' },
      ),
    ),

    // --- slowest ----------------------------------------------------------
    panel(
      'Slowest recent work',
      d.slowest?.length
        ? barList(
            d.slowest.map((r) => ({ label: `${r.kind === 'console' ? '› ' : ''}${r.label}`, value: r.ms })),
            { format: ms },
          )
        : emptyState('Nothing measured yet', 'The slowest requests appear here once there is timing data.'),
      { source: 'ranked by total duration' },
    ),

    // --- payload sizes ----------------------------------------------------
    d.payload?.requestBytes || d.payload?.responseBytes
      ? panel(
          'Payload size',
          h(
            'div',
            { class: 'grid grid--3' },
            stat('Avg request', d.payload.requestBytes ? bytesish(d.payload.requestBytes.avg) : '--', {
              sub: 'context sent to the model',
            }),
            stat('Avg response', d.payload.responseBytes ? bytesish(d.payload.responseBytes.avg) : '--'),
            stat('Largest request', d.payload.requestBytes ? bytesish(d.payload.requestBytes.max) : '--', {
              sub: 'biggest context seen',
            }),
          ),
          { source: 'openclaw logs · requestPayloadBytes, responseStreamBytes' },
        )
      : null,
  );
}

function pts(series, key) {
  return (series ?? []).map((p) => ({ at: p.at, v: p[key] })).filter((p) => Number.isFinite(p.v));
}

function bytesish(n) {
  if (!Number.isFinite(n)) return '--';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

/**
 * Every chart ships an equivalent table. Colour and position are not the only
 * route to the numbers.
 */
function tableView(rows, headers, mapRow) {
  if (!rows?.length) return null;
  const recent = [...rows].slice(-40).reverse();
  const details = h('details', { style: 'margin-top:10px' });
  details.append(
    h('summary', { style: 'font-size:11px;color:var(--text-3);cursor:pointer' }, `Table view (${recent.length} rows)`),
    h(
      'div',
      { class: 'table__wrap', style: 'max-height:260px;overflow-y:auto;margin-top:7px' },
      h(
        'table',
        { class: 'table' },
        h('thead', {}, h('tr', {}, ...headers.map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
        h(
          'tbody',
          {},
          ...recent.map((p) =>
            h('tr', {}, ...mapRow(p).map((c, i) => h('td', { class: i ? 'num mono' : 'mono' }, c))),
          ),
        ),
      ),
    ),
  );
  return details;
}
