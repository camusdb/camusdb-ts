/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusResultSet } from '../result-set.js';
import { delimitIdentifier } from '../sql-syntax.js';
import type { CamusBranchRow } from './transport.js';

/**
 * The branch statements, composed as SQL, and the mapping of what they return.
 *
 * Database branching has no REST route of its own: the server implements it only as SQL, so both
 * transports compose the statement and send it down the ordinary DDL and query routes. This module
 * holds that composition once, so the two transports cannot spell a statement differently.
 *
 * A database name is a bare identifier in the grammar, so it is backtick-delimited here, and a name
 * carrying a backtick is refused rather than doubled — the server trims the delimiters instead of
 * decoding a doubled backtick, so doubling would neutralize nothing. These statements are among the
 * few this driver composes as text, and a database name can come from an application's own input.
 */

/** `CREATE DATABASE <branch> BRANCH FROM <source>`. */
export function createBranchDatabaseSql(
  branchName: string,
  sourceDatabaseName: string,
  ifNotExists: boolean,
): string {
  const prefix = ifNotExists ? 'CREATE DATABASE IF NOT EXISTS ' : 'CREATE DATABASE ';

  return `${prefix}${quote(branchName)} BRANCH FROM ${quote(sourceDatabaseName)}`;
}

/** `CREATE DATABASE <name>`. */
export function createDatabaseSql(database: string, ifNotExists: boolean): string {
  const prefix = ifNotExists ? 'CREATE DATABASE IF NOT EXISTS ' : 'CREATE DATABASE ';

  return `${prefix}${quote(database)}`;
}

/** `DROP DATABASE <name>`. */
export function dropDatabaseSql(database: string): string {
  return `DROP DATABASE ${quote(database)}`;
}

/** `SHOW BRANCHES FROM <name>`. */
export function showBranchesSql(database: string): string {
  return `SHOW BRANCHES FROM ${quote(database)}`;
}

/** `SHOW ANCESTORS FROM <name>`. */
export function showAncestorsSql(database: string): string {
  return `SHOW ANCESTORS FROM ${quote(database)}`;
}

/**
 * Reads what a branch listing returned.
 *
 * `SHOW BRANCHES` emits `[database, id, depth, parent, fork_timestamp]`, and `SHOW ANCESTORS` emits
 * the same without `parent`. The columns are read by name, so either shape reconstructs, and a
 * server that adds a column changes nothing here.
 */
export function mapBranchRows(result: CamusResultSet): CamusBranchRow[] {
  const index = new Map<string, number>();

  result.columnNames.forEach((name, position) => index.set(name, position));

  const rows: CamusBranchRow[] = [];

  for (let r = 0; r < result.rowCount; r++) {
    const text = (name: string): string | undefined => {
      const column = index.get(name);
      if (column === undefined) return undefined;

      return result.cell(r, column).strValue ?? undefined;
    };

    const depthColumn = index.get('depth');

    rows.push({
      database: text('database'),
      id: text('id'),
      depth: depthColumn === undefined ? 0 : Number(result.cell(r, depthColumn).longValue ?? 0n),
      parent: text('parent'),
      forkTimestamp: text('fork_timestamp'),
    });
  }

  return rows;
}

function quote(name: string): string {
  return delimitIdentifier(name, 'name');
}
