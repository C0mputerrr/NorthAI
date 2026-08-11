/**
 * Integrations -- what North is actually connected to.
 *
 * Each card states its verdict and the evidence behind it. Where OpenClaw
 * reports nothing, the card says UNKNOWN or NOT CONFIGURED rather than
 * claiming a disconnection we did not observe.
 */

import * as api from '../api.js';
import { h, clear, fill, panel, pill, stateBlock, isOk, skeleton, note, emptyState } from '../ui.js';

export const title = 'Integrations';
export const subtitle = 'Services North can reach, and the evidence for each';

const LABELS = {
  connected: 'Connected',
  partial: 'Partial',
  not_connected: 'Not connected',
  error: 'Error',
  unknown: 'Unknown',
  not_configured: 'Not configured',
};

const ORDER = ['connected', 'partial', 'error', 'unknown', 'not_configured', 'not_connected'];

export function mount(root) {
  const slot = h('div', { class: 'stack' }, skeleton(6));
  root.append(slot);

  async function load() {
    let res;
    try {
      res = await api.get('/api/integrations');
    } catch (err) {
      fill(slot, stateBlock({ state: 'error', reason: err.message }, 'Integrations'));
      return;
    }
    if (!isOk(res)) {
      fill(slot, stateBlock(res, 'Integrations'));
      return;
    }

    const { integrations, blind, sources } = res.data;
    const counts = integrations.reduce((acc, i) => ((acc[i.state] = (acc[i.state] ?? 0) + 1), acc), {});
    const sorted = [...integrations].sort(
      (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.label.localeCompare(b.label),
    );

    fill(slot, 
      blind
        ? note(
            'The OpenClaw gateway is unreachable, so integration status cannot be determined. Nothing below is being reported as disconnected — only as unknown.',
            { warn: true },
          )
        : null,

      h(
        'div',
        { class: 'row' },
        ...ORDER.filter((s) => counts[s]).map((s) => pill(s, `${counts[s]} ${LABELS[s].toLowerCase()}`)),
      ),

      h('div', { class: 'grid grid--3' }, ...sorted.map(card)),

      panel(
        'Where this comes from',
        h(
          'div',
          { class: 'stack', style: 'gap:7px' },
          ...Object.entries(sources).map(([name, r]) =>
            h(
              'div',
              { class: 'row', style: 'justify-content:space-between' },
              h('span', { class: 'mono', style: 'font-size:11.5px;color:var(--text-2)' }, name),
              h(
                'span',
                { style: 'font-size:11.5px;color:var(--text-3);text-align:right' },
                r.state === 'ok' ? 'reporting' : r.reason ?? r.state,
              ),
            ),
          ),
        ),
      ),
    );
  }

  load();
  const timer = setInterval(load, 30000);
  return () => clearInterval(timer);
}

function card(i) {
  return h(
    'article',
    { class: 'integration' },
    h(
      'div',
      { class: 'integration__top' },
      h(
        'div',
        {},
        h('div', { class: 'integration__name' }, i.label),
        h('div', { class: 'integration__kind' }, i.kind),
      ),
      pill(i.state, LABELS[i.state] ?? i.state),
    ),
    i.evidence?.length
      ? h('ul', { class: 'integration__ev', role: 'list' }, ...i.evidence.map((e) => h('li', {}, e)))
      : null,
  );
}
