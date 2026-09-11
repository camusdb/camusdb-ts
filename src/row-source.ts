/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { ColumnType } from './column-type.js';
import type { ColumnValue } from './column-value.js';
import type { CamusResultSet } from './result-set.js';

/**
 * Where a query's rows come from.
 *
 * It abstracts the delivery mode so the row mapper is written once and works for both:
 *
 * - A buffered source over a whole `CamusResultSet` — what the ordinary query endpoint returns,
 *   and what a write statement's affected-row count is wrapped in.
 * - The streaming NDJSON source, which pulls rows off the network one line at a time as the caller
 *   advances, so a result of many thousands of rows never fully materializes on this side.
 *
 * The schema is always known up front. The streaming source reads the NDJSON header line before
 * the caller sees a row, so column names and types are reportable before, and independently of,
 * the first row.
 */
export interface CamusRowSource extends AsyncDisposable {
  /** Output column names, aligned with `columnTypes`. */
  readonly columnNames: readonly string[];

  /** Declared column types, aligned with `columnNames`. */
  readonly columnTypes: readonly ColumnType[];

  /** The affected-row count for a write statement, or -1 for a query. */
  readonly recordsAffected: number;

  /** Advances to the next row and reports its cells, or `undefined` at the end of the result. */
  next(): Promise<readonly ColumnValue[] | undefined>;

  /** Releases the underlying response. Safe to call more than once. */
  close(): Promise<void>;
}

/** A source over a result set that is already in memory. */
export class BufferedRowSource implements CamusRowSource {
  private readonly resultSet: CamusResultSet;

  private position = -1;

  readonly recordsAffected: number;

  constructor(resultSet: CamusResultSet, recordsAffected = -1) {
    this.resultSet = resultSet;
    this.recordsAffected = recordsAffected;
  }

  get columnNames(): readonly string[] {
    return this.resultSet.columnNames;
  }

  get columnTypes(): readonly ColumnType[] {
    return this.resultSet.columnTypes;
  }

  next(): Promise<readonly ColumnValue[] | undefined> {
    this.position++;

    if (this.position >= this.resultSet.rowCount) return Promise.resolve(undefined);

    return Promise.resolve(this.resultSet.rawRow(this.position));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
