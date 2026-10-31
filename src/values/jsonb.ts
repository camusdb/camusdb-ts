/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';
import { MAX_JSON_DEPTH, parseLossless, stringifyLossless } from '../json.js';

/**
 * Conversions between a CamusDB `jsonb` value and JavaScript values.
 *
 * A `jsonb` cell holds one JSON document. It travels as JSON text. The driver keeps a result cell
 * in the PostgreSQL `jsonb_out` text form on every transport: one space after each `:` and each
 * `,`, keys in the stored order, and no other white space, for example
 * `{"a": [1, 2.50], "b": null}`. Numbers keep every digit and their scale.
 */

/** The deepest document the server stores. A deeper one fails with `CADB0419`. */
export const JSONB_MAX_NESTING_DEPTH = 512;

/**
 * The JSON text that binds `value` as `jsonb`.
 *
 * - A `string` is JSON text, and it is sent as it is. The server refuses text that is not JSON with
 *   `CADB0418`.
 * - A `Uint8Array` or an `ArrayBuffer` is UTF-8 JSON text.
 * - Any other value is serialized: an object, an array, a number, a boolean, or `null`. A `bigint`
 *   is written as the digits of a JSON number, so it keeps every digit.
 */
export function jsonbFromParameter(value: unknown): string {
  if (typeof value === 'string') return value;

  if (value instanceof Uint8Array)
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');

  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new CamusError(CamusErrorCode.InvalidParameter, `Cannot bind ${typeof value} as a JSONB document.`);
  }

  return stringifyLossless(value);
}

/**
 * True for a plain object: one whose prototype is `Object.prototype` or `null`. A plain object
 * binds as `jsonb` with no `camus.jsonb` around it. An instance of a class does not, because its
 * JSON form is not always its data.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  const prototype = Object.getPrototypeOf(value) as unknown;

  return prototype === Object.prototype || prototype === null;
}

/**
 * The JavaScript value of a document's text. An integer outside the safe range reads as a
 * `bigint`, as `int64` does in `auto` mode. Every other number reads as a `number`.
 */
export function parseJsonb(text: string): unknown {
  try {
    return parseLossless(text);
  } catch (error) {
    throw new CamusError(CamusErrorCode.Generic, 'The server returned a JSONB value that is not JSON.', {
      cause: error,
    });
  }
}

/**
 * The PostgreSQL text form of `json`: one space after each `:` and each `,`, and no other white
 * space. Keys keep their order, numbers keep their text, and a string is written with the
 * PostgreSQL escapes.
 *
 * @throws {SyntaxError} when `json` is not one JSON value.
 */
export function formatJsonb(json: string): string {
  return new JsonbFormatter(json).format();
}

/**
 * The PostgreSQL text form of a value that `JSON.parse` or `parseLossless` gave. A number is written
 * as the shortest text that reads back as the same number, so it can lose the scale of the stored
 * text (`2.50` is written `2.5`). Use `formatJsonb` when the text is available.
 */
export function formatJsonbValue(value: unknown): string {
  const out: string[] = [];
  writeValue(value, out, 0);
  return out.join('');
}

function writeValue(value: unknown, out: string[], depth: number): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new SyntaxError(`The JSON value is nested more than ${String(MAX_JSON_DEPTH)} levels deep.`);
  }

  if (value === null || value === undefined) {
    out.push('null');
    return;
  }

  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;

    case 'number':
      out.push(Object.is(value, -0) ? '-0' : Number.isFinite(value) ? String(value) : 'null');
      return;

    case 'bigint':
      out.push(value.toString());
      return;

    case 'string':
      out.push(escapeString(value));
      return;

    case 'object':
      break;

    default:
      out.push('null');
      return;
  }

  if (Array.isArray(value)) {
    out.push('[');

    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(', ');
      writeValue(value[i], out, depth + 1);
    }

    out.push(']');
    return;
  }

  out.push('{');
  let first = true;

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!first) out.push(', ');
    first = false;

    out.push(escapeString(key), ': ');
    writeValue(item, out, depth + 1);
  }

  out.push('}');
}

/**
 * A JSON string in the PostgreSQL `escape_json` form: a quote, a backslash, and each control
 * character are escaped, and every other character is written as it is.
 */
