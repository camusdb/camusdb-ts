/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusColumn } from './result-set.js';
import { RowMapper } from './result-set.js';
import type { CamusRowSource } from './row-source.js';
import type { DecodeOptions } from './values/decode.js';
import { columnTypeName } from './column-type.js';

/**
 * Rows delivered one at a time, as an async iterable.
 *
 * Iterate it with `for await`. The iteration owns the underlying response, and releases it when it
 * ends — whether it ran to the last row, was left early with `break`, or was ended by a `throw`.
 * A stream that is never iterated must be released with `close`, or with `await using`.
 *
 * ```ts
 * const stream = await client.queryStream<Robot>('SELECT * FROM robots');
 *
 * for await (const robot of stream) {
 *   console.log(robot.name);
 * }
 * ```
 *
 * The schema is known before the first row, so `columns` can be read straight away.
 *
 * The streaming path gives up the buffered path's transparent retry of a serializable conflict.
 * Rows can reach this side before the statement's own short transaction commits, so a conflict
 * that surfaces late is raised from the iteration rather than retried. Use `query` — or drive an
 * explicit transaction and retry it yourself — when you need that retry.
 */
export class CamusQueryStream<T = Record<string, unknown>> implements AsyncIterable<T>, AsyncDisposable {
  private readonly source: CamusRowSource;

  private readonly mapper: RowMapper;

  private consumed = false;

  private closed = false;

  /** @internal Built by `CamusClient.queryStream`. */
  constructor(source: CamusRowSource, options: DecodeOptions) {
    this.source = source;
    this.mapper = new RowMapper(source.columnNames, options);
  }

  /** The output columns, known before the first row. */
  get columns(): CamusColumn[] {
    return this.source.columnNames.map((name, index) => ({
      name,
      type: this.source.columnTypes[index]!,
      typeName: columnTypeName(this.source.columnTypes[index]!),
    }));
  }

  /**
   * The property names each row object carries, in column order.
   *
   * They match `columns` except where a query projected the same column name twice: the leftmost
   * keeps the name, and the ones after it take `name_2`, `name_3`, and so on.
   */
  get columnKeys(): readonly string[] {
    return this.mapper.columnKeys;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) {
      throw new Error('This query stream was already iterated. Run the query again for a second pass.');
    }

    this.consumed = true;

    try {
      for (;;) {
        const cells = await this.source.next();
        if (cells === undefined) return;

        yield this.mapper.map<T>(cells);
      }
    } finally {
      // Reached on a normal end, on `break`, and on a throw, so the response is never left open.
      await this.close();
    }
  }

  /** Reads every remaining row into an array. Convenient when the result is known to be small. */
  async toArray(): Promise<T[]> {
    const rows: T[] = [];

    for await (const row of this) rows.push(row);

    return rows;
  }

  /** Releases the underlying response. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    await this.source.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
