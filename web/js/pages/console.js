/**
 * Console -- natural-language requests to North.
 *
 * The one write path in the dashboard. Each turn is timed client-side so the
 * round trip you feel is the number recorded, and the reply is rendered with
 * whatever tool activity the gateway reported alongside it.
 */

import * as api from '../api.js';
import { h, clear, panel, pill, ms, clock, isOk, note, emptyState } from '../ui.js';

export const title = 'Console';
export const subtitle = 'Ask North to do something';

const EXAMPLES = [
  'What do I have open?',
  'Open Spotify',
  "What's using the most memory?",
  'Check Claude Code',
];

/** Kept across navigation so switching tabs does not lose the conversation. */
const turns = [];
let sessionId = null;

export function mount(root) {
  const transcript = h('div', { class: 'transcript' });
  const input = h('textarea', {
    placeholder: 'Ask North…   (Enter to send, Shift+Enter for a new line)',
    rows: '1',
    'aria-label': 'Message to North',
  });
  const sendBtn = h('button', { class: 'btn btn--primary' }, 'Send');
  const sessionPicker = h('select', {
    class: 'btn',
    style: 'padding:5px 8px',
    'aria-label': 'Session',
    onchange: (e) => {
      sessionId = e.target.value || null;
    },
  });

  const composer = h(
    'div',
    { class: 'composer' },
    input,
    h('div', { class: 'stack', style: 'gap:6px' }, sendBtn),
  );

  root.append(
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'stat__k' }, 'Session'),
        sessionPicker,
        h('div', { class: 'spacer' }),
        h(
          'div',
          { class: 'chips' },
          ...EXAMPLES.map((ex) =>
            h(
              'button',
              {
                class: 'chip',
                onclick: () => {
                  input.value = ex;
                  input.focus();
                  autosize();
                },
              },
              ex,
            ),
          ),
        ),
      ),
      panel(null, h('div', { class: 'console' }, transcript, composer), { flush: true }),
    ),
  );

  // Populate the session list so a request can continue existing context.
  api
    .get('/api/sessions')
    .then((res) => {
      clear(sessionPicker).append(h('option', { value: '' }, 'New / default'));
      if (isOk(res)) {
        for (const s of res.data.slice(0, 25)) {
          if (!s.id) continue;
          sessionPicker.append(h('option', { value: s.id }, s.title ?? s.id));
        }
      }
    })
    .catch(() => {});

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(168, input.scrollHeight)}px`;
  }
  input.addEventListener('input', autosize);

  function draw() {
    clear(transcript);
    if (!turns.length) {
      transcript.append(
        emptyState('No messages yet', 'Type a request below. North runs it through OpenClaw on this machine.'),
      );
      return;
    }
    for (const t of turns) transcript.append(renderTurn(t));
    transcript.scrollTop = transcript.scrollHeight;
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    autosize();
    sendBtn.disabled = true;
    input.disabled = true;

    turns.push({ who: 'me', text, at: Date.now() });
    const pending = { who: 'north', pending: true, at: Date.now() };
    turns.push(pending);
    draw();

    const started = performance.now();
    try {
      const res = await api.post('/api/console', { text, sessionId });
      const elapsed = performance.now() - started;
      Object.assign(pending, {
        pending: false,
        ok: isOk(res),
        text: isOk(res)
          ? res.data.reply ?? '(North returned no text. The raw payload is in the details below.)'
          : res.reason ?? 'North could not answer.',
        raw: isOk(res) ? res.data.raw : null,
        method: isOk(res) ? res.data.method : res.source,
        elapsed,
        state: res.state,
      });
    } catch (err) {
      Object.assign(pending, {
        pending: false,
        ok: false,
        text: err.message,
        elapsed: performance.now() - started,
      });
    } finally {
      sendBtn.disabled = false;
      input.disabled = false;
      draw();
      input.focus();
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  draw();
  input.focus();
}

function renderTurn(t) {
  if (t.who === 'me') {
    return h(
      'div',
      { class: 'turn turn--me' },
      h('span', { class: 'turn__who' }, 'You'),
      h('div', { class: 'turn__bubble' }, t.text),
    );
  }

  if (t.pending) {
    return h(
      'div',
      { class: 'turn' },
      h('span', { class: 'turn__who' }, 'North'),
      h(
        'div',
        { class: 'turn__bubble' },
        h('span', { class: 'thinking' }, h('i'), h('i'), h('i')),
      ),
    );
  }

  return h(
    'div',
    { class: `turn${t.ok ? '' : ' turn--err'}` },
    h('span', { class: 'turn__who' }, 'North'),
    h('div', { class: 'turn__bubble' }, t.text),
    h(
      'p',
      { class: 'turn__meta' },
      [t.elapsed != null ? ms(t.elapsed) : null, t.method, clock(t.at)].filter(Boolean).join('  ·  '),
    ),
    t.raw ? renderRaw(t.raw) : null,
  );
}

/** Collapsed by default: useful when the reply text is empty or surprising. */
function renderRaw(raw) {
  const pre = h(
    'pre',
    {
      class: 'mono',
      style:
        'margin:6px 0 0;padding:9px;border-radius:7px;background:var(--surface-in);border:1px solid var(--border);font-size:10.5px;overflow-x:auto;max-height:220px;color:var(--text-3)',
    },
    JSON.stringify(raw, null, 2),
  );
  const details = h('details', { style: 'margin-top:2px' });
  details.append(
    h('summary', { style: 'font-size:10.5px;color:var(--text-3);cursor:pointer' }, 'Raw response'),
    pre,
  );
  return details;
}
