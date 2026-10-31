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
 * `bigint` as the bare digits a JSON number is. It also writes a negative zero as `-0`, where
 * `JSON.stringify` writes `0` and so turns a bound `-0.0` into a positive zero on the server.
 * Everything else behaves exactly as the built-in functions do.
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
 * The source text of one JSON value, kept as the server wrote it. `parseWithRawCells` gives one for
 * each cell whose exact text matters: a JSONB document, whose numbers keep their scale (`2.50`) and
 * whose keys keep their order only as text.
 */
export class RawJson {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

/** The cells of a result that `parseWithRawCells` keeps as `RawJson`. */
export interface RawCellPlan {
  /**
   * The properties of the top-level object whose value is a list of rows. Leave it out when the
   * text is one row, as an NDJSON row line is.
   */
  readonly rowsKeys?: readonly string[] | undefined;

  /** The positions, inside a row, of the cells to keep as text. */
  readonly columns: ReadonlySet<number>;
}

/**
 * Parses JSON text as `parseLossless` does, but keeps each cell that `plan` names as a `RawJson`.
 * It always uses the parser written in JavaScript, so use it only for a result that has such a cell.
 */
export function parseWithRawCells(text: string, plan: RawCellPlan): unknown {
  return new LosslessParser(text, plan).parse();
}

/**
 * Serializes a value as JSON, writing a `bigint` as a JSON number and a negative zero as `-0`.
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

/**
 * The deepest JSON value this module reads or writes. A JSONB document can have 512 levels
 * (`CADB0419` above that), and a response puts a few levels of its own around a document.
 */
export const MAX_JSON_DEPTH = 512 + 16;

const MAX_DEPTH = MAX_JSON_DEPTH;

function writeValue(value: unknown, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new TypeError(`Cannot serialize a value nested more than ${String(MAX_DEPTH)} levels deep.`);
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
      // `String(-0)` is `'0'`. The server reads `-0` as the negative zero it is, into a float or
      // an integer field alike.
      if (Object.is(value, -0)) out.push('-0');
      else out.push(Number.isFinite(value) ? String(value) : 'null');
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

/**
 * Writes the properties of an object or the entries of a `Map`.
 *
 * A `Map` entry whose key is not a string is skipped: JSON names a property with a string, and no
 * coercion of an arbitrary key would round-trip. `JSON.stringify` has no `Map` support at all, so
 * this is an addition of this module rather than a difference from the built-in function.
 */
function writeEntries(entries: IterableIterator<[unknown, unknown]>, out: string[], depth: number): void {
  out.push('{');
  let first = true;

  for (const [key, rawValue] of entries) {
    if (typeof key !== 'string') continue;

    // `toJSON` is resolved before the test, because `JSON.stringify` omits a property whose
    // `toJSON` reports `undefined` rather than writing null for it.
    const entryValue = toJsonValue(rawValue);
    if (isOmitted(entryValue)) continue;

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

/** The result of a value's own `toJSON`, or the value itself when it has none. */
function toJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  const object = value as { toJSON?: () => unknown };

  return typeof object.toJSON === 'function' ? object.toJSON() : value;
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

/**
 * An unpaired surrogate matches the last two branches.
 *
 * A JavaScript string can hold one half of a surrogate pair, and a UTF-8 encoder replaces such a
 * half with U+FFFD. Written raw, the server would therefore store a different string than the
 * caller bound. Escaped as `\uXXXX`, the half survives the encoding, which is what
 * `JSON.stringify` does. A matched pair is left as it is, so ordinary text outside the basic
 * plane is not inflated.
 */
/* eslint-disable no-control-regex -- JSON requires these characters to be escaped. */
const NEEDS_ESCAPE =
  /["\\\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const ESCAPE_ALL =
  /["\\\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/* eslint-enable no-control-regex */

function quote(value: string): string {
  if (!NEEDS_ESCAPE.test(value)) return `"${value}"`;

  return `"${value.replace(ESCAPE_ALL, (character) => {
    const escape = ESCAPES[character];
    if (escape !== undefined) return escape;

    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  })}"`;
}

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * What a value is in a `RawCellPlan`: an ordinary value, the top-level object that holds the row
 * lists, a list of rows, or one row.
 */
type Role = 'value' | 'body' | 'rows' | 'row';

/**
 * A recursive-descent JSON reader. It is used for text that holds a long integer run, and for a
 * result whose cells a `RawCellPlan` keeps as text.
 */
class LosslessParser {
  private readonly text: string;

  private readonly plan: RawCellPlan | undefined;

  private position = 0;

  constructor(text: string, plan?: RawCellPlan) {
    this.text = text;
    this.plan = plan;
  }

  parse(): unknown {
    const role: Role = this.plan === undefined ? 'value' : this.plan.rowsKeys === undefined ? 'row' : 'body';

    this.skipWhitespace();
    const value = this.readValue(0, role);
    this.skipWhitespace();

    if (this.position < this.text.length) {
      throw new SyntaxError(`Unexpected text after the JSON value at position ${String(this.position)}.`);
    }

    return value;
  }

  private readValue(depth: number, role: Role = 'value'): unknown {
    if (depth > MAX_DEPTH) {
      throw new SyntaxError(`The JSON value is nested more than ${String(MAX_DEPTH)} levels deep.`);
    }

    const character = this.text[this.position];

    switch (character) {
      case '{':
        return this.readObject(depth, role === 'body');
      case '[':
        return this.readArray(depth, role);
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

  private readObject(depth: number, isBody: boolean): Record<string, unknown> {
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

      const role: Role = isBody && this.plan?.rowsKeys?.includes(key) === true ? 'rows' : 'value';
      const value = this.readValue(depth + 1, role);

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

  private readArray(depth: number, role: Role): unknown[] {
    const array: unknown[] = [];

    this.position++; // past '['
    this.skipWhitespace();

    if (this.text[this.position] === ']') {
      this.position++;
      return array;
    }

    const itemRole: Role = role === 'rows' ? 'row' : 'value';
    const rawColumns = role === 'row' ? this.plan?.columns : undefined;

    for (;;) {
      this.skipWhitespace();

      if (rawColumns?.has(array.length) === true) {
        const start = this.position;
        this.readValue(depth + 1);
        array.push(new RawJson(this.text.slice(start, this.position)));
      } else {
        array.push(this.readValue(depth + 1, itemRole));
      }

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

      // JSON requires a control character inside a string to be escaped, and `JSON.parse` refuses
      // a raw one. The slow path must refuse it too, or the same text would decode differently
      // depending on which path a long digit run sent it down.
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

    // The same grammar `JSON.parse` reads: no leading zero, no empty fraction, no bare exponent.
    if (!JSON_NUMBER.test(raw)) {
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
