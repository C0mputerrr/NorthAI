/**
 * Activity -- a chronological feed of what North received, thought, ran and returned.
 *
 * The five kinds (request / thinking / tool / result / error) are distinguished
 * three ways at once: an uppercase text label, a distinct glyph shape, and a
 * colour. Shape and label carry the meaning on their own, so the feed stays
 * readable without colour discrimination.
 */

import * as api from '../api.js';
import {
  h, clear, panel, pill, stateBlock, isOk, emptyState, skeleton,
  clock, ms, ago, sourceLine,
} from '../ui.js';

export const title = 'Activity';
export const subtitle = 'Commands, tools, results and failures, newest first';

const KINDS = ['all', 'request', 'thinking', 'tool', 'result', 'error'];
let filter = 'all';

export function mount(root) {
  const feed = h('div', { class: 'feed' }, skeleton(8));
  const countEl = h('span', { class: 'mono', style: 'font-size:11px;color:var(--text-3)' });

  const chips = h(
    'div',
    { class: 'chips' },
    ...KINDS.map((k) =>
      h(
        'button',
        {
          class: 'chip',
          'aria-pressed': String(k === filter),
          onclick: (e) => {
            filter = k;
            for (const b of chips.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
            draw(api.cache.get('activity'));
          },
        },
        k === 'all' ? 'All' : k.toUpperCase(),
      ),
    ),
  );

  root.append(
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row' }, chips, h('div', { class: 'spacer' }), countEl),
      panel(null, feed, { flush: true }),
    ),
  );

  function draw(result) {
    if (!result) return;
    if (!isOk(result)) {
      clear(feed).append(stateBlock(result, 'Activity'));
      countEl.textContent = '';
      return;
    }
    const all = result.data;
    const shown = filter === 'all' ? all : all.filter((e) => e.kind === filter);
    countEl.textContent = `${shown.length} of ${all.length} events`;
    clear(feed).append(
      shown.length
        ? renderFeed(shown)
        : emptyState(
            'Nothing matches',
            filter === 'all'
              ? 'North has not recorded any activity yet.'
              : `No ${filter.toUpperCase()} events in the current window.`,
          ),
    );
  }

  if (api.cache.has('activity')) draw(api.cache.get('activity'));
  else api.get('/api/activity?limit=150').then(draw).catch(() => {});

  return api.on('activity', draw);
}

/** Shared with the Overview page's condensed tail. */
export function renderFeed(events) {
  return h(
    'div',
    { class: 'feed' },
    ...events.map((e) =>
      h(
        'article',
        { class: 'evt', 'data-k': e.kind },
        h('time', { class: 'evt__time', datetime: new Date(e.at).toISOString() }, clock(e.at)),
        h('div', { class: 'evt__rail' }, h('span', { class: 'evt__glyph', 'aria-hidden': 'true' })),
        h(
          'div',
          { class: 'evt__body' },
          h(
            'div',
            {},
            h('span', { class: 'evt__kind' }, e.kind.toUpperCase()),
            h('span', { class: 'evt__msg' }, e.message),
          ),
          metaLine(e),
        ),
        h('span', { class: 'evt__dur' }, durationLabel(e)),
      ),
    ),
  );
}

function metaLine(e) {
  const parts = [];
  if (e.tool) parts.push(e.tool);
  if (e.session) parts.push(`session ${String(e.session).slice(0, 12)}`);
  if (e.channel) parts.push(e.channel);
  if (e.error) parts.push(e.error);
  return parts.length ? h('p', { class: 'evt__meta' }, parts.join('  ·  ')) : null;
}

function durationLabel(e) {
  if (Number.isFinite(e.durationMs)) {
    return e.ttftMs != null ? `${ms(e.durationMs)} · ttft ${ms(e.ttftMs)}` : ms(e.durationMs);
  }
  return '';
}