function escapeString(value: string): string {
  // eslint-disable-next-line no-control-regex -- JSON requires these characters to be escaped.
  if (!/["\\\u0000-\u001f]/.test(value)) return `"${value}"`;

  let text = '"';

  for (const character of value) {
    switch (character) {
      case '"':
        text += '\\"';
        break;
      case '\\':
        text += '\\\\';
        break;
      case '\b':
        text += '\\b';
        break;
      case '\f':
        text += '\\f';
        break;
      case '\n':
        text += '\\n';
        break;
      case '\r':
        text += '\\r';
        break;
      case '\t':
        text += '\\t';
        break;
      default: {
        const code = character.charCodeAt(0);
        text += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : character;
      }
    }
  }

  return `${text}"`;
}

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** A scanner that writes JSON text in the PostgreSQL text form, with no JavaScript value between. */
class JsonbFormatter {
  private readonly text: string;

  private readonly out: string[] = [];

  private position = 0;

  constructor(text: string) {
    this.text = text;
  }

  format(): string {
    this.skipWhitespace();

    if (this.position >= this.text.length) {
      throw new SyntaxError('The text holds no JSON value.');
    }

    this.writeValue(0);
    this.skipWhitespace();

    if (this.position < this.text.length) {
      throw new SyntaxError('The text holds more than one JSON value.');
    }

    return this.out.join('');
  }

  private writeValue(depth: number): void {
    if (depth > MAX_JSON_DEPTH) {
      throw new SyntaxError(`The JSON value is nested more than ${String(MAX_JSON_DEPTH)} levels deep.`);
    }

    switch (this.text[this.position]) {
      case '{':
        this.writeObject(depth);
        return;
      case '[':
        this.writeArray(depth);
        return;
      case '"':
        this.out.push(escapeString(this.readString()));
        return;
      case 't':
        this.writeLiteral('true');
        return;
      case 'f':
        this.writeLiteral('false');
        return;
      case 'n':
        this.writeLiteral('null');
        return;
      default:
        this.writeNumber();
    }
  }

  private writeObject(depth: number): void {
    this.position++; // past '{'
    this.out.push('{');
    this.skipWhitespace();

    if (this.text[this.position] === '}') {
      this.position++;
      this.out.push('}');
      return;
    }

    for (;;) {
      this.skipWhitespace();

      if (this.text[this.position] !== '"') {
        throw new SyntaxError(`Expected a property name at position ${String(this.position)}.`);
      }

      this.out.push(escapeString(this.readString()), ': ');

      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      this.writeValue(depth + 1);
      this.skipWhitespace();

      if (this.text[this.position] === ',') {
        this.position++;
        this.out.push(', ');
        continue;
      }

      this.expect('}');
      this.out.push('}');
      return;
    }
  }

  private writeArray(depth: number): void {
    this.position++; // past '['
    this.out.push('[');
    this.skipWhitespace();

    if (this.text[this.position] === ']') {
      this.position++;
      this.out.push(']');
      return;
    }

    for (;;) {
      this.skipWhitespace();
      this.writeValue(depth + 1);
      this.skipWhitespace();

      if (this.text[this.position] === ',') {
        this.position++;
        this.out.push(', ');
        continue;
      }

      this.expect(']');
      this.out.push(']');
      return;
    }
  }

  /** Reads a string literal and gives its decoded value. */
  private readString(): string {
    const start = this.position;
    this.position++; // past the opening quote

    let hasEscape = false;

    while (this.position < this.text.length) {
      const character = this.text[this.position]!;

      if (character === '\\') {
        hasEscape = true;
        this.position += 2;
        continue;
      }

      if (this.text.charCodeAt(this.position) < 0x20) {
        throw new SyntaxError(
          `Unescaped control character in a string at position ${String(this.position)}.`,
        );
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

  private writeNumber(): void {
    const start = this.position;

    while (this.position < this.text.length && /[-+.\deE]/.test(this.text[this.position]!)) {
      this.position++;
    }

    const raw = this.text.slice(start, this.position);

    if (!JSON_NUMBER.test(raw)) {
      throw new SyntaxError(`Expected a value at position ${String(start)}.`);
    }

    this.out.push(raw);
  }

  private writeLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.position)) {
      throw new SyntaxError(`Expected '${literal}' at position ${String(this.position)}.`);
    }

    this.position += literal.length;
    this.out.push(literal);
  }

  private expect(character: string): void {
    if (this.text[this.position] !== character) {
      throw new SyntaxError(`Expected '${character}' at position ${String(this.position)}.`);
    }

    this.position++;
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length) {
      const character = this.text[this.position];

      if (character === ' ' || character === '\n' || character === '\r' || character === '\t') {
        this.position++;
        continue;
      }

      return;
    }
  }
}
