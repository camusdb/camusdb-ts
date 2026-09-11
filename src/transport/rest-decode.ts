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
  const { names, types } = readSchema(columns);

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
      cells[base + c] = decodeCell(row[c] as unknown, types[c]!);
    }

    // Any position the row omitted keeps the null the array was filled with.
  }

  return new CamusResultSet(names, types, cells, rowCount);
}

/** The output column names and declared types of a response's `columns` element. */
export function readSchema(columns: unknown): { names: string[]; types: ColumnType[] } {
  if (!Array.isArray(columns)) return { names: [], types: [] };

  const names: string[] = new Array<string>(columns.length);
  const types: ColumnType[] = new Array<ColumnType>(columns.length);

  for (let i = 0; i < columns.length; i++) {
    const column = columns[i] as { name?: unknown; type?: unknown } | null;

    names[i] = typeof column?.name === 'string' ? column.name : '';

    const type = asNumber(column?.type, ColumnType.Null);
    types[i] = isColumnType(type) ? type : ColumnType.Null;
  }

  return { names, types };
}

/**
 * Decodes one positional cell against its declared type.
 *
 * A JSON `null` is the null value for every column type. The types that arrive as a string or an
 * array — `Id`, `Bytes`, `Date`, `DateTime`, `Uuid`, `Array` — rely on the declared type being
 * exact, which it always is for a real column reference. A scalar that arrives as a JSON-native
 * value is read by its token instead, so an over-broad inferred type on an expression column — a
 * numeric projection reported as a string, say — still round-trips.
 */
export function decodeCell(cell: unknown, declared: ColumnType): ColumnValue {
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

    case ColumnType.Array:
      return decodeArrayCell(cell);

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
 * Decodes an array cell.
 *
 * The wire schema carries no per-element type for an array, so element types are read from the
 * JSON token. That is exact for every element type JSON has a token for. An element type that is
 * itself string-encoded or array-encoded — a uuid, a date, or bytes inside an array — is not
 * reconstructed, and reaches the caller as the string or number the token held.
 */
function decodeArrayCell(cell: unknown): ColumnValue {
  if (!Array.isArray(cell)) return NULL_VALUE;

  const values: ColumnValue[] = new Array<ColumnValue>(cell.length);
  let elementType: ColumnType = ColumnType.Null;

  for (let i = 0; i < cell.length; i++) {
    const decoded = decodeScalarByToken(cell[i] as unknown, ColumnType.Null);
    if (decoded.type !== ColumnType.Null) elementType = decoded.type;
    values[i] = decoded;
  }

  return { type: ColumnType.Array, arrayValues: values, arrayElementType: elementType };
}

function decodeScalarByToken(cell: unknown, declared: ColumnType): ColumnValue {
  switch (typeof cell) {
    case 'string':
      return { type: ColumnType.String, strValue: cell };

    case 'boolean':
      return { type: ColumnType.Bool, boolValue: cell };

    case 'bigint':
      return { type: ColumnType.Integer64, longValue: cell };

    case 'number':
      if (declared === ColumnType.Float64 || declared === ColumnType.Float32) {
        return { type: declared, floatValue: cell };
      }

      return Number.isInteger(cell)
        ? { type: ColumnType.Integer64, longValue: BigInt(cell) }
        : { type: ColumnType.Float64, floatValue: cell };

    default:
      return NULL_VALUE;
  }
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
