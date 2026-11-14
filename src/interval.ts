/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

const MICROS_PER_SECOND = 1_000_000n;
const MICROS_PER_MINUTE = 60n * MICROS_PER_SECOND;
const MICROS_PER_HOUR = 60n * MICROS_PER_MINUTE;

const MILLISECONDS_PER_DAY = 86_400_000;

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

/** One number of an ISO-8601 interval: an optional sign, digits, and an optional point. */
const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** The text of a JavaScript number, as `String(number)` writes it, also with an exponent. */
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

/** A decimal value as `digits / 10^scale`. */
interface Scaled {
  readonly digits: bigint;
  readonly scale: number;
}

/**
 * One SQL `interval` value: a number of months, a number of days, and a number of microseconds.
 *
 * The server keeps the three parts separate, as PostgreSQL does, because a month and a day have no
 * fixed length when they are added to a date.
 *
 * **On the wire.** An interval is the value of an expression only: no table column, array element,
 * or stored value can have this type. A query result sends it as its ISO-8601 text
 * (`P1Y2M3DT4H5M6.5S`) in a `String` column, so a row holds a `string`. Read it with
 * {@link CamusInterval.parse}. A parameter is text too, so the SQL must cast it:
 * `CAST(@p AS interval)`. A `CamusInterval` parameter binds as this text.
 *
 * **Milliseconds.** JavaScript keeps a duration as a number of milliseconds. Such a number has no
 * months, so {@link CamusInterval.toMilliseconds} refuses an interval with a month part. Keep such a
 * value, for example the result of `age(a, b)`, as a `CamusInterval`.
 *
 * **Equality.** Two values are equal when their three parts are equal. The server compares two
 * intervals by one total, where a month is 30 days and a day is 24 hours, so on the server
 * `INTERVAL 'P1M' = INTERVAL 'P30D'` is true. Here the two values are not equal.
 */
export class CamusInterval {
  /** The months part. A year is 12 months. */
  readonly months: number;

  /** The days part. */
  readonly days: number;

  /** The time part, in microseconds. */
  readonly microseconds: bigint;

  /**
   * Creates an interval from its three parts. The months and the days are 32-bit integers, and the
   * microseconds are a 64-bit integer, as on the server.
   *
   * @throws {RangeError} A part is not an integer, or it is outside its range.
   */
  constructor(months: number, days: number, microseconds: number | bigint = 0n) {
    this.months = int32(months, 'months');
    this.days = int32(days, 'days');
    this.microseconds = int64(microseconds);
  }

  /** The zero interval, `PT0S`. */
  static readonly ZERO = new CamusInterval(0, 0, 0n);

  /**
   * The interval of a duration in milliseconds: its whole days in the days part, and the rest in
   * the time part.
   *
   * The time part rounds to a whole microsecond, to even on a tie, as the server rounds the text of
   * a parameter. The driver reads the number as the shortest decimal text that gives the same
   * number, so `0.0015` is 1.5 µs and rounds to 2 µs.
   *
   * @throws {RangeError} The value is not a finite number, or its days do not fit in the days part.
   */
  static fromMilliseconds(milliseconds: number): CamusInterval {
    if (!Number.isFinite(milliseconds)) {
      throw new RangeError(`A duration of ${String(milliseconds)} milliseconds is not an interval.`);
    }

    const days = Math.trunc(milliseconds / MILLISECONDS_PER_DAY);

    // The remainder of a floating-point division is exact.
    const remainder = milliseconds % MILLISECONDS_PER_DAY;
    const scaled = readDecimal(String(remainder));

    if (scaled === undefined) {
      throw new RangeError(`A duration of ${String(milliseconds)} milliseconds is not an interval.`);
    }

    // Milliseconds to microseconds: one more factor of 1000.
    const micros = roundHalfEven(scaled.digits * 1000n, scale(scaled.scale));

    return new CamusInterval(0, days + 0, micros);
  }

