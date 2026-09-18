/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { delimitIdentifier } from './sql-syntax.js';

/**
 * How the server may store a large value of one `string`, `bytes`, or array column. The names and
 * the behavior follow PostgreSQL's column storage modes. A column declares its strategy with
 * `STORAGE PLAIN | MAIN | EXTERNAL | EXTENDED`, and changes it with
 * `ALTER TABLE t ALTER COLUMN c SET STORAGE …`.
 *
 * The strategy decides the form of future writes only. Every stored row records, per cell, whether
 * the cell is compressed and whether it is stored out of the row, and a read follows those marks. So
 * a change of strategy never changes a query result and never makes an old row unreadable.
 * `ALTER TABLE t REWRITE STORAGE` converts the rows that already exist.
 *
 * The server refuses a strategy on a column of any other type with `CADB0414`
 * (`ColumnStorageNotApplicable`).
 *
 * The member values are the SQL keywords, so a member goes into a statement as it is.
 */
export const CamusColumnStorage = {
  /**
   * The server default. Compress the value when compression pays, then move it out of the row when
   * the stored form is still at or above `large_value_threshold_bytes` (2048 by default).
   */
  Extended: 'EXTENDED',

  /**
   * Never compress, and never move out of the row. Use it for a value that every query reads and
   * that does not compress, such as an embedding that a KNN query scans.
   */
  Plain: 'PLAIN',

  /** Compress the value when compression pays, and always keep it inside the row. */
  Main: 'MAIN',

  /**
   * Never compress. Move the value out of the row when it is at or above the threshold. Use it for a
   * large value that does not compress and that most queries skip: an image, an archive.
   */
  External: 'EXTERNAL',
} as const;

export type CamusColumnStorage = (typeof CamusColumnStorage)[keyof typeof CamusColumnStorage];

const STORAGE_KEYWORDS: ReadonlySet<string> = new Set(Object.values(CamusColumnStorage));

/** True when the value is one of the `CamusColumnStorage` keywords, in its exact spelling. */
export function isColumnStorage(value: unknown): value is CamusColumnStorage {
  return typeof value === 'string' && STORAGE_KEYWORDS.has(value);
}

/**
 * The statement that changes the storage strategy of one column.
 *
 * ```ts
 * await client.executeDdl(setColumnStorageStatement('docs', 'thumbnail', CamusColumnStorage.Plain));
 * ```
 *
 * It changes the form of future writes only, and returns at once. CamusDB has no `RESET STORAGE`, so
 * to go back to the default, set `CamusColumnStorage.Extended`.
 *
 * @throws {TypeError} when a name cannot be delimited, or when `storage` is not a known strategy.
 */
export function setColumnStorageStatement(
  table: string,
  column: string,
  storage: CamusColumnStorage,
): string {
  if (!isColumnStorage(storage)) {
    throw new TypeError(
      `'${String(storage)}' is not a CamusDB column storage strategy. Expected PLAIN, MAIN, EXTERNAL or EXTENDED.`,
    );
  }

  return (
    `ALTER TABLE ${delimitIdentifier(table, 'table')} ` +
    `ALTER COLUMN ${delimitIdentifier(column, 'column')} SET STORAGE ${storage}`
  );
}

/**
 * The statement that converts the rows a table already stores to its current storage rules:
 * `ALTER TABLE t REWRITE STORAGE`.
 *
 * With `inline`, it is `REWRITE STORAGE INLINE` instead. That stores every value inside its row and
 * uncompressed, which is the form a server without large-value storage can read.
 *
 * @throws {TypeError} when the table name cannot be delimited.
 */
export function rewriteStorageStatement(table: string, options: { inline?: boolean } = {}): string {
  return `ALTER TABLE ${delimitIdentifier(table, 'table')} REWRITE STORAGE${options.inline === true ? ' INLINE' : ''}`;
}
