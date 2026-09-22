/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

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
  // absent, as COMMENT ON is for every other object: the data route handles it itself.
  'CREATE SEQUENCE',
  'DROP SEQUENCE',
  'ALTER SEQUENCE',
];

const DML_PREFIXES = ['INSERT', 'UPDATE', 'DELETE'];

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

/** True when the statement may be registered as a prepared statement. */
export function isPreparableStatement(sql: string): boolean {
  return startsWithAny(sql, PREPARABLE_PREFIXES);
}

/** True when the statement cannot run inside an explicit transaction. */
export function runsInOwnTransaction(sql: string): boolean {
  return startsWithAny(sql, OWN_TRANSACTION_PREFIXES);
}

function startsWithAny(sql: string, prefixes: readonly string[]): boolean {
  const trimmed = sql.trimStart();

  for (const prefix of prefixes) {
    if (trimmed.length < prefix.length) continue;

    if (trimmed.slice(0, prefix.length).toUpperCase() === prefix) return true;
  }

  return false;
}
