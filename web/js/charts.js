/**
 * Charts, drawn as inline SVG.
 *
 * No charting library: these are two forms (time-series line, horizontal bar)
 * plus a sparkline, and hand-drawn SVG keeps the bundle at zero bytes of
 * dependency while giving exact control over the mark specs.
 *
 * Conventions held throughout, per the visualization method:
 *   - 2px lines, 4px-rounded bar ends, >=8px hit targets on hover.
 *   - Grid and axes are recessive; the data is the only thing with weight.
 *   - Series colour is identity only. All text wears text tokens, never the
 *     series hue, so nothing depends on colour discrimination to be read.
 *   - Every line chart ships a crosshair + tooltip and a table view. With two
 *     or more series a legend is always present.
 *   - Single axis, always. Two measures of different scale get two charts.
 */

import { h, clear, ms as fmtMs, clock } from './ui.js';

const PAD = { top: 12, right: 12, bottom: 22, left: 44 };

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Nice round axis ceiling, so gridlines land on readable numbers. */
function niceMax(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/**
 * Time-series line chart.
 *
 * @param {object} opts
 * @param {Array<{name: string, color: string, points: Array<{at:number, v:number}>}>} opts.series
 * @param {number} [opts.height]
 * @param {(n:number)=>string} [opts.format]
 * @param {string} [opts.emptyMessage]
 */
export function lineChart({ series, height = 168, format = fmtMs, emptyMessage } = {}) {
  const live = (series ?? []).filter((s) => s.points?.some((p) => Number.isFinite(p.v)));

  if (!live.length) {
    return h(
      'div',
      { class: 'state' },
      h('div', { class: 'state__icon', 'aria-hidden': 'true' }, '·'),
      h('p', { class: 'state__title' }, 'No samples yet'),
      h(
        'p',
        { class: 'state__msg' },
        emptyMessage ?? 'Measurements appear here once North handles a request.',
      ),
    );
  }

  const W = 720; // viewBox width; the SVG scales to its container
  const H = height;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const all = live.flatMap((s) => s.points.filter((p) => Number.isFinite(p.v)));
  const tMin = Math.min(...all.map((p) => p.at));
  const tMax = Math.max(...all.map((p) => p.at));
  const vMax = niceMax(Math.max(...all.map((p) => p.v)));
  const span = Math.max(1, tMax - tMin);

  const x = (t) => PAD.left + ((t - tMin) / span) * plotW;
  const y = (v) => PAD.top + plotH - (Math.max(0, v) / vMax) * plotH;

  const svgEl = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
    return el;
  };

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `Line chart: ${live.map((s) => s.name).join(', ')}`,
    style: `height:${H}px`,
  });

  // --- grid + y axis ------------------------------------------------------
  const gGrid = svgEl('g', { class: 'chart__grid' });
  const gAxis = svgEl('g', { class: 'chart__axis' });
  const TICKS = 4;
  for (let i = 0; i <= TICKS; i++) {
    const v = (vMax / TICKS) * i;
    const yy = y(v);
    gGrid.append(svgEl('line', { x1: PAD.left, x2: W - PAD.right, y1: yy, y2: yy }));
    const label = svgEl('text', { x: PAD.left - 7, y: yy + 3.5, 'text-anchor': 'end' });
    label.textContent = format(v);
    gAxis.append(label);
  }
  svg.append(gGrid, gAxis);

  // --- x axis: first and last timestamps only; a dense axis is noise ------
  const gX = svgEl('g', { class: 'chart__axis' });
  for (const [t, anchor] of [[tMin, 'start'], [tMax, 'end']]) {
    const label = svgEl('text', { x: x(t), y: H - 5, 'text-anchor': anchor });
    label.textContent = clock(t);
    gX.append(label);
  }
  svg.append(gX);

  // --- series -------------------------------------------------------------
  for (const s of live) {
    const pts = s.points.filter((p) => Number.isFinite(p.v)).sort((a, b) => a.at - b.at);
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');

    // A single series gets a soft area beneath it for readability; multiple
    // series do not, because overlapping fills muddy both.
    if (live.length === 1) {
      const area = svgEl('path', {
        class: 'chart__area',
        fill: s.color,
        d: `${d} L${x(pts.at(-1).at).toFixed(2)},${PAD.top + plotH} L${x(pts[0].at).toFixed(2)},${PAD.top + plotH} Z`,
      });
      svg.append(area);
    }
    svg.append(svgEl('path', { class: 'chart__line', stroke: s.color, d }));

    // Mark the latest value: the number most likely to be read.
    const last = pts.at(-1);
    svg.append(
      svgEl('circle', {
        class: 'chart__dot',
        cx: x(last.at),
        cy: y(last.v),
        fill: s.color,
        stroke: cssVar('--chart-surface'),
      }),
    );
  }

  // --- hover layer --------------------------------------------------------
  const cross = svgEl('line', {
    class: 'chart__cross',
    y1: PAD.top,
    y2: PAD.top + plotH,
    x1: 0,
    x2: 0,
    opacity: 0,
  });
  const markers = live.map((s) =>
    svgEl('circle', { r: 4, fill: s.color, stroke: cssVar('--chart-surface'), 'stroke-width': 2, opacity: 0 }),
  );
  svg.append(cross, ...markers);

  const hit = svgEl('rect', {
    class: 'chart__hit',
    x: PAD.left,
    y: PAD.top,
    width: plotW,
    height: plotH,
  });
  svg.append(hit);

  const tip = h('div', { class: 'tooltip' });
  const wrap = h('div', { class: 'chart' }, svg, tip);

  const hide = () => {
    tip.dataset.show = '0';
    cross.setAttribute('opacity', '0');
    markers.forEach((m) => m.setAttribute('opacity', '0'));
  };

  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    if (px < PAD.left || px > W - PAD.right) return hide();

    const t = tMin + ((px - PAD.left) / plotW) * span;
    const rows = [];
    live.forEach((s, i) => {
      const pts = s.points.filter((p) => Number.isFinite(p.v));
      if (!pts.length) return markers[i].setAttribute('opacity', '0');
      // Nearest sample in time, which is what the crosshair implies.
      const near = pts.reduce((a, b) => (Math.abs(b.at - t) < Math.abs(a.at - t) ? b : a));
      markers[i].setAttribute('cx', x(near.at));
      markers[i].setAttribute('cy', y(near.v));
      markers[i].setAttribute('opacity', '1');
      rows.push({ name: s.name, color: s.color, v: near.v, at: near.at });
    });
    if (!rows.length) return hide();

    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('opacity', '1');

    clear(tip).append(
      h('p', { class: 'tooltip__t' }, clock(rows[0].at)),
      ...rows.map((r) =>
        h(
          'div',
          { class: 'tooltip__r' },
          h(
            'span',
            { style: 'display:inline-flex;align-items:center;gap:6px;color:var(--text-2)' },
            h('span', { class: 'tooltip__sw', style: `background:${r.color}` }),
            r.name,
          ),
          h('span', { class: 'tooltip__v' }, format(r.v)),
        ),
      ),
    );
    tip.dataset.show = '1';
    // Keep the tooltip inside the container.
    const ratio = (px / W) * 100;
    tip.style.left = `${Math.min(78, Math.max(2, ratio + 2))}%`;
    tip.style.top = '6px';
  });
  svg.addEventListener('pointerleave', hide);

  return wrap;
}

