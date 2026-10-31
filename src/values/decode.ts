/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { ColumnType } from '../column-type.js';
import type { ColumnValue } from '../column-value.js';
import { parseJsonb } from './jsonb.js';
import { ticksToDate } from './ticks.js';
import { halvesToUuid } from './uuid.js';

/**
 * How an `int64` column reaches a caller.
 *
 * - `auto` (the default) — a `number` when the value is inside the safe integer range, a `bigint`
 *   otherwise. Every value round-trips exactly, and ordinary counters and identifiers stay
 *   numbers.
 * - `number` — always a `number`. A value above 2^53 loses precision. Choose it only when the
 *   schema cannot hold one.
 * - `bigint` — always a `bigint`. Choose it when one uniform type matters more than convenience.
 */
export type Int64Mode = 'auto' | 'number' | 'bigint';

/**
 * How a `jsonb` column reaches a caller.
 *
 * - `parse` (the default) — the parsed JavaScript value: an object, an array, a string, a number, a
 *   boolean, or `null`. An integer outside the safe range is a `bigint`. A number with a fraction is
 *   a `number`, so it has about 15 significant digits and no scale (`2.50` is `2.5`).
 * - `text` — the document's JSON text in the PostgreSQL text form, for example
 *   `{"a": [1, 2.50]}`. Every digit and the key order are kept.
 */
export type JsonbMode = 'parse' | 'text';

/** How a cell is turned into a JavaScript value. */
export interface DecodeOptions {
  readonly int64: Int64Mode;

  /** How a `jsonb` column reaches the caller. Default `parse`. */
  readonly jsonb?: JsonbMode | undefined;
}

export const DEFAULT_DECODE_OPTIONS: DecodeOptions = Object.freeze({ int64: 'auto', jsonb: 'parse' });

/**
 * The JavaScript value for one cell.
 *
 * - `Null` — `null`.
 * - `Id` and `String` — `string`.
 * - `Integer64` — `number` or `bigint`, per `options.int64`.
 * - `Float64` and `Float32` — `number`.
 * - `Bool` — `boolean`.
 * - `Bytes` — `Uint8Array`.
 * - `Date` and `DateTime` — `Date`, in UTC. Sub-millisecond precision is truncated; read
 *   `longValue` from the raw row for the exact stored tick count.
 * - `Uuid` — the canonical lowercase hyphenated `string`.
 * - `Numeric` — the exact decimal `string`, for example `'12.5'`. JavaScript has no decimal type, and
 *   a `number` holds only about 15 significant digits.
 * - `Jsonb` — the parsed document, or its text, per `options.jsonb`. A document that is JSON `null`
 *   reads as `null` in `parse` mode.
 * - `Array` — an array of the values above.
 */
export function decodeValue(value: ColumnValue, options: DecodeOptions = DEFAULT_DECODE_OPTIONS): unknown {
  switch (value.type) {
    case ColumnType.Null:
      return null;

    case ColumnType.Id:
    case ColumnType.String:
    case ColumnType.Numeric:
      return value.strValue ?? '';

    case ColumnType.Integer64:
      return decodeInt64(value.longValue ?? 0n, options.int64);

    case ColumnType.Float64:
    case ColumnType.Float32:
      return value.floatValue ?? 0;

    case ColumnType.Bool:
      return value.boolValue ?? false;

    case ColumnType.Bytes:
      return value.bytesValue ?? new Uint8Array(0);

    case ColumnType.Date:
    case ColumnType.DateTime:
      return ticksToDate(value.longValue ?? 0n);

    case ColumnType.Uuid:
      return decodeUuid(value);

    case ColumnType.Jsonb:
      return options.jsonb === 'text' ? (value.strValue ?? 'null') : parseJsonb(value.strValue ?? 'null');

    case ColumnType.Array:
      return (value.arrayValues ?? []).map((item) => decodeValue(item, options));

    default:
      return null;
  }
}

function decodeInt64(value: bigint, mode: Int64Mode): number | bigint {
  switch (mode) {
    case 'bigint':
      return value;

    case 'number':
      return Number(value);

    default:
      return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value;
  }
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function decodeUuid(value: ColumnValue): string {
  const high = value.uuidHigh ?? 0n;
  const low = value.longValue ?? 0n;

  // The raw halves are authoritative. The canonical string is the fallback for a response that
  // carried only it, and for the all-zeros UUID, whose halves are indistinguishable from absent.
  if (high === 0n && low === 0n && value.uuidValue) return value.uuidValue.toLowerCase();
  if (high === 0n && low === 0n && value.strValue) return value.strValue.toLowerCase();

  return halvesToUuid(high, low);
}
