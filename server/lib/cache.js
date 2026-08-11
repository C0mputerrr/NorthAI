/**
 * TTL cache with in-flight de-duplication.
 *
 * Every panel polls, and several panels want the same underlying call. Without
 * de-duplication, four open browser tabs would mean four concurrent
 * `openclaw` process spawns per tick, which is exactly the kind of idle CPU
 * cost this dashboard is supposed to avoid. Concurrent callers for the same
 * key share one promise; completed values are reused until they age out.
 */

export class TtlCache {
  constructor() {
    /** @type {Map<string, {value: *, expires: number}>} */
    this.entries = new Map();
    /** @type {Map<string, Promise<*>>} */
    this.inflight = new Map();
  }

  /**
   * @param {string} key
   * @param {number} ttlMs   0 disables caching but still de-duplicates.
   * @param {() => Promise<*>} producer
   */
  async get(key, ttlMs, producer) {
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const value = await producer();
        if (ttlMs > 0) {
          this.entries.set(key, { value, expires: Date.now() + ttlMs });
        }
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  /** Force the next read of `key` (or everything) to hit the source. */
  invalidate(key) {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}