/** Legend. Always rendered for two or more series. */
export function legend(series) {
  return h(
    'div',
    { class: 'legend' },
    ...series.map((s) =>
      h(
        'span',
        { class: 'legend__i' },
        h('span', { class: 'legend__sw', style: `background:${s.color}` }),
        s.name,
      ),
    ),
  );
}

/**
 * Horizontal bars for ranked magnitude (slowest requests, heaviest processes).
 * One hue: this is magnitude, not identity.
 */
export function barList(items, { format = fmtMs, color = 'var(--series-1)', max } = {}) {
  if (!items?.length) return null;
  const ceiling = max ?? Math.max(...items.map((i) => i.value ?? 0), 1);
  return h(
    'div',
    { class: 'stack', style: 'gap:9px' },
    ...items.map((it) =>
      h(
        'div',
        { class: 'stack', style: 'gap:4px' },
        h(
          'div',
          { class: 'row', style: 'gap:10px;flex-wrap:nowrap' },
          h(
            'span',
            {
              style:
                'font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0',
              title: it.label,
            },
            it.label,
          ),
          h(
            'span',
            { class: 'mono', style: 'font-size:11.5px;color:var(--text);flex:none' },
            format(it.value),
          ),
        ),
        h(
          'div',
          { class: 'meter__track' },
          h('div', {
            class: 'meter__fill',
            style: `width:${Math.max(1.5, ((it.value ?? 0) / ceiling) * 100)}%;background:${color}`,
          }),
        ),
      ),
    ),
  );
}

/** Compact trend for a stat tile. No axes; the tile's number carries the value. */
export function sparkline(points, { color = 'var(--series-1)', height = 30 } = {}) {
  const vals = (points ?? []).filter((p) => Number.isFinite(p.v));
  if (vals.length < 2) return null;

  const W = 120;
  const H = height;
  const max = Math.max(...vals.map((p) => p.v));
  const min = Math.min(...vals.map((p) => p.v));
  const range = max - min;
  const step = W / (vals.length - 1);

  // A perfectly flat series has no range to normalise against. Draw it down
  // the middle rather than pinning it to the top, where the area fill below
  // would read as a solid block instead of a trend.
  const yOf = (v) =>
    range < 1e-9 ? H / 2 : H - ((v - min) / range) * (H - 4) - 2;

  const d = vals
    .map((p, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(2)},${yOf(p.v).toFixed(2)}`)
    .join(' ');

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');

  // A flat series gets no area fill: a rectangle of colour reads as a filled
  // bar chart, implying magnitude where there is only a steady value.
  const area = range < 1e-9 ? null : document.createElementNS(ns, 'path');
  if (area) {
    area.setAttribute('d', `${d} L${W},${H} L0,${H} Z`);
    area.setAttribute('fill', color);
    area.setAttribute('opacity', '0.1');
  }

  const line = document.createElementNS(ns, 'path');
  line.setAttribute('d', d);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('vector-effect', 'non-scaling-stroke');

  if (area) svg.append(area);
  svg.append(line);
  return svg;
}

export const SERIES = {
  1: 'var(--series-1)',
  2: 'var(--series-2)',
  3: 'var(--series-3)',
};
