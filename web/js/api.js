/**
 * Server access: plain fetch for reads/writes, SSE for the live feed.
 *
 * The stream is the primary path — panels re-render from pushed state — and
 * fetch is used for pages that are not on the broadcast tick, and for writes.
 */

const listeners = new Map();
let source = null;
let connState = 'connecting';

export async function get(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/** Subscribe to a stream event (or 'connection' for transport state). */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

function emit(event, payload) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[stream:${event}]`, err);
    }
  }
}

function setConn(state) {
  if (connState === state) return;
  connState = state;
  emit('connection', state);
}

export const connection = () => connState;

/** Latest payload per event, so a page mounted mid-stream renders instantly. */
export const cache = new Map();

export function connect() {
  if (source) return;
  source = new EventSource('/api/stream');

  source.onopen = () => setConn('live');
  source.onerror = () => {
    // EventSource reconnects on its own; reflect the gap in the UI meanwhile.
    setConn(source.readyState === EventSource.CLOSED ? 'down' : 'connecting');
  };

  for (const event of ['status', 'activity', 'metrics']) {
    source.addEventListener(event, (e) => {
      let payload;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }
      cache.set(event, payload);
      setConn('live');
      emit(event, payload);
    });
  }
}
