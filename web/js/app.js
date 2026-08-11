/**
 * Shell: hash routing, page lifecycle, and the always-on status strip.
 *
 * Pages are modules exporting `{ title, subtitle, mount(el) }`, where `mount`
 * returns an optional cleanup function. Only one page is mounted at a time and
 * its subscriptions are torn down on navigation, so a long-lived tab does not
 * accumulate listeners.
 */

import * as api from './api.js';
import { h, clear, ms, duration, ago, orDash } from './ui.js';

import * as overview from './pages/overview.js';
import * as activity from './pages/activity.js';
import * as console_ from './pages/console.js';
import * as system from './pages/system.js';
import * as performance from './pages/performance.js';
import * as integrations from './pages/integrations.js';
import * as skills from './pages/skills.js';
import * as security from './pages/security.js';

const PAGES = {
  overview,
  activity,
  console: console_,
  system,
  performance,
  integrations,
  skills,
  security,
};

const view = document.getElementById('view');
const titleEl = document.getElementById('page-title');
const subEl = document.getElementById('page-sub');
const statsEl = document.getElementById('topbar-stats');
const pulseEl = document.getElementById('rail-pulse');
const metaEl = document.getElementById('rail-meta');

let cleanup = null;
let current = null;

// ------------------------------------------------------------------ router --

function routeName() {
  const raw = (location.hash || '#/overview').replace(/^#\/?/, '').split('?')[0];
  return PAGES[raw] ? raw : 'overview';
}

async function render() {
  const name = routeName();
  if (name === current) return;
  current = name;

  if (cleanup) {
    try {
      cleanup();
    } catch (err) {
      console.error('[cleanup]', err);
    }
    cleanup = null;
  }

  const page = PAGES[name];
  titleEl.textContent = page.title ?? name;
  subEl.textContent = page.subtitle ?? '';

  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }

  clear(view);
  try {
    cleanup = (await page.mount(view)) ?? null;
  } catch (err) {
    console.error(`[page:${name}]`, err);
    clear(view).append(
      h(
        'div',
        { class: 'state', 'data-s': 'error' },
        h('div', { class: 'state__icon' }, '!'),
        h('p', { class: 'state__title' }, 'This page failed to render'),
        h('p', { class: 'state__msg' }, err.message),
      ),
    );
  }
  view.scrollTop = 0;
}

window.addEventListener('hashchange', render);

// -------------------------------------------------------------- status strip --

/** The strip is always visible, so it shows only facts that are always relevant. */
function renderStrip(payload) {
  const north = payload?.north;
  const sys = payload?.system;
  const d = north?.state === 'ok' ? north.data : null;
  const s = sys?.state === 'ok' ? sys.data?.system : null;

  const items = [];
  const push = (k, v) =>
    items.push(h('div', { class: 'tstat' }, h('span', { class: 'tstat__k' }, k), h('span', { class: 'tstat__v' }, v)));

  if (d) {
    push(
      'North',
      h(
        'span',
        { style: `color:${d.online ? 'var(--st-ok)' : 'var(--st-err)'}` },
        d.online ? 'Online' : 'Offline',
      ),
    );
    push('Probe', d.probeLatencyMs != null ? ms(d.probeLatencyMs) : '--');
    push('Uptime', d.uptimeMs != null ? duration(d.uptimeMs) : '--');
    push('Sessions', d.sessionsState === 'ok' ? String(d.sessionCount) : '--');
  }
  if (s) {
    push('CPU', Number.isFinite(s.cpuPercent) ? `${Math.round(s.cpuPercent)}%` : '--');
    const mem = s.memory;
    push(
      'RAM',
      mem?.totalBytes ? `${Math.round((mem.usedBytes / mem.totalBytes) * 100)}%` : '--',
    );
  }

  clear(statsEl).append(...items);
}

api.on('status', renderStrip);

api.on('connection', (state) => {
  pulseEl.dataset.state = state;
  pulseEl.querySelector('.pulse__label').textContent =
    state === 'live' ? 'live' : state === 'down' ? 'disconnected' : 'connecting';
});

// ---------------------------------------------------------------- bootstrap --

async function boot() {
  api.connect();
  render();

  try {
    const meta = await api.get('/api/meta');
    const bits = [
      `gateway :${meta.gateway.port}`,
      meta.gateway.binaryFound ? 'cli ok' : 'cli missing',
      meta.capabilities.windows ? 'win probe' : `no win probe`,
    ];
    metaEl.textContent = bits.join('  ·  ');
    metaEl.title = [
      `OpenClaw binary: ${meta.gateway.binary ?? 'not found'}`,
      `OpenClaw home: ${meta.gateway.openclawHome}`,
      `Config found: ${meta.gateway.configFound ? 'yes' : 'no'}`,
      meta.capabilities.windowsReason ?? '',
    ]
      .filter(Boolean)
      .join('\n');
    window.__northMeta = meta;
  } catch (err) {
    metaEl.textContent = 'server unreachable';
  }
}

boot();
