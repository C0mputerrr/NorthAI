/**
 * The Result envelope.
 *
 * Every adapter in North Command Center returns one of these, never a bare
 * value. The UI renders directly from `state`, which is what keeps the
 * "no fake data" rule enforceable rather than aspirational: an adapter that
 * cannot reach its source has no way to express that as a number, only as a
 * non-`ok` state carrying a human-readable reason.
 */

/** @typedef {'ok'|'unavailable'|'not_configured'|'error'|'unknown'} ResultState */

/**
 * @param {object} fields
 * @param {ResultState} fields.state
 * @param {*} [fields.data]      Payload. Meaningful only when state === 'ok'.
 * @param {string} [fields.reason]  Why this is not ok. Shown verbatim in the UI.
 * @param {string} [fields.source]  Which interface produced this (for the UI's provenance line).
 * @param {number} [fields.ms]      Wall-clock cost of producing it, for the latency page.
 */
function make({ state, data = null, reason = null, source = null, ms = null }) {
  return { state, data, reason, source, ms, at: Date.now() };
}

/** Source reached, data is real. */
export const ok = (data, source, ms) => make({ state: 'ok', data, source, ms });

/**
 * The interface exists but could not be reached right now (gateway down,
 * timeout, command missing). Retrying later may succeed.
 */
export const unavailable = (reason, source, ms) =>
  make({ state: 'unavailable', reason, source, ms });

/**
 * The interface is reachable but the user has not set this up. Distinct from
 * `unavailable` because the fix is configuration, not troubleshooting.
 */
export const notConfigured = (reason, source) =>
  make({ state: 'not_configured', reason, source });

/** The call failed in a way that suggests a bug or a broken install. */
export const error = (reason, source, ms) => make({ state: 'error', reason, source, ms });

/**
 * We genuinely cannot determine the answer. Used where guessing would be
 * worse than admitting ignorance -- e.g. an integration whose liveness
 * OpenClaw does not expose.
 */
export const unknown = (reason, source) => make({ state: 'unknown', reason, source });

/** True when a Result carries trustworthy data. */
export const isOk = (r) => Boolean(r) && r.state === 'ok';

/**
 * Map an ok Result's payload, preserving state and provenance. Non-ok results
 * pass through untouched so a failure upstream stays a failure, with its
 * original reason intact, instead of decaying into an empty success.
 */
export function mapOk(result, fn) {
  if (!isOk(result)) return result;
  try {
    return { ...result, data: fn(result.data) };
  } catch (err) {
    return error(`Malformed payload: ${err.message}`, result.source, result.ms);
  }
}
