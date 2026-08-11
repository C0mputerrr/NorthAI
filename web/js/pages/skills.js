/**
 * Skills -- what North actually has installed.
 *
 * Sourced entirely from OpenClaw's `skills.status`. If that method is not
 * available on this build, the page says so; it never lists a plausible skill
 * North does not have.
 */

import * as api from '../api.js';
import {
  h, clear, panel, pill, stateBlock, isOk, emptyState, skeleton, ago, orDash, sourceLine,
} from '../ui.js';

export const title = 'Skills';
export const subtitle = 'Installed North / OpenClaw skills';

export function mount(root) {
  const slot = h('div', { class: 'stack' }, skeleton(5));
  root.append(slot);

  async function load() {
    let res;
    try {
      res = await api.get('/api/skills');
    } catch (err) {
      clear(slot).append(stateBlock({ state: 'error', reason: err.message }, 'Skills'));
      return;
    }
    if (!isOk(res)) {
      clear(slot).append(stateBlock(res, 'Skills'));
      return;
    }

    const skills = res.data;
    if (!skills.length) {
      clear(slot).append(
        panel(
          'Skills',
          emptyState('No skills installed', 'OpenClaw reported an empty skill list.'),
          { source: sourceLine(res) },
        ),
      );
      return;
    }

    const enabled = skills.filter((s) => s.enabled === true).length;
    const disabled = skills.filter((s) => s.enabled === false).length;

    clear(slot).append(
      h(
        'div',
        { class: 'row' },
        pill('ok', `${enabled} enabled`),
        disabled ? pill('unknown', `${disabled} disabled`) : null,
        pill('unknown', `${skills.length} total`),
      ),
      panel(
        'Installed skills',
        h(
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
                h('th', {}, 'Skill'),
                h('th', {}, 'Description'),
                h('th', {}, 'Status'),
                h('th', {}, 'Last used'),
              ),
            ),
            h(
              'tbody',
              {},
              ...[...skills]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((s) =>
                  h(
                    'tr',
                    {},
                    h(
                      'td',
                      {},
                      h('strong', { style: 'font-weight:560' }, s.name),
                      s.version
                        ? h('span', { class: 'mono', style: 'color:var(--text-3);font-size:10.5px;margin-left:7px' }, s.version)
                        : null,
                      s.source
                        ? h('div', { style: 'font-size:10.5px;color:var(--text-3)' }, s.source)
                        : null,
                    ),
                    h(
                      'td',
                      { style: 'color:var(--text-3);max-width:420px' },
                      s.description ?? h('em', { style: 'opacity:0.6' }, 'no description provided'),
                    ),
                    h(
                      'td',
                      {},
                      s.enabled === true
                        ? pill('ok', 'Enabled')
                        : s.enabled === false
                          ? pill('unknown', 'Disabled')
                          : pill('unknown', 'Unknown'),
                    ),
                    h(
                      'td',
                      { style: 'color:var(--text-3);white-space:nowrap' },
                      s.lastUsed ? ago(s.lastUsed) : h('span', { style: 'opacity:0.6' }, 'not reported'),
                    ),
                  ),
                ),
            ),
          ),
        ),
        { flush: true, source: sourceLine(res, 'skills.status') },
      ),
    );
  }

  load();
  const timer = setInterval(load, 30000);
  return () => clearInterval(timer);
}
