/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * A JSON reader and writer that keeps 64-bit integers exact.
 *
 * CamusDB is a 64-bit database. An `int64` column, a transaction's physical-time component, and a
 * date's tick count all reach the wire as JSON numbers whose value can exceed 2^53, which is where
 * a JavaScript number stops being able to name every integer. `JSON.parse` would round such a
 * value silently, and `JSON.stringify` refuses a `bigint` outright. Both are unacceptable in a
 * driver: a row must come back holding what was written.
 *
 * So this module reads an integer that does not fit a `number` as a `bigint`, and writes a
 * `bigint` as the bare digits a JSON number is. Everything else behaves exactly as the built-in
 * functions do.
 */

/**
 * Parses JSON text, reading an integer outside the safe range as a `bigint`.
 *
 * The common reply holds no such integer, and the built-in parser is far faster than any parser
 * written in JavaScript. So the text is first tested for a run of 16 or more digits — the shortest
 * run that can leave the safe range. Without one the built-in parser is exact and is used. A run
 * inside a string literal costs nothing but a slower parse of that one reply.
 */
export function parseLossless(text: string): unknown {
  return LONG_INTEGER.test(text) ? new LosslessParser(text).parse() : (JSON.parse(text) as unknown);
}

const LONG_INTEGER = /\d{16,}/;

/**
 * Serializes a value as JSON, writing a `bigint` as a JSON number.
 *
 * `undefined`, a function, and a symbol are omitted from an object and become `null` in an array,
 * which is what `JSON.stringify` does. A value with a `toJSON` method is replaced by its result,
 * also as `JSON.stringify` does.
 */
export function stringifyLossless(value: unknown): string {
  const out: string[] = [];
  writeValue(value, out, 0);
  return out.join('');
}

const MAX_DEPTH = 200;

function writeValue(value: unknown, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new TypeError('Cannot serialize a value nested more than 200 levels deep.');
  }

  if (value === null) {
    out.push('null');
    return;
  }

  switch (typeof value) {
    case 'bigint':
      out.push(value.toString());
      return;

    case 'number':
      out.push(Number.isFinite(value) ? String(value) : 'null');
      return;

    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;

    case 'string':
      out.push(quote(value));
      return;

    case 'object':
      break;

    default:
      out.push('null');
      return;
  }

  const object = value as { toJSON?: () => unknown };

  if (typeof object.toJSON === 'function') {
    writeValue(object.toJSON(), out, depth + 1);
    return;
  }

  if (Array.isArray(value)) {
    out.push('[');

    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');

      const item = value[i] as unknown;
      if (isOmitted(item)) out.push('null');
      else writeValue(item, out, depth + 1);
    }

    out.push(']');
    return;
  }

  if (value instanceof Map) {
    writeEntries(value.entries() as IterableIterator<[unknown, unknown]>, out, depth);
    return;
  }

  writeEntries(Object.entries(value as Record<string, unknown>).values(), out, depth);
}

function writeEntries(entries: IterableIterator<[unknown, unknown]>, out: string[], depth: number): void {
  out.push('{');
  let first = true;

  for (const [key, entryValue] of entries) {
    if (isOmitted(entryValue)) continue;
    if (typeof key !== 'string') continue;

    if (!first) out.push(',');
    first = false;

    out.push(quote(key), ':');
    writeValue(entryValue, out, depth + 1);
  }

  out.push('}');
}

function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