  /**
   * Reads the ISO-8601 text of an interval, the form the server sends: `P1Y2M3DT4H5M6.5S`,
   * `P-1DT2H`, `PT0S`. Each number can have its own sign. Only the seconds can have a fraction,
   * which rounds to a whole microsecond, to even on a tie. The weeks (`P2W`) and the lowercase
   * letters are read too.
   *
   * @throws {SyntaxError} The text is not an ISO-8601 interval.
   * @throws {RangeError} A part is outside its range.
   */
  static parse(text: string): CamusInterval {
    const result = parseCore(text);

    if (result instanceof CamusInterval) return result;

    if (result === 'overflow') {
      throw new RangeError(`The interval '${text}' is outside the range of an interval.`);
    }

    throw new SyntaxError(`'${text}' is not an ISO-8601 interval, such as P1DT2H or PT0S.`);
  }

  /** Reads the ISO-8601 text of an interval, or gives `undefined`. See {@link CamusInterval.parse}. */
  static tryParse(text: string | null | undefined): CamusInterval | undefined {
    if (typeof text !== 'string') return undefined;

    const result = parseCore(text);
    return result instanceof CamusInterval ? result : undefined;
  }

  /**
   * The duration of this interval in milliseconds: the days times 24 hours, plus the time part. A
   * value of more than about 285 years loses digits below one microsecond, because a `number` has
   * about 15 significant digits.
   *
   * @throws {RangeError} The interval has a month part, which a duration in milliseconds cannot
   *   hold.
   */
  toMilliseconds(): number {
    if (this.months !== 0) {
      throw new RangeError(
        `The interval '${this.toString()}' has a month part, and a duration in milliseconds has no months. ` +
          'Keep the value as a CamusInterval, or remove the months in SQL with justify_days or a datetime difference.',
      );
    }

    return this.days * MILLISECONDS_PER_DAY + Number(this.microseconds) / 1000;
  }

  /**
   * The ISO-8601 text of this interval, in the form the server writes. The years and the months
   * share the sign of the months part, and the hours, the minutes, and the seconds share the sign
   * of the time part. A zero interval is `PT0S`.
   */
  toString(): string {
    if (this.months === 0 && this.days === 0 && this.microseconds === 0n) return 'PT0S';

    let text = 'P';

    const years = Math.trunc(this.months / 12);
    const months = this.months % 12;

    if (years !== 0) text += `${String(years)}Y`;
    if (months !== 0) text += `${String(months)}M`;
    if (this.days !== 0) text += `${String(this.days)}D`;

    if (this.microseconds !== 0n) {
      let micros = this.microseconds;

      const hours = micros / MICROS_PER_HOUR;
      micros -= hours * MICROS_PER_HOUR;
      const minutes = micros / MICROS_PER_MINUTE;
      micros -= minutes * MICROS_PER_MINUTE;
      const seconds = micros / MICROS_PER_SECOND;
      const fraction = micros - seconds * MICROS_PER_SECOND;

      text += 'T';

      if (hours !== 0n) text += `${hours.toString()}H`;
      if (minutes !== 0n) text += `${minutes.toString()}M`;

      if (seconds !== 0n || fraction !== 0n) {
        if (seconds < 0n || fraction < 0n) text += '-';

        text += abs(seconds).toString();

        if (fraction !== 0n) {
          text += `.${abs(fraction).toString().padStart(6, '0').replace(/0+$/, '')}`;
        }

        text += 'S';
      }
    }

    return text;
  }

  /** `toString`, so `JSON.stringify` writes an interval as the server does. */
  toJSON(): string {
    return this.toString();
  }

  /** True when the three parts are equal. */
  equals(other: CamusInterval): boolean {
    return (
      this.months === other.months && this.days === other.days && this.microseconds === other.microseconds
    );
  }
}

