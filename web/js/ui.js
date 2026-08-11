/**
 * Rendering primitives.
 *
 * `stateBlock` is the load-bearing one: any panel whose Result is not `ok`
 * renders it instead of data. That is what makes "never fabricate" structural
 * rather than a thing to remember -- a page cannot show a number it does not
 * have, because the only path to markup for a non-ok Result is an explicit
 * explanation of why the data is missing.
 */

/** Create an element. Children may be nodes, strings, or nullish (skipped). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    f.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return f;
};

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Replace a node's contents, skipping nullish children.
 *
 * Always prefer this over `clear(el).append(...)`: the DOM's own append
 * stringifies `null` into a literal "null" text node, so a conditional child
 * that evaluates to null renders as visible garbage.
 */
export function fill(node, ...children) {
  clear(node);
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ------------------------------------------------------------- formatting --

const NBSP = ' '; // thin space, keeps "12 ms" from splitting awkwardly

export function bytes(n) {
  if (!Number.isFinite(n)) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${NBSP}${units[i]}`;
}

export function ms(n) {
  if (!Number.isFinite(n)) return '--';
  if (n === 0) return `0${NBSP}ms`; // axis origins should read "0 ms", not "0.00 ms"
  if (n < 1) return `${n.toFixed(2)}${NBSP}ms`;
  if (n < 1000) return `${Math.round(n)}${NBSP}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)}${NBSP}s`;
  return duration(n);
}

export function duration(msValue) {
  if (!Number.isFinite(msValue)) return '--';
  const s = Math.floor(msValue / 1000);
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d) return `${d}d ${hh}h`;
  if (hh) return `${hh}h ${mm}m`;
  if (mm) return `${mm}m ${ss}s`;
  return `${ss}s`;
}

export function ago(at) {
  if (!Number.isFinite(at)) return 'unknown';
  const diff = Date.now() - at;
  if (diff < 0) return 'just now';
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export const clock = (at) =>
  Number.isFinite(at)
    ? new Date(at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--';

export function pct(n, digits = 0) {
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '--';
}

/** Truthfully render a possibly-absent value. Never invents a placeholder number. */
export const orDash = (v, fmt = (x) => x) => (v == null || v === '' ? '--' : fmt(v));

// ----------------------------------------------------------- state blocks --

const STATE_COPY = {
  unavailable: { icon: '–', title: 'Unavailable' },
  not_configured: { icon: '○', title: 'Not configured' },
  unknown: { icon: '?', title: 'Unknown' },
  error: { icon: '!', title: 'Error' },
  loading: { icon: '·', title: 'Loading' },
};

/**
 * Render a non-ok Result as an explicit, readable state.
 * @param {{state: string, reason?: string, source?: string}} result
 */
export function stateBlock(result, contextLabel) {
  const meta = STATE_COPY[result?.state] ?? STATE_COPY.unknown;
  return h(
    'div',
    { class: 'state', 'data-s': result?.state ?? 'unknown' },
    h('div', { class: 'state__icon', 'aria-hidden': 'true' }, meta.icon),
    h('p', { class: 'state__title' }, contextLabel ? `${contextLabel}: ${meta.title}` : meta.title),
    result?.reason ? h('p', { class: 'state__msg' }, result.reason) : null,
  );
}

export const isOk = (r) => Boolean(r) && r.state === 'ok';

/** Render `fn(result.data)` when ok, else the explanatory state block. */
export function whenOk(result, fn, label) {
  if (!result) return skeleton();
  return isOk(result) ? fn(result.data) : stateBlock(result, label);
}

export function skeleton(rows = 3) {
  return h(
    'div',
    { class: 'stack', style: 'padding:15px;gap:9px' },
    ...Array.from({ length: rows }, (_, i) =>
      h('div', { class: 'skel', style: `width:${[92, 68, 80, 55][i % 4]}%` }),
    ),
  );
}

// -------------------------------------------------------------- components --

export function panel(title, body, { actions, source: src, flush } = {}) {
  return h(
    'section',
    { class: 'panel' },
    title
      ? h(
          'div',
          { class: 'panel__head' },
          h('h2', {}, title),
          h('div', { class: 'spacer' }),
          actions ?? null,
        )
      : null,
    h('div', { class: `panel__body${flush ? ' panel__body--flush' : ''}` }, body),
    src ? h('p', { class: 'source' }, src) : null,
  );
}

export function pill(state, label) {
  return h(
    'span',
    { class: 'pill', 'data-s': state },
    h('span', { class: 'pill__dot', 'aria-hidden': 'true' }),
    label ?? String(state).replace(/_/g, ' '),
  );
}

export function stat(label, value, { sub, hero, unit } = {}) {
  return h(
    'div',
    { class: `stat${hero ? ' stat--hero' : ''}` },
    h('span', { class: 'stat__k' }, label),
    h('span', { class: 'stat__value' }, value ?? '--', unit ? h('small', {}, unit) : null),
    sub ? h('span', { class: 'stat__sub' }, sub) : null,
  );
}

export function kv(rows) {
  return h(
    'div',
    { class: 'kv' },
    ...rows
      .filter(Boolean)
      .map(([k, v, dim]) =>
        h(
          'div',
          { class: 'kv__row' },
          h('span', { class: 'kv__k' }, k),
          h('span', { class: `kv__v${dim ? ' kv__v--dim' : ''}` }, v ?? '--'),
        ),
      ),
  );
}

/**
 * A ratio against a limit. Deliberately a meter, not a donut: one number
 * against one ceiling reads faster on a track than in a ring.
 */
export function meter(label, used, total, { format = bytes, foot } = {}) {
  const ratio = Number.isFinite(used) && Number.isFinite(total) && total > 0 ? used / total : null;
  const level = ratio == null ? 'none' : ratio > 0.9 ? 'high' : ratio > 0.75 ? 'warn' : 'ok';
  return h(
    'div',
    { class: 'meter', 'data-level': level },
    h(
      'div',
      { class: 'meter__top' },
      h('span', { class: 'meter__label' }, label),
      h('span', { class: 'meter__val' }, ratio == null ? '--' : `${Math.round(ratio * 100)}%`),
    ),
    h(
      'div',
      { class: 'meter__track', role: 'meter', 'aria-valuenow': ratio == null ? 0 : Math.round(ratio * 100),
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': label },
      h('div', { class: 'meter__fill', style: `width:${ratio == null ? 0 : Math.min(100, ratio * 100)}%` }),
    ),
    h(
      'p',
      { class: 'meter__foot' },
      foot ?? (ratio == null ? 'No data' : `${format(used)} of ${format(total)}`),
    ),
  );
}

export function note(text, { warn } = {}) {
  return h('div', { class: `note${warn ? ' note--warn' : ''}` }, text);
}

export function emptyState(title, msg) {
  return h(
    'div',
    { class: 'state' },
    h('div', { class: 'state__icon', 'aria-hidden': 'true' }, '·'),
    h('p', { class: 'state__title' }, title),
    msg ? h('p', { class: 'state__msg' }, msg) : null,
  );
}

/** Provenance line for a panel: which interface answered, and how fast. */
export function sourceLine(result, extra) {
  if (!result) return null;
  const parts = [];
  if (result.source) parts.push(result.source);
  if (Number.isFinite(result.ms)) parts.push(`${Math.round(result.ms)}ms`);
  if (extra) parts.push(extra);
  return parts.length ? parts.join('  ·  ') : null;
}
