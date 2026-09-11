/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * The wire type of a single CamusDB column value.
 *
 * IMPORTANT: these integer values are the wire contract with the CamusDB server
 * (`CamusDB.Core.Catalogs.Models.ColumnType`). They are persisted in schema JSON and must never be
 * renumbered or reused. New members are appended with new integers.
 */
export const ColumnType = {
  Null: 0,
  Id: 1,
  Integer64: 2,
  String: 3,
  Bool: 4,
  Float64: 5,
  Float32: 6,
  Bytes: 7,
  Date: 8,
  DateTime: 9,
  Array: 10,
  Uuid: 11,
} as const;

export type ColumnType = (typeof ColumnType)[keyof typeof ColumnType];

const NAMES: Record<number, string> = {
  0: 'Null',
  1: 'Id',
  2: 'Integer64',
  3: 'String',
  4: 'Bool',
  5: 'Float64',
  6: 'Float32',
  7: 'Bytes',
  8: 'Date',
  9: 'DateTime',
  10: 'Array',
  11: 'Uuid',
};

/** The declared type's name, for diagnostics and for `QueryResult.columns[i].typeName`. */
export function columnTypeName(type: ColumnType): string {
  return NAMES[type] ?? `Unknown(${String(type)})`;
}

/** True when `value` is one of the declared wire type numbers. */
export function isColumnType(value: unknown): value is ColumnType {
  return typeof value === 'number' && Object.hasOwn(NAMES, value);
}
