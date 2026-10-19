/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from './errors.js';
import { CamusErrorCode } from './error-codes.js';
import { hasReturningKeyword, isPlainIdentifier } from './sql-syntax.js';
import type { Parameters } from './values/encode.js';

/**
 * Classifies a statement by its leading keywords.
 *
 * The server decides what a statement means; these lists only decide which route the driver sends
 * it to and whether it is worth preparing. A statement this module classifies wrongly still runs
 * correctly, because the data route forwards a schema statement to the same implementation — it
 * simply takes an extra parse and dispatch on the way.
 */

/**
 * The schema statements that go to the server's DDL route rather than its data route.
 *
 * An older server does not forward, and refuses such a statement on the data route as an unknown
 * node, so this list is also what keeps the driver working against one.
 *
 * `REFRESH MATERIALIZED VIEW` is deliberately absent. It is a write, not schema: it replaces a
 * relation's contents and reports how many rows it wrote, which the DDL route has no shape to
 * return.
 */
const DDL_PREFIXES = [
  'CREATE TABLE',
  'DROP TABLE',
  'ALTER TABLE',
  // TRUNCATE is schema, not a write: the server retires the table's whole key space and commits a
  // replicated schema entry instead of deleting rows. The TABLE keyword is optional, so the prefix
  // stops at the verb and covers both spellings.
  'TRUNCATE',
  'CREATE UNIQUE INDEX',
  'CREATE INDEX',
  'DROP INDEX',
  // Views. "CREATE VIEW" does not cover "CREATE OR REPLACE VIEW", because the test is a prefix
  // test, so each spelling needs its own entry. The IF EXISTS and IF NOT EXISTS variants do fall
  // under the base prefixes, because the condition follows the object keyword.
  'CREATE VIEW',
  'CREATE OR REPLACE VIEW',
  'DROP VIEW',
  'ALTER VIEW',
  'CREATE MATERIALIZED VIEW',
  'DROP MATERIALIZED VIEW',
  'ALTER MATERIALIZED VIEW',
  // Sequences. ALTER SEQUENCE covers both the option form and RENAME TO. COMMENT ON SEQUENCE is
  // here although COMMENT ON for every other object is not: the data route handles those itself,
  // but released servers refuse a sequence comment there as an unknown statement, and only the
  // DDL route runs it.
  'CREATE SEQUENCE',
  'DROP SEQUENCE',
  'ALTER SEQUENCE',
  'COMMENT ON SEQUENCE',
  // Row triggers that run C# extension code. TRIGGER is not a reserved word, but no other
  // statement starts with these two words.
  'CREATE TRIGGER',
  'DROP TRIGGER',
];

/**
 * The statements that run on the non-query route and report an affected-row count.
 *
 * `CALL` runs a procedure that a C# extension on the server defines. The server runs it only on the
 * non-query route, and answers it with an affected-row count and no result set, as it does a write
 * without `RETURNING`.
 */
const DML_PREFIXES = ['INSERT', 'UPDATE', 'DELETE', 'CALL'];

const CALL_PREFIXES = ['CALL'];

/**
 * The statements the server accepts a registration for: the repeatable data statements, whose
 * whole point is running many times with different values. Schema and administration statements
 * are one-shot and are excluded on the server too, so this list mirrors that rather than guessing.
 */
const PREPARABLE_PREFIXES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SHOW'];

/**
 * The statements that own their internal transaction, which the server refuses inside an explicit
 * one.
 *
 * `TRUNCATE` is the only member today. It commits a replicated schema entry, and a later rollback
 * of the caller's transaction cannot undo that entry — so the server refuses the statement rather
 * than promise a rollback it cannot deliver. The driver refuses it before the round trip, because
 * the outcome is already known and a local message can name the fix.
 */
const OWN_TRANSACTION_PREFIXES = ['TRUNCATE'];

/** True when the statement goes to the DDL route. */
export function isDdlStatement(sql: string): boolean {
  return startsWithAny(sql, DDL_PREFIXES);
}

/** True when the statement writes rows and reports how many. */
export function isDmlStatement(sql: string): boolean {
  return startsWithAny(sql, DML_PREFIXES);
}

/** True when the statement is a `CALL`, which the server runs only on the non-query route. */
export function isCallStatement(sql: string): boolean {
  return startsWithAny(sql, CALL_PREFIXES);
}

/**
 * True when the statement is an `INSERT`, `UPDATE`, or `DELETE` with a `RETURNING` list, which
 * sends back the rows it wrote. The keyword test skips literals, comments, delimited names, and
 * placeholders.
 */
export function isWriteReturning(sql: string): boolean {
  return isDmlStatement(sql) && !isCallStatement(sql) && hasReturningKeyword(sql);
}

/**
 * Composes `CALL name(@a, @b, ...)` for a procedure that a C# extension on the server defines.
 *
 * The arguments follow the order of the parameter object's keys, because a procedure takes its
 * arguments by position. A key that is a whole number, such as `'0'`, comes first in JavaScript
 * whatever its place in the object literal, so use names. The server reads the procedure name only
 * as a plain identifier, so any other name is refused here, before a request.
 *
 * @throws {TypeError} when the procedure name is not a plain identifier.
 */
export function callStatement(procedure: string, parameters?: Parameters): string {
  const name = procedure.trim();

  if (!isPlainIdentifier(name)) {
    throw new TypeError(
      `'${name}' is not a procedure name. The procedure name must be a plain identifier: a letter ` +
        "or '_', then letters, digits, or '_'.",
    );
  }

  const placeholders = Object.keys(parameters ?? {}).map((key) => {
    if (key.length === 0) {
      throw new CamusError(CamusErrorCode.InvalidParameter, 'A parameter name cannot be empty.');
    }

    return key.startsWith('@') ? key : `@${key}`;
  });

  return `CALL ${name}(${placeholders.join(', ')})`;
}

/** True when the statement may be registered as a prepared statement. */
export function isPreparableStatement(sql: string): boolean {
  return startsWithAny(sql, PREPARABLE_PREFIXES);
}

/** True when the statement cannot run inside an explicit transaction. */
export function runsInOwnTransaction(sql: string): boolean {
  return startsWithAny(sql, OWN_TRANSACTION_PREFIXES);
}

/**
 * True when the statement begins with one of the prefixes, ignoring case.
 *
 * The keywords of a prefix may be separated by any run of whitespace, including a line break, as
 * they may be in SQL: `COMMENT  ON\nSEQUENCE` is the same statement as `COMMENT ON SEQUENCE`, and
 * a strict match would send it to a route that refuses it.
 */
function startsWithAny(sql: string, prefixes: readonly string[]): boolean {
  const trimmed = sql.trimStart();

  for (const prefix of prefixes) {
    if (startsWithKeywords(trimmed, prefix)) return true;
  }

  return false;
}

function startsWithKeywords(text: string, prefix: string): boolean {
  let position = 0;
  let wordStart = 0;

  while (wordStart < prefix.length) {
    if (wordStart > 0) {
      // At least one whitespace character must separate two keywords.
      const separatorStart = position;
      while (position < text.length && /\s/.test(text[position]!)) position++;
      if (position === separatorStart) return false;
    }

    const space = prefix.indexOf(' ', wordStart);
    const wordEnd = space === -1 ? prefix.length : space;
    const length = wordEnd - wordStart;

    if (text.length - position < length) return false;

    if (text.slice(position, position + length).toUpperCase() !== prefix.slice(wordStart, wordEnd)) {
      return false;
    }

    position += length;
    wordStart = wordEnd + 1;
  }

  return true;
}
