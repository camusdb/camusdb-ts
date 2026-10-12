/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { ColumnType, isColumnType } from '../column-type.js';
import type { ColumnValue } from '../column-value.js';
import { NULL_VALUE } from '../column-value.js';
import { asBigInt, asNumber } from '../json.js';
import { CamusResultSet } from '../result-set.js';

/**
 * Decodes the compact-raw wire form of a query result.
 *
 * The response carries an authoritative `columns` schema plus positional `rows`, where each row is
 * a JSON array aligned to `columns`. Decoding from the schema, rather than by looking at the first
 * row, is what lets a result with no rows still report its column count, names, and types.
 */
export function resultSetFromWire(columns: unknown, rows: unknown): CamusResultSet {
  const { names, types, elementTypes } = readSchema(columns);

  if (!Array.isArray(rows) || names.length === 0) {
    return new CamusResultSet(names, types, [], 0);
  }

  const columnCount = names.length;
  const rowCount = rows.length;
  const cells: ColumnValue[] = new Array<ColumnValue>(rowCount * columnCount).fill(NULL_VALUE);

  for (let r = 0; r < rowCount; r++) {
    const row = rows[r] as unknown;
    if (!Array.isArray(row)) continue;

    const base = r * columnCount;
    const limit = Math.min(columnCount, row.length);

    for (let c = 0; c < limit; c++) {
      cells[base + c] = decodeCell(row[c] as unknown, types[c]!, elementTypes[c]);
    }

    // Any position the row omitted keeps the null the array was filled with.
  }

  return new CamusResultSet(names, types, cells, rowCount);
}

/** The output columns of a response's `columns` element. */
export interface WireSchema {
  names: string[];
  types: ColumnType[];

  /**
   * The element type of each `Array` column, and `Null` for every other column. A server that
   * predates the `elementType` field reports none, so every entry is `Null` from one.
   */
  elementTypes: ColumnType[];
}

/** The output column names, declared types, and array element types of a `columns` element. */
export function readSchema(columns: unknown): WireSchema {
  if (!Array.isArray(columns)) return { names: [], types: [], elementTypes: [] };

  const names: string[] = new Array<string>(columns.length);
  const types: ColumnType[] = new Array<ColumnType>(columns.length);
  const elementTypes: ColumnType[] = new Array<ColumnType>(columns.length);

  for (let i = 0; i < columns.length; i++) {
    const column = columns[i] as { name?: unknown; type?: unknown; elementType?: unknown } | null;

    names[i] = typeof column?.name === 'string' ? column.name : '';

    const type = asNumber(column?.type, ColumnType.Null);
    types[i] = isColumnType(type) ? type : ColumnType.Null;

    // An array of arrays is not a column type, so a nested element type is read as unknown rather
    // than trusted.
    const elementType = asNumber(column?.elementType, ColumnType.Null);
    elementTypes[i] =
      types[i] === ColumnType.Array && isColumnType(elementType) && elementType !== ColumnType.Array
        ? elementType
        : ColumnType.Null;
  }

  return { names, types, elementTypes };
}

/**
 * Decodes one positional cell against its declared type.
 *
 * A JSON `null` is the null value for every column type. The types that arrive as a string or an
 * array — `Id`, `Bytes`, `Date`, `DateTime`, `Uuid`, `Array` — rely on the declared type being
 * exact, which it always is for a real column reference. A scalar that arrives as a JSON-native
 * value is read by its token instead, so an over-broad inferred type on an expression column — a
 * numeric projection reported as a string, say — still round-trips.
 *
 * `elementType` is the schema's element type for an `Array` column, and `Null` when the server did
 * not report one.
 */
export function decodeCell(
  cell: unknown,
  declared: ColumnType,
  elementType: ColumnType = ColumnType.Null,
): ColumnValue {
  if (cell === null || cell === undefined) return NULL_VALUE;

  switch (declared) {
    case ColumnType.Id:
      return { type: ColumnType.Id, strValue: typeof cell === 'string' ? cell : stringifyScalar(cell) };

    case ColumnType.Bytes:
      return { type: ColumnType.Bytes, bytesValue: decodeBase64(cell) };

    case ColumnType.Date:
      return { type: ColumnType.Date, longValue: asBigInt(cell) };

    case ColumnType.DateTime:
      return { type: ColumnType.DateTime, longValue: asBigInt(cell) };

    case ColumnType.Uuid:
      return decodeUuidCell(cell);

    case ColumnType.Numeric:
      return decodeNumericCell(cell, declared);

    case ColumnType.Array:
      return decodeArrayCell(cell, elementType);

    default:
      // A defensive recovery for a gap in the server's type inference: a join projection can
      // report a uuid column's type as a string while still sending the two-int64 wire form. A
      // scalar cell never legitimately arrives as a JSON array, so a two-element array here is
      // that mis-tagged UUID. Decode it structurally rather than trusting the declared type and
      // dropping the value.
      if (Array.isArray(cell) && cell.length === 2) return decodeUuidCell(cell);

      return decodeScalarByToken(cell, declared);
  }
}