function parseCore(text: string): CamusInterval | 'syntax' | 'overflow' {
  const span = text.trim();

  if (span.length < 2 || (span[0] !== 'P' && span[0] !== 'p')) return 'syntax';

  let months = 0n;
  let days = 0n;

  // The time part as `micros / 10^microsScale`, so that the rounding happens once, at the end.
  let micros = 0n;
  let microsScale = 0;

  let timePart = false;
  let any = false;
  let anyTime = false;
  let i = 1;

  while (i < span.length) {
    const char = span[i];

    if (char === 'T' || char === 't') {
      if (timePart) return 'syntax';

      timePart = true;
      i++;
      continue;
    }

    const start = i;

    if (char === '+' || char === '-') i++;

    while (i < span.length && /[0-9.]/.test(span[i]!)) i++;

    if (i >= span.length) return 'syntax';

    const numberText = span.slice(start, i);
    if (!NUMBER_TEXT.test(numberText)) return 'syntax';

    const number = readDecimal(numberText)!;
    const whole = wholeValue(number);
    const designator = span[i++]!.toUpperCase();

    if (designator === 'S' && timePart) {
      // number * 10^6 microseconds, at the common scale.
      const target = Math.max(microsScale, number.scale);
      micros =
        micros * scale(target - microsScale) +
        number.digits * MICROS_PER_SECOND * scale(target - number.scale);
      microsScale = target;
    } else {
      if (whole === undefined) return 'syntax';

      if (!timePart && designator === 'Y') months += whole * 12n;
      else if (!timePart && designator === 'M') months += whole;
      else if (!timePart && designator === 'W') days += whole * 7n;
      else if (!timePart && designator === 'D') days += whole;
      else if (timePart && designator === 'H') micros += whole * MICROS_PER_HOUR * scale(microsScale);
      else if (timePart && designator === 'M') micros += whole * MICROS_PER_MINUTE * scale(microsScale);
      else return 'syntax';
    }

    any = true;
    anyTime ||= timePart;
  }

  // A 'T' must have at least one time designator after it.
  if (!any || (timePart && !anyTime)) return 'syntax';

  const rounded = roundHalfEven(micros, scale(microsScale));

  if (
    months < BigInt(INT32_MIN) ||
    months > BigInt(INT32_MAX) ||
    days < BigInt(INT32_MIN) ||
    days > BigInt(INT32_MAX) ||
    rounded < INT64_MIN ||
    rounded > INT64_MAX
  ) {
    return 'overflow';
  }

  return new CamusInterval(Number(months), Number(days), rounded);
}

/** Reads decimal text, also with an exponent, as `digits / 10^scale`. */
function readDecimal(text: string): Scaled | undefined {
  const match = DECIMAL_TEXT.exec(text);
  if (match === null) return undefined;

  const [, sign = '', integer = '', fraction = '', exponentText] = match;
  if (integer.length === 0 && fraction.length === 0) return undefined;

  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  let digits = BigInt(`${integer}${fraction}` || '0');
  let decimalScale = fraction.length - exponent;

  if (decimalScale < 0) {
    digits *= scale(-decimalScale);
    decimalScale = 0;
  }

  return { digits: sign === '-' ? -digits : digits, scale: decimalScale };
}

/** The integer value of a decimal, or `undefined` when it has a fraction. */
function wholeValue(value: Scaled): bigint | undefined {
  const divisor = scale(value.scale);
  return value.digits % divisor === 0n ? value.digits / divisor : undefined;
}

/** `numerator / denominator`, rounded to an integer, to even on a tie. */
function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator - quotient * denominator;

  if (remainder === 0n) return quotient;

  const twice = abs(remainder) * 2n;
  const away = numerator < 0n ? quotient - 1n : quotient + 1n;

  if (twice > denominator) return away;
  if (twice < denominator) return quotient;

  return quotient % 2n === 0n ? quotient : away;
}

function scale(power: number): bigint {
  return 10n ** BigInt(power);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function int32(value: number, part: string): number {
  if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
    throw new RangeError(`The ${part} part of an interval must be a 32-bit integer; got ${String(value)}.`);
  }

  // A negative zero is zero.
  return value + 0;
}

function int64(value: number | bigint): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError(
      `The microseconds part of an interval must be a safe integer or a bigint; got ${String(value)}.`,
    );
  }

  const big = BigInt(value);

  if (big < INT64_MIN || big > INT64_MAX) {
    throw new RangeError(
      `The microseconds part of an interval must be a 64-bit integer; got ${big.toString()}.`,
    );
  }

  return big;
}
