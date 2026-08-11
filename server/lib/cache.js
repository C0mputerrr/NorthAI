/**
 * TTL cache with in-flight de-duplication and stale-while-revalidate.
 *
 * Every panel polls, and several panels want the same underlying call. Without
 * de-duplication, four open browser tabs would mean four concurrent
 * `openclaw` process spawns per tick, which is exactly the kind of idle CPU
 * cost this dashboard is supposed to avoid. Concurrent callers for the same
 * key share one promise; completed values are reused until they age out.
 *
 * Stale-while-revalidate matters more than it sounds on a slow transport. A
 * single OpenClaw RPC has been measured at ~11s on Windows, because each call
 * is a full process launch plus a gateway handshake. Blocking a panel for 11s
 * to re-fetch a value that was already correct 12s ago is the wrong trade:
 * once a value exists, callers get it immediately and a refresh runs behind
 * them. Only the very first read of a key ever waits.
 */

export class TtlCache {
  constructor() {
    /** @type {Map<string, {value: *, expires: number, at: number}>} */
    this.entries = new Map();
    /** @type {Map<string, Promise<*>>} */
    this.inflight = new Map();
  }

  /**
   * @param {string} key
   * @param {number} ttlMs   0 disables caching but still de-duplicates.
   * @param {() => Promise<*>} producer
   * @param {object} [opts]
   * @param {boolean} [opts.stale]  Serve an expired value while refreshing.
   *   Default true. Pass false where a caller genuinely needs a current read.
   * @param {number} [opts.maxStaleMs]  Beyond this age a value is too old to
   *   serve and the caller waits for a fresh one.
   */
  async get(key, ttlMs, producer, { stale = true, maxStaleMs = 10 * 60_000 } = {}) {
    const hit = this.entries.get(key);
    const now = Date.now();

    if (hit && hit.expires > now) return hit.value;

    const refresh = () => {
      const pending = this.inflight.get(key);
      if (pending) return pending;

      const promise = (async () => {
        try {
          const value = await producer();
          if (ttlMs > 0) {
            this.entries.set(key, { value, expires: Date.now() + ttlMs, at: Date.now() });
          }
          return value;
        } finally {
          this.inflight.delete(key);
        }
      })();

      this.inflight.set(key, promise);
      return promise;
    };

    // Expired, but recent enough to be useful: hand it back now and refresh
    // behind the caller.
    if (hit && stale && now - hit.at < maxStaleMs) {
      refresh().catch(() => {
        // A failed background refresh leaves the stale value in place. The
        // next foreground read past maxStaleMs will surface the error.
      });
      return markStale(hit.value, hit.at);
    }

    return refresh();
  }

  /** Force the next read of `key` (or everything) to hit the source. */
  invalidate(key) {
    if (key === undefined) {
      this.entries.clear();
    } else {
      this.entries.delete(key);
    }
  }
}

/**
 * Tag a served-stale Result so the UI can say when it was actually measured,
 * rather than implying the number is current.
 */
function markStale(value, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!('state' in value)) return value;
  return { ...value, stale: true, measuredAt: at };
}
