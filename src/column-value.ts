/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { ColumnType } from './column-type.js';

/**
 * The wire representation of one CamusDB column value. It mirrors the server's
 * `CamusDB.Core.CommandsExecutor.Models.ColumnValue`, field for field, and is what the REST body
 * carries for a bound parameter.
 *
 * Backing storage per type:
 *
 * - `Integer64` — `longValue` (a `bigint`, because the range is 64 bits).
 * - `Float64` and `Float32` — `floatValue`.
 * - `Bool` — `boolValue`.
 * - `String` and `Id` — `strValue`.
 * - `Date` and `DateTime` — `longValue` as UTC .NET ticks. `Date` is truncated to midnight.
 * - `Bytes` — `bytesValue`. JSON carries it as base64.
 * - `Array` — `arrayValues` plus `arrayElementType`.
 * - `Uuid` — the 128-bit value split into two big-endian 64-bit halves: the high bits in
 *   `uuidHigh` and the low bits in `longValue`. The server also sends the canonical string form in
 *   `uuidValue` for readability.
 *
 * Most callers never build one of these by hand. Pass a plain JavaScript value as a parameter, or
 * use a helper from `typed.js` when the inferred type is not the one you want.
 */
export interface ColumnValue {
  type: ColumnType;
  strValue?: string | null;
  longValue?: bigint;
  floatValue?: number;
  boolValue?: boolean;
  bytesValue?: Uint8Array | null;
  arrayValues?: ColumnValue[] | null;
  arrayElementType?: ColumnType;

  /**
   * The ISO-8601 rendering the server includes in a response for `Date` (`yyyy-MM-dd`) and
   * `DateTime` (round-trip `o`). Read-only: the canonical value is `longValue`. The driver never
   * sends it back.
   */
  isoValue?: string | null;

  /** High 64 bits of a `Uuid` value. The low 64 bits are in `longValue`. */
  uuidHigh?: bigint;

  /** The canonical lowercase hyphenated form of a `Uuid` value, as the server sends it. */
  uuidValue?: string | null;
}

/** The shared `Null` value. Every `Null` cell is this object, so a decode allocates nothing. */
export const NULL_VALUE: ColumnValue = Object.freeze({ type: ColumnType.Null });

/**
 * The JSON body shape for a `ColumnValue`.
 *
 * It differs from the in-memory shape in one way: `bytesValue` is written as base64. A `bigint`
 * stays a `bigint` and is written as the bare digits of a JSON number by `stringifyLossless`, so a
 * 64-bit value never passes through a JavaScript number and never loses precision.
 */
export interface ColumnValueJson {
  type: number;
  strValue?: string | null;
  longValue?: bigint;
  floatValue?: number;
  boolValue?: boolean;
  bytesValue?: string | null;
  arrayValues?: ColumnValueJson[] | null;
  arrayElementType?: number;
  uuidHigh?: bigint;
  uuidValue?: string | null;
}

/**
 * Renders a value for a REST request body.
 *
 * Only the fields the declared type reads are written. The server tolerates the others, but a
 * request that carries them is larger for no gain, and a bound parameter is on the hot path.
 */
export function columnValueToJson(value: ColumnValue): ColumnValueJson {
  const json: ColumnValueJson = { type: value.type };

  switch (value.type) {
    case ColumnType.Null:
      return json;

    case ColumnType.Id:
    case ColumnType.String:
      json.strValue = value.strValue ?? '';
      return json;

    case ColumnType.Integer64:
      json.longValue = value.longValue ?? 0n;
      return json;

    case ColumnType.Float64:
    case ColumnType.Float32:
      json.floatValue = value.floatValue ?? 0;
      return json;

    case ColumnType.Bool:
      json.boolValue = value.boolValue ?? false;
      return json;

    case ColumnType.Bytes:
      json.bytesValue = value.bytesValue ? Buffer.from(value.bytesValue).toString('base64') : '';
      return json;

    case ColumnType.Date:
    case ColumnType.DateTime:
      json.longValue = value.longValue ?? 0n;
      return json;

    case ColumnType.Uuid:
      // The server accepts the canonical string and re-splits it into the halves on its side. The
      // halves travel too, so a value built from raw halves needs no string form at all.
      if (value.strValue != null) json.strValue = value.strValue;
      if (value.uuidValue != null) json.uuidValue = value.uuidValue;
      json.uuidHigh = value.uuidHigh ?? 0n;
      json.longValue = value.longValue ?? 0n;
      return json;

    case ColumnType.Array:
      json.arrayElementType = value.arrayElementType ?? ColumnType.Null;
      json.arrayValues = (value.arrayValues ?? []).map(columnValueToJson);
      return json;

    default:
      return json;
  }
}