/** A `uuid` is wired as `[high, low]`, two big-endian 64-bit halves. A string is accepted too. */
function decodeUuidCell(cell: unknown): ColumnValue {
  if (Array.isArray(cell) && cell.length === 2) {
    return {
      type: ColumnType.Uuid,
      uuidHigh: asBigInt(cell[0]),
      longValue: asBigInt(cell[1]),
    };
  }

  if (typeof cell === 'string') return { type: ColumnType.Uuid, uuidValue: cell };

  return NULL_VALUE;
}

/**
 * A `numeric` is wired as a JSON string with its canonical decimal text. A JSON number can also
 * arrive in a `numeric` column: for a NULL `p`, `SELECT COALESCE(p, 0)` gives the int64 `0` while
 * the column metadata says numeric. An integer token is exact, so it becomes a `Numeric` with its
 * digits. A fraction token reads back as the shortest text of its double.
 */
function decodeNumericCell(cell: unknown, declared: ColumnType): ColumnValue {
  switch (typeof cell) {
    case 'string':
      return { type: ColumnType.Numeric, strValue: cell };

    case 'number':
    case 'bigint':
      return { type: ColumnType.Numeric, strValue: String(cell) };

    default:
      return decodeScalarByToken(cell, declared);
  }
}

/**
 * Decodes an array cell.
 *
 * Elements are plain JSON values in the scalar wire forms: a date as ticks, bytes as base64, a uuid
 * as `[high, low]`. With the column's element type from the schema, each element is decoded as a
 * cell of that type, so the array matches what gRPC returns.
 *
 * A server that predates the schema field reports no element type, and the elements are read from
 * their JSON tokens instead. That is exact for every element type JSON has a token for, and two
 * further cases are inferred safely: a `[high, low]` pair can only be a uuid, and a fraction or a
 * negative zero can only come from a float array, so every number in that array is a float. A
 * date, bytes, or a whole-numbered float array is not reconstructed, and reaches the caller as the
 * string or number the token held.
 */
function decodeArrayCell(cell: unknown, elementType: ColumnType): ColumnValue {
  if (!Array.isArray(cell)) return NULL_VALUE;

  const values: ColumnValue[] = new Array<ColumnValue>(cell.length);

  if (elementType !== ColumnType.Null) {
    for (let i = 0; i < cell.length; i++) values[i] = decodeCell(cell[i] as unknown, elementType);

    return { type: ColumnType.Array, arrayValues: values, arrayElementType: elementType };
  }

  const numberType = cell.some(isFloatToken) ? ColumnType.Float64 : ColumnType.Null;
  let inferred: ColumnType = ColumnType.Null;

  for (let i = 0; i < cell.length; i++) {
    const item = cell[i] as unknown;

    const decoded =
      Array.isArray(item) && item.length === 2 ? decodeUuidCell(item) : decodeScalarByToken(item, numberType);

    if (decoded.type !== ColumnType.Null) inferred = decoded.type;
    values[i] = decoded;
  }

  return { type: ColumnType.Array, arrayValues: values, arrayElementType: inferred };
}

/** True for a JSON number an `int64` cannot hold: a fraction, or a negative zero. */
function isFloatToken(item: unknown): boolean {
  return typeof item === 'number' && (!Number.isInteger(item) || Object.is(item, -0));
}

function decodeScalarByToken(cell: unknown, declared: ColumnType): ColumnValue {
  switch (typeof cell) {
    case 'string':
      return { type: ColumnType.String, strValue: cell };

    case 'boolean':
      return { type: ColumnType.Bool, boolValue: cell };

    case 'bigint':
      if (declared === ColumnType.Float64 || declared === ColumnType.Float32) {
        return decodeFloat(Number(cell), declared);
      }

      return { type: ColumnType.Integer64, longValue: cell };

    case 'number':
      if (declared === ColumnType.Float64 || declared === ColumnType.Float32) {
        return decodeFloat(cell, declared);
      }

      return Number.isInteger(cell)
        ? { type: ColumnType.Integer64, longValue: BigInt(cell) }
        : { type: ColumnType.Float64, floatValue: cell };

    default:
      return NULL_VALUE;
  }
}

/**
 * A float cell. The server writes a `float32` as the shortest text that names it, which read as a
 * double is a nearby double rather than the stored value: `-9.321863E+23` is not a `float32`.
 * Rounding it back to single precision recovers the stored value, which is what gRPC returns.
 */
function decodeFloat(value: number, declared: ColumnType): ColumnValue {
  return { type: declared, floatValue: declared === ColumnType.Float32 ? Math.fround(value) : value };
}

/**
 * An `id` cell that did not arrive as a string. The server always sends one as text, so this is a
 * defence against a malformed reply rather than a path a healthy server takes.
 */
function stringifyScalar(cell: unknown): string {
  switch (typeof cell) {
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(cell);
    default:
      return '';
  }
}

function decodeBase64(cell: unknown): Uint8Array {
  if (typeof cell !== 'string') return new Uint8Array(0);

  const buffer = Buffer.from(cell, 'base64');
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
