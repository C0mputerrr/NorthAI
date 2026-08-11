/**
 * Secret scrubbing.
 *
 * Applied to every byte of subprocess output before it can become a UI
 * `reason` string or reach a console log. OpenClaw error messages sometimes
 * echo the invocation, and an invocation can carry `--token`. This is a
 * backstop, not the primary control -- we also avoid passing secrets on the
 * command line in the first place -- but defence in depth is cheap here.
 */

const PATTERNS = [
  // --token VALUE / --token=VALUE, and the password variants.
  /(--(?:token|password|api-key|apikey|secret)[=\s]+)(\S+)/gi,
  // Authorization: Bearer xyz, x-openclaw-token: xyz
  /((?:authorization|x-openclaw-token)\s*:\s*)(?:bearer\s+)?(\S+)/gi,
  // JSON-ish "token": "xyz"
  /(["']?(?:token|password|secret|apiKey|api_key|accessToken|refreshToken|clientSecret)["']?\s*[:=]\s*["'])([^"']+)(["'])/gi,
  // Common provider key shapes, in case one is echoed raw.
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
];

export function redact(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (match, prefix, _value, suffix) => {
      // Single-group patterns (bare key shapes) have no prefix capture.
      if (_value === undefined) return '[redacted]';
      return `${prefix}[redacted]${suffix ?? ''}`;
    });
  }
  return out;
}

/**
 * Trim a subprocess error to something a person can read in a toast without
 * a wall of stack trace, with secrets removed.
 */
export function cleanError(text, maxLen = 300) {
  const cleaned = redact(String(text ?? '').trim()).replace(/\s+/g, ' ');
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}...` : cleaned;
}