// eslint-disable-next-line no-control-regex -- JSON requires these characters to be escaped.
const NEEDS_ESCAPE = /["\\\u0000-\u001f\u007f-\u009f]/;

// eslint-disable-next-line no-control-regex -- JSON requires these characters to be escaped.
const ESCAPE_ALL = /["\\\u0000-\u001f\u007f-\u009f]/g;

function quote(value: string): string {
  if (!NEEDS_ESCAPE.test(value)) return `"${value}"`;

  return `"${value.replace(ESCAPE_ALL, (character) => {
    const escape = ESCAPES[character];
    if (escape !== undefined) return escape;

    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  })}"`;
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A recursive-descent JSON reader. It is used only for text that holds a long integer run. */
class LosslessParser {
  private readonly text: string;

  private position = 0;

  constructor(text: string) {
    this.text = text;
  }

  parse(): unknown {
    this.skipWhitespace();
    const value = this.readValue(0);
    this.skipWhitespace();

    if (this.position < this.text.length) {
      throw new SyntaxError(`Unexpected text after the JSON value at position ${String(this.position)}.`);
    }

    return value;
  }

  private readValue(depth: number): unknown {
    if (depth > MAX_DEPTH) {
      throw new SyntaxError('The JSON value is nested more than 200 levels deep.');
    }

    const character = this.text[this.position];

    switch (character) {
      case '{':
        return this.readObject(depth);
      case '[':
        return this.readArray(depth);
      case '"':
        return this.readString();
      case 't':
        return this.readLiteral('true', true);
      case 'f':
        return this.readLiteral('false', false);
      case 'n':
        return this.readLiteral('null', null);
      default:
        return this.readNumber();
    }
  }

  private readObject(depth: number): Record<string, unknown> {
    const object: Record<string, unknown> = {};

    this.position++; // past '{'
    this.skipWhitespace();

    if (this.text[this.position] === '}') {
      this.position++;
      return object;
    }

    for (;;) {
      this.skipWhitespace();

      if (this.text[this.position] !== '"') {
        throw new SyntaxError(`Expected a property name at position ${String(this.position)}.`);
      }

      const key = this.readString();

      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();

      const value = this.readValue(depth + 1);

      // A prototype-polluting key is stored as an own property rather than assigned through the
      // prototype chain, so hostile JSON cannot reach Object.prototype.
      Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });

      this.skipWhitespace();

      if (this.text[this.position] === ',') {
        this.position++;
        continue;
      }

      this.expect('}');
      return object;
    }
  }

  private readArray(depth: number): unknown[] {
    const array: unknown[] = [];

    this.position++; // past '['
    this.skipWhitespace();

    if (this.text[this.position] === ']') {
      this.position++;
      return array;
    }

    for (;;) {
      this.skipWhitespace();
      array.push(this.readValue(depth + 1));
      this.skipWhitespace();

      if (this.text[this.position] === ',') {
        this.position++;
        continue;
      }

      this.expect(']');
      return array;
    }
  }

  private readString(): string {
    const start = this.position;
    this.position++; // past the opening quote

    // A string with no escape is the common case; slice it out whole.
    let hasEscape = false;

    while (this.position < this.text.length) {
      const character = this.text[this.position]!;

      if (character === '\\') {
        hasEscape = true;
        this.position += 2;
        continue;
      }

      if (character === '"') {
        const raw = this.text.slice(start, this.position + 1);
        this.position++;

        return hasEscape ? (JSON.parse(raw) as string) : raw.slice(1, -1);
      }

      this.position++;
    }

    throw new SyntaxError(`Unterminated string starting at position ${String(start)}.`);
  }

  private readNumber(): number | bigint {
    const start = this.position;

    if (this.text[this.position] === '-') this.position++;

    while (isDigit(this.text[this.position])) this.position++;

    let isInteger = true;

    if (this.text[this.position] === '.') {
      isInteger = false;
      this.position++;
      while (isDigit(this.text[this.position])) this.position++;
    }

    const exponent = this.text[this.position];

    if (exponent === 'e' || exponent === 'E') {
      isInteger = false;
      this.position++;

      const sign = this.text[this.position];
      if (sign === '+' || sign === '-') this.position++;

      while (isDigit(this.text[this.position])) this.position++;
    }

    const raw = this.text.slice(start, this.position);

    if (raw.length === 0 || raw === '-') {
      throw new SyntaxError(`Expected a value at position ${String(start)}.`);
    }

    if (!isInteger) return Number(raw);

    const asNumber = Number(raw);

    if (Number.isSafeInteger(asNumber)) return asNumber;

    const asBigInt = BigInt(raw);

    return asBigInt >= MIN_SAFE && asBigInt <= MAX_SAFE ? Number(asBigInt) : asBigInt;
  }

  private readLiteral<T>(literal: string, value: T): T {
    if (!this.text.startsWith(literal, this.position)) {
      throw new SyntaxError(`Expected '${literal}' at position ${String(this.position)}.`);
    }

    this.position += literal.length;
    return value;
  }

  private expect(character: string): void {
    if (this.text[this.position] !== character) {
      throw new SyntaxError(`Expected '${character}' at position ${String(this.position)}.`);
    }

    this.position++;
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length) {
      const character = this.text[this.position]!;

      if (character === ' ' || character === '\n' || character === '\r' || character === '\t') {
        this.position++;
        continue;
      }

      return;
    }
  }
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

/** Reads a value that may have arrived as a number, a bigint, or a numeric string. */
export function asBigInt(value: unknown, fallback = 0n): bigint {
  switch (typeof value) {
    case 'bigint':
      return value;
    case 'number':
      return Number.isFinite(value) ? BigInt(Math.trunc(value)) : fallback;
    case 'string':
      try {
        return BigInt(value);
      } catch {
        return fallback;
      }
    default:
      return fallback;
  }
}

/** Reads a value that may have arrived as a number or a bigint, as a `number`. */
export function asNumber(value: unknown, fallback = 0): number {
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? value : fallback;
    case 'bigint':
      return Number(value);
    case 'string': {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    default:
      return fallback;
  }
}
