/**
 * Security -- what North is currently permitted to do.
 *
 * Derived from the tools the gateway reports as *effective*, not from what
 * happens to be installed. No credential of any kind is displayed here: the
 * server's config reader never loads secret fields into memory, so there is
 * nothing to render even by mistake.
 */

import * as api from '../api.js';
import {
  h, clear, fill, panel, pill, stateBlock, isOk, emptyState, skeleton, note, ago, orDash,
} from '../ui.js';

export const title = 'Security';
export const subtitle = 'Capabilities, permissions, and the dashboard’s own posture';

const GRANT_LABEL = {
  granted: 'Granted',
  'present-disabled': 'Installed, disabled',
  'not-granted': 'Not granted',
  unknown: 'Unknown',
};

export function mount(root) {
  const slot = h('div', { class: 'stack' }, skeleton(6));
  root.append(slot);

  async function load() {
    let res;
    try {
      res = await api.get('/api/security');
    } catch (err) {
      fill(slot, stateBlock({ state: 'error', reason: err.message }, 'Security'));
      return;
    }
    if (!isOk(res)) {
      fill(slot, stateBlock(res, 'Security'));
      return;
    }

    const d = res.data;
    const p = d.posture;

    fill(slot, 
      h(
        'div',
        { class: 'note' },
        h(
          'span',
          {},
          h('strong', {}, 'No secrets are shown or logged here. '),
          'The dashboard reads only non-secret fields from openclaw.json — port, bind mode, auth mode — and never tokens, API keys, cookies or session files.',
        ),
      ),

      !d.determinable
        ? note(
            'OpenClaw did not report an effective tool list, so capabilities below are shown as Unknown rather than guessed.',
            { warn: true },
          )
        : null,

      panel(
        'Capabilities',
        h('div', { class: 'grid grid--2' }, ...d.capabilities.map(capCard)),
      ),

      h(
        'div',
        { class: 'grid grid--2' },

        panel(
          'Dashboard posture',
          h(
            'div',
            { class: 'stack', style: 'gap:0' },
            row('Bound to', `${p.dashboardHost}`, p.dashboardLoopbackOnly ? 'ok' : 'error'),
            row(
              'Reachable from network',
              p.dashboardLoopbackOnly ? 'No — loopback only' : 'Yes — check your config',
              p.dashboardLoopbackOnly ? 'ok' : 'error',
            ),
            row('Console writes', p.consoleEnabled ? 'Enabled' : 'Disabled', p.consoleEnabled ? 'warn' : 'ok'),
            row(
              'Process actions',
              p.processActionsEnabled ? 'Enabled' : 'Disabled',
              p.processActionsEnabled ? 'warn' : 'ok',
            ),
          ),
        ),

        panel(
          'OpenClaw gateway posture',
          h(
            'div',
            { class: 'stack', style: 'gap:0' },
            // An unreadable auth mode is not a passing grade -- show it as
            // unknown rather than dressing it in the green "ok" pill.
            row(
              'Auth mode',
              p.gatewayAuthMode ?? 'unknown',
              !p.gatewayAuthMode || p.gatewayAuthMode === 'unknown'
                ? 'unknown'
                : p.gatewayAuthMode === 'none'
                  ? 'error'
                  : 'ok',
            ),
            row('Bind mode', p.gatewayBind ?? 'unknown', p.gatewayBind ? null : 'unknown'),
            row('Config file', p.configFound ? 'Found' : 'Not found', p.configFound ? 'ok' : 'unknown'),
            p.configError ? row('Config error', p.configError, 'error') : null,
          ),
        ),
      ),

      d.recentApprovals?.length
        ? panel(
            'Recent approvals',
            h(
              'div',
              { class: 'table__wrap' },
              h(
                'table',
                { class: 'table' },
                h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'What'), h('th', {}, 'Decision'))),
                h(
                  'tbody',
                  {},
                  ...d.recentApprovals.slice(0, 15).map((a) =>
                    h(
                      'tr',
                      {},
                      h('td', { class: 'mono', style: 'font-size:11px;color:var(--text-3)' },
                        a.at || a.createdAt ? ago(Date.parse(a.at ?? a.createdAt)) : '--'),
                      h('td', {}, String(a.summary ?? a.command ?? a.tool ?? a.request ?? '—').slice(0, 120)),
                      h('td', {}, pill(decisionState(a), String(a.decision ?? a.status ?? 'unknown'))),
                    ),
                  ),
                ),
              ),
            ),
            { flush: true },
          )
        : null,
    );
  }

  load();
  const timer = setInterval(load, 30000);
  return () => clearInterval(timer);
}

function decisionState(a) {
  const w = String(a.decision ?? a.status ?? '').toLowerCase();
  if (/approve|allow|grant/.test(w)) return 'ok';
  if (/deny|reject|block/.test(w)) return 'error';
  return 'unknown';
}

function capCard(c) {
  return h(
    'article',
    { class: 'cap' },
    h(
      'div',
      { class: 'cap__top' },
      h(
        'div',
        {},
        h('div', { class: 'cap__name' }, c.label),
        h('div', { class: 'risk', 'data-r': c.risk }, `${c.risk} risk`),
      ),
      pill(c.granted, GRANT_LABEL[c.granted] ?? c.granted),
    ),
    h('p', { class: 'cap__detail' }, c.note ?? c.detail),
    c.tools?.length
      ? h(
          'div',
          { class: 'cap__tools' },
          ...c.tools.map((t) => h('span', { class: 'tag' }, t)),
          c.toolCount > c.tools.length
            ? h('span', { class: 'tag' }, `+${c.toolCount - c.tools.length} more`)
            : null,
        )
      : null,
  );
}

function row(k, v, state) {
  return h(
    'div',
    { class: 'kv__row' },
    h('span', { class: 'kv__k' }, k),
    h(
      'span',
      { class: 'kv__v' },
      state ? pill(state, String(v)) : String(v),
    ),
  );
}
