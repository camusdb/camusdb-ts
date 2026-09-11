/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { ColumnType, columnTypeName } from './column-type.js';
import type { ColumnValue } from './column-value.js';
import { NULL_VALUE } from './column-value.js';
import type { DecodeOptions } from './values/decode.js';
import { decodeValue } from './values/decode.js';

/** One output column of a query. */
export interface CamusColumn {
  /** The column name, in the case the query wrote it. */
  readonly name: string;

  /** The declared wire type. */
  readonly type: ColumnType;

  /** The type's name, for display. */
  readonly typeName: string;
}

/**
 * The rows of one query, held positionally.
 *
 * Cells live in a single flat array, row-major: cell `(row, column)` is at
 * `row * columnCount + column`. The column names and declared types come from the response's
 * authoritative schema, so the shape is known even when there are no rows — which is what lets a
 * caller read `columns` before reading a row, and what makes an empty result still describe
 * itself.
 */
export class CamusResultSet {
  /** An empty result: no rows and no columns. Shared, so a count-only reply allocates nothing. */
  static readonly EMPTY = new CamusResultSet([], [], [], 0);

  readonly columnNames: readonly string[];

  readonly columnTypes: readonly ColumnType[];

  readonly rowCount: number;

  private readonly cells: readonly ColumnValue[];

  constructor(
    columnNames: readonly string[],
    columnTypes: readonly ColumnType[],
    cells: readonly ColumnValue[],
    rowCount: number,
  ) {
    this.columnNames = columnNames;
    this.columnTypes = columnTypes;
    this.cells = cells;
    this.rowCount = rowCount;
  }

  get columnCount(): number {
    return this.columnNames.length;
  }

  /** The output columns, in order. */
  get columns(): CamusColumn[] {
    return this.columnNames.map((name, index) => ({
      name,
      type: this.columnTypes[index] ?? ColumnType.Null,
      typeName: columnTypeName(this.columnTypes[index] ?? ColumnType.Null),
    }));
  }

  /** One raw cell. */
  cell(row: number, column: number): ColumnValue {
    return this.cells[row * this.columnCount + column] ?? NULL_VALUE;
  }

  /** One row as raw cells. */
  rawRow(row: number): ColumnValue[] {
    const start = row * this.columnCount;
    return this.cells.slice(start, start + this.columnCount);
  }
}

/**
 * Turns positional cells into a plain object, keyed by column name.
 *
 * A duplicate column name — which a join projection can produce — keeps the leftmost column, and
 * the ones after it are reachable at `name_2`, `name_3`, and so on. Silently dropping a column
 * would lose data the query asked for.
 */
export class RowMapper {
  private readonly keys: string[];

  private readonly options: DecodeOptions;

  constructor(columnNames: readonly string[], options: DecodeOptions) {
    this.options = options;
    this.keys = new Array<string>(columnNames.length);

    const used = new Map<string, number>();

    for (let i = 0; i < columnNames.length; i++) {
      const name = columnNames[i] ?? `column_${String(i + 1)}`;
      const seen = used.get(name) ?? 0;

      used.set(name, seen + 1);
      this.keys[i] = seen === 0 ? name : `${name}_${String(seen + 1)}`;
    }
  }

  /** The object keys this mapper writes, in column order. */
  get columnKeys(): readonly string[] {
    return this.keys;
  }

  /** One row as an object. */
  map<T>(cells: readonly ColumnValue[]): T {
    const row: Record<string, unknown> = {};

    for (let i = 0; i < this.keys.length; i++) {
      row[this.keys[i]!] = decodeValue(cells[i] ?? NULL_VALUE, this.options);
    }

    return row as T;
  }

  /** Every row of a result set as objects. */
  mapAll<T>(resultSet: CamusResultSet): T[] {
    const columnCount = resultSet.columnCount;
    const rows: T[] = new Array<T>(resultSet.rowCount);

    for (let r = 0; r < resultSet.rowCount; r++) {
      const row: Record<string, unknown> = {};

      for (let c = 0; c < columnCount; c++) {
        row[this.keys[c]!] = decodeValue(resultSet.cell(r, c), this.options);
      }

      rows[r] = row as T;
    }

    return rows;
  }
}
