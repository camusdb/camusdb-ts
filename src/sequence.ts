/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { delimitIdentifier, sqlLiteral, validateIdentifier } from './sql-syntax.js';

/**
 * The options of a `CREATE SEQUENCE`.
 *
 * A CamusDB sequence stores `int64` values only, has a positive increment, and never cycles. The
 * server refuses `CYCLE` with `CADB0533`, because a wrapped counter would issue again the values
 * that committed rows already hold, so there is no option for it here.
 */
export interface CamusSequenceOptions {
  /** The first value `nextval` returns. The server default is the minimum. */
  readonly startWith?: number | bigint | undefined;

  /** The step between two values. It must be positive. The server default is 1. */
  readonly incrementBy?: number | bigint | undefined;

  /**
   * The smallest value. Leave it out for the server default, 1. The statement never says
   * `NO MINVALUE`, because the server reads that as the smallest 64-bit value, not as the default.
   */
  readonly minValue?: number | bigint | undefined;

  /** The largest value. Leave it out for the server default, the largest 64-bit value. */
  readonly maxValue?: number | bigint | undefined;

  /** Adds `IF NOT EXISTS`, so the statement does nothing when the sequence already exists. */
  readonly ifNotExists?: boolean | undefined;
}

/**
 * The statement that creates a sequence:
 * `CREATE SEQUENCE [IF NOT EXISTS] name [START WITH …] [INCREMENT BY …] [MINVALUE …] [MAXVALUE …]`.
 *
 * ```ts
 * await client.executeDdl(createSequenceStatement('ticket_numbers', { startWith: 1000 }));
 * ```
 *
 * @throws {TypeError} when the name cannot be delimited, when a value is not an integer, or when
 * the increment is not positive.
 */
export function createSequenceStatement(name: string, options: CamusSequenceOptions = {}): string {
  let sql = `CREATE SEQUENCE ${options.ifNotExists === true ? 'IF NOT EXISTS ' : ''}${delimitIdentifier(name, 'name')}`;

  if (options.startWith !== undefined) sql += ` START WITH ${integer(options.startWith, 'startWith')}`;

  if (options.incrementBy !== undefined) {
    const increment = integer(options.incrementBy, 'incrementBy');

    if (BigInt(increment) <= 0n) {
      throw new TypeError(
        `A CamusDB sequence needs a positive increment; got ${increment} for sequence '${name}'.`,
      );
    }

    sql += ` INCREMENT BY ${increment}`;
  }

  if (options.minValue !== undefined) sql += ` MINVALUE ${integer(options.minValue, 'minValue')}`;
  if (options.maxValue !== undefined) sql += ` MAXVALUE ${integer(options.maxValue, 'maxValue')}`;

  return sql;
}

/**
 * The statement that drops a sequence: `DROP SEQUENCE [IF EXISTS] name`.
 *
 * @throws {TypeError} when the name cannot be delimited.
 */
export function dropSequenceStatement(name: string, options: { ifExists?: boolean } = {}): string {
  return `DROP SEQUENCE ${options.ifExists === true ? 'IF EXISTS ' : ''}${delimitIdentifier(name, 'name')}`;
}

/**
 * The expression that draws the next value of a sequence: `nextval('name')`. Use it in the value
 * list of an `INSERT`, or as a column default. A column default needs parentheses:
 * `DEFAULT (nextval('name'))`.
 *
 * The name is a string argument, not an identifier, so it is quoted as a literal. It must still be
 * a name that a `CREATE SEQUENCE` can delimit.
 *
 * @throws {TypeError} when the name cannot be a sequence name.
 */
export function nextValueExpression(name: string): string {
  validateIdentifier(name, 'name');
  return `nextval(${sqlLiteral(name, `sequence name '${name}'`)})`;
}

/** The statement that draws one value: a `SELECT` with no `FROM`, which the server accepts. */
export function selectNextValueStatement(name: string): string {
  return `SELECT ${nextValueExpression(name)}`;
}

function integer(value: number | bigint, option: string): string {
  if (typeof value === 'bigint') return value.toString();

  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `The sequence option '${option}' needs a safe integer or a bigint; got ${String(value)}.`,
    );
  }

  return String(value);
}
