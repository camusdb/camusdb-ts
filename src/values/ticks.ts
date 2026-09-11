/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * Converts between a JavaScript `Date` and the .NET tick count CamusDB stores for a `Date` or a
 * `DateTime` column.
 *
 * A tick is 100 nanoseconds. Tick zero is 0001-01-01T00:00:00 UTC. A `Date` holds whole
 * milliseconds since 1970-01-01T00:00:00 UTC, so the two differ by a fixed offset and by
 * resolution: 10,000 ticks make one millisecond.
 *
 * The conversion to a `Date` therefore discards sub-millisecond precision. That loss is one-way
 * and unavoidable in JavaScript. Read `ColumnValue.longValue` from the raw row when you need the
 * exact stored instant.
 */

/** Ticks in one millisecond. */
export const TICKS_PER_MILLISECOND = 10_000n;

/** Ticks in one day. */
export const TICKS_PER_DAY = 864_000_000_000n;

/** Ticks between 0001-01-01 and the Unix epoch. */
export const UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;

/** The UTC `Date` a tick count names. Sub-millisecond precision is truncated toward the past. */
export function ticksToDate(ticks: bigint): Date {
  const millis = floorDiv(ticks - UNIX_EPOCH_TICKS, TICKS_PER_MILLISECOND);
  return new Date(Number(millis));
}

/** The tick count for an instant. */
export function dateToTicks(date: Date): bigint {
  const millis = date.getTime();

  if (!Number.isFinite(millis)) {
    throw new RangeError('An invalid Date has no tick value.');
  }

  return BigInt(millis) * TICKS_PER_MILLISECOND + UNIX_EPOCH_TICKS;
}

/** The tick count for an instant, truncated to UTC midnight — what a `Date` column stores. */
export function dateToDayTicks(date: Date): bigint {
  const ticks = dateToTicks(date);
  return ticks - floorMod(ticks, TICKS_PER_DAY);
}

// BigInt division truncates toward zero, so a pre-epoch instant would round the wrong way.
function floorDiv(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

function floorMod(a: bigint, b: bigint): bigint {
  const remainder = a % b;
  return remainder !== 0n && remainder < 0n !== b < 0n ? remainder + b : remainder;
}
