/**
 * System -- what is open on this PC, and safe actions against it.
 *
 * Only windowed, user-facing applications are listed. OS integrity and
 * security processes are filtered out in the PowerShell probe itself, so they
 * never reach the browser and cannot be acted on from here.
 */

import * as api from '../api.js';
import {
  h, clear, fill, panel, stat, kv, meter, pill, stateBlock, isOk, emptyState,
  bytes, ago, duration, orDash, skeleton, sourceLine, note,
} from '../ui.js';
import { barList } from '../charts.js';

export const title = 'System';
export const subtitle = 'Open applications, processes, and the active window';

export function mount(root) {
  const slot = h('div', { class: 'stack' }, skeleton(6));
  root.append(slot);

  let timer = null;

  async function load() {
    let payload;
    try {
      payload = await api.get('/api/system');
    } catch (err) {
      fill(slot, stateBlock({ state: 'error', reason: err.message }, 'System'));
      return;
    }
    const { system, apps } = payload;

    if (!isOk(apps)) {
      fill(slot, 
        panel('Applications', stateBlock(apps, 'Application list')),
        isOk(system) ? vitals(system) : null,
      );
      return;
    }

    const a = apps.data;
    fill(slot, 
      isOk(system) ? vitals(system) : panel('Vitals', stateBlock(system, 'System vitals')),
      activeWindow(a),
      h(
        'div',
        { class: 'grid grid--2' },
        openApps(a, load),
        panel(
          'Heaviest processes',
          a.topMemory?.length
            ? barList(
                a.topMemory.map((p) => ({ label: `${p.name}  (${p.pid})`, value: p.memoryBytes })),
                { format: bytes },
              )
            : emptyState('No data'),
          { source: 'Working set, protected OS processes excluded' },
        ),
      ),
    );
  }

  load();
  timer = setInterval(load, 6000);
  return () => clearInterval(timer);
}

function vitals(result) {
  const s = result.data;
  const mem = s.memory ?? {};
  return panel(
    'Machine',
    h(
      'div',
      { class: 'grid grid--3' },
      stat('CPU', Number.isFinite(s.cpuPercent) ? `${Math.round(s.cpuPercent)}` : '--', {
        unit: '%',
        sub: `${s.cpuCount ?? '?'} cores`,
      }),
      stat('Memory', mem.totalBytes ? `${Math.round((mem.usedBytes / mem.totalBytes) * 100)}` : '--', {
        unit: '%',
        sub: `${bytes(mem.usedBytes)} of ${bytes(mem.totalBytes)}`,
      }),
      stat('Uptime', s.uptimeMs != null ? duration(s.uptimeMs) : '--', { sub: s.host ?? '' }),
    ),
    { source: sourceLine(result) },
  );
}

function activeWindow(a) {
  const w = a.activeWindow;
  return panel(
    'Active window',
    w
      ? kv([
          ['Application', w.name],
          ['Title', w.title],
          ['PID', String(w.pid)],
          ['Memory', bytes(w.memoryBytes)],
          ['Started', w.startedAt ? ago(Date.parse(w.startedAt)) : '--'],
        ])
      : emptyState('Nothing focused', 'No foreground window was reported.'),
  );
}

function openApps(a, reload) {
  const rows = a.windowed ?? [];
  const canAct = window.__northMeta?.capabilities?.processActions;

  const body = h(
    'div',
    { class: 'stack', style: 'gap:0' },
    !canAct
      ? h(
          'div',
          { style: 'padding:12px 15px 0' },
          note(
            'Open, Focus and Close are disabled. Set "allowProcessActions": true in north.config.json to enable them.',
          ),
        )
      : null,
    rows.length
      ? h(
          'div',
          { class: 'table__wrap' },
          h(
            'table',
            { class: 'table' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', {}, 'Application'),
                h('th', {}, 'Window'),
                h('th', { class: 'num' }, 'Memory'),
                h('th', {}, ''),
              ),
            ),
            h(
              'tbody',
              {},
              ...rows.map((p) =>
                h(
                  'tr',
                  {},
                  h(
                    'td',
                    {},
                    h('strong', { style: 'font-weight:560' }, p.name),
                    p.isActive ? h('span', { style: 'margin-left:7px' }, pill('ok', 'active')) : null,
                  ),
                  h(
                    'td',
                    { style: 'color:var(--text-3);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' , title: p.title },
                    p.title,
                  ),
                  h('td', { class: 'num mono', style: 'font-size:11.5px' }, bytes(p.memoryBytes)),
                  h(
                    'td',
                    { style: 'text-align:right;white-space:nowrap' },
                    canAct
                      ? h(
                          'span',
                          { class: 'row', style: 'gap:5px;justify-content:flex-end;flex-wrap:nowrap' },
                          actionBtn('Focus', 'focus', { pid: p.pid }, reload),
                          actionBtn('Close', 'close', { pid: p.pid }, reload, true),
                        )
                      : null,
                  ),
                ),
              ),
            ),
          ),
        )
      : emptyState('No windowed applications', 'Nothing with a visible window is running.'),
  );

  return panel(`Open applications (${rows.length})`, body, {
    flush: true,
    actions: canAct ? openLauncher(reload) : null,
  });
}

function openLauncher(reload) {
  const input = h('input', {
    placeholder: 'app or URL',
    'aria-label': 'Application to open',
    style:
      'padding:4px 8px;border-radius:6px;border:1px solid var(--border-hi);background:var(--surface-in);font-size:11.5px;width:130px',
  });
  const go = h(
    'button',
    {
      class: 'btn btn--sm',
      onclick: async () => {
        const target = input.value.trim();
        if (!target) return;
        go.disabled = true;
        const res = await api.post('/api/system/action', { op: 'open', target });
        go.disabled = false;
        if (!isOk(res)) alert(res.reason ?? 'Could not open that.');
        else {
          input.value = '';
          setTimeout(reload, 700);
        }
      },
    },
    'Open',
  );
  return h('span', { class: 'row', style: 'gap:5px;flex-wrap:nowrap' }, input, go);
}

function actionBtn(label, op, params, reload, danger) {
  return h(
    'button',
    {
      class: `btn btn--sm${danger ? ' btn--danger' : ''}`,
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const res = await api.post('/api/system/action', { op, ...params });
        btn.disabled = false;
        if (!isOk(res)) alert(res.reason ?? `Could not ${op}.`);
        else setTimeout(reload, 700);
      },
    },
    label,
  );
}
