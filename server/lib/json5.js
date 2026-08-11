/**
 * Minimal JSON5 reader.
 *
 * OpenClaw stores its config as JSON5 (`~/.openclaw/openclaw.json`), which
 * JSON.parse rejects: it allows comments, trailing commas, unquoted keys and
 * single-quoted strings. Rather than take on a dependency to read one file,
 * this covers the subset a hand-written config actually uses.
 *
 * Deliberately not a full JSON5 implementation -- no \u{...} escapes, no
 * exotic numeric literals. If parsing fails we surface the error and fall back
 * to defaults rather than pretending we read the config.
 */

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v', ' ', '﻿']);
const ESCAPES = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0' };

export function parseJson5(text) {
  const s = new Scanner(text);
  s.skipTrivia();
  const value = s.readValue();
  s.skipTrivia();
  if (!s.done) s.fail(`Unexpected trailing content`);
  return value;
}

class Scanner {
  constructor(text) {
    this.text = text;
    this.i = 0;
  }

  get done() {
    return this.i >= this.text.length;
  }

  get ch() {
    return this.text[this.i];
  }

  fail(message) {
    // Report a line number; a byte offset is useless when hand-editing config.
    const line = this.text.slice(0, this.i).split('\n').length;
    throw new SyntaxError(`${message} at line ${line}`);
  }

  /** Consume whitespace and both comment styles. */
  skipTrivia() {
    for (;;) {
      while (!this.done && WHITESPACE.has(this.ch)) this.i++;
      if (this.ch === '/' && this.text[this.i + 1] === '/') {
        while (!this.done && this.ch !== '\n') this.i++;
        continue;
      }
      if (this.ch === '/' && this.text[this.i + 1] === '*') {
        const end = this.text.indexOf('*/', this.i + 2);
        if (end === -1) this.fail('Unterminated block comment');
        this.i = end + 2;
        continue;
      }
      return;
    }
  }

  readValue() {
    if (this.done) this.fail('Unexpected end of input');
    const c = this.ch;
    if (c === '{') return this.readObject();
    if (c === '[') return this.readArray();
    if (c === '"' || c === "'") return this.readString();

    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (this.text.startsWith(literal, this.i)) {
        this.i += literal.length;
        return value;
      }
    }
    return this.readNumber();
  }

  readObject() {
    this.i++; // {
    const out = {};
    for (;;) {
      this.skipTrivia();
      if (this.ch === '}') {
        this.i++;
        return out;
      }
      const key = this.ch === '"' || this.ch === "'" ? this.readString() : this.readIdentifier();
      this.skipTrivia();
      if (this.ch !== ':') this.fail(`Expected ':' after key "${key}"`);
      this.i++;
      this.skipTrivia();
      out[key] = this.readValue();
      this.skipTrivia();
      if (this.ch === ',') {
        this.i++;
        continue;
      }
      if (this.ch === '}') {
        this.i++;
        return out;
      }
      this.fail("Expected ',' or '}' in object");
    }
  }

  readArray() {
    this.i++; // [
    const out = [];
    for (;;) {
      this.skipTrivia();
      if (this.ch === ']') {
        this.i++;
        return out;
      }
      out.push(this.readValue());
      this.skipTrivia();
      if (this.ch === ',') {
        this.i++;
        continue;
      }
      if (this.ch === ']') {
        this.i++;
        return out;
      }
      this.fail("Expected ',' or ']' in array");
    }
  }

  readIdentifier() {
    const start = this.i;
    while (!this.done && /[A-Za-z0-9_$]/.test(this.ch)) this.i++;
    if (this.i === start) this.fail('Expected an object key');
    return this.text.slice(start, this.i);
  }

  readString() {
    const quote = this.ch;
    this.i++;
    let out = '';
    while (!this.done && this.ch !== quote) {
      if (this.ch === '\\') {
        this.i++;
        const e = this.ch;
        this.i++;
        if (e === 'u') {
          out += String.fromCharCode(parseInt(this.text.substr(this.i, 4), 16));
          this.i += 4;
        } else if (e === 'x') {
          out += String.fromCharCode(parseInt(this.text.substr(this.i, 2), 16));
          this.i += 2;
        } else if (e === '\n') {
          // Line continuation: the newline is swallowed.
        } else {
          out += ESCAPES[e] ?? e;
        }
        continue;
      }
      out += this.ch;
      this.i++;
    }
    if (this.done) this.fail('Unterminated string');
    this.i++; // closing quote
    return out;
  }

  readNumber() {
    const start = this.i;
    if (this.ch === '+' || this.ch === '-') this.i++;
    if (this.text.startsWith('Infinity', this.i)) {
      this.i += 8;
      return this.text[start] === '-' ? -Infinity : Infinity;
    }
    if (this.text.startsWith('NaN', this.i)) {
      this.i += 3;
      return NaN;
    }
    if (this.ch === '0' && /[xX]/.test(this.text[this.i + 1] ?? '')) {
      this.i += 2;
      while (!this.done && /[0-9a-fA-F]/.test(this.ch)) this.i++;
      return Number(this.text.slice(start, this.i));
    }
    while (!this.done && /[0-9.eE+-]/.test(this.ch)) this.i++;
    const raw = this.text.slice(start, this.i);
    const n = Number(raw);
    if (raw === '' || Number.isNaN(n)) this.fail(`Invalid number "${raw}"`);
    return n;
  }
}
