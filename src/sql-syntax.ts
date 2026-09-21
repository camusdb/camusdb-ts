/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * Quoting and validation for the few places this driver composes SQL text rather than binding a
 * parameter: a database name in a `CREATE DATABASE`, and a cache family name in a hint.
 *
 * Everything else a caller runs goes to the server as written, with values bound separately.
 */

/**
 * A single-quoted SQL string literal.
 *
 * @throws {TypeError} when the value holds a backslash the lexer would read together with the
 * closing quote.
 */
export function sqlLiteral(value: string, target: string): string {
  validateSqlLiteral(value, target);
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Refuses a value that cannot be written as a literal.
 *
 * CamusDB's lexer reads a backslash and the character after it as one unit. A doubled quote
 * therefore stops escaping the quote when a backslash precedes it, and a trailing backslash
 * consumes the literal's closing quote. Neither case has a spelling, so both are refused here
 * rather than sent as a statement that would parse as something else.
 */
export function validateSqlLiteral(value: string, target: string): void {
  let index = value.indexOf('\\');

  while (index >= 0) {
    if (index === value.length - 1) {
      throw new TypeError(
        `The value for ${target} ends with a backslash. CamusDB's lexer reads a backslash and the ` +
          "character after it as one unit, so a trailing backslash would consume the literal's closing quote.",
      );
    }

    if (value[index + 1] === "'") {
      throw new TypeError(
        `The value for ${target} has a backslash immediately before a quote at position ${String(index)}. ` +
          'CamusDB’s lexer reads that pair as one unit, so the quote cannot be escaped.',
      );
    }

    index = value.indexOf('\\', index + 2);
  }
}

/**
 * A backtick-delimited identifier.
 *
 * An identifier that holds a backtick is refused rather than doubled. CamusDB trims the delimiters
 * instead of decoding a doubled backtick, so doubling neutralizes nothing and the name would break
 * out of its quoting.
 */
export function delimitIdentifier(identifier: string, parameterName: string): string {
  validateIdentifier(identifier, parameterName);
  return `\`${identifier}\``;
}

/**
 * Refuses an identifier that cannot be delimited.
 *
 * A trailing backslash is refused for the reason `validateSqlLiteral` refuses one: CamusDB's lexer
 * reads a backslash and the character after it as one unit, so the backslash would consume the
 * closing backtick and the identifier would run into the text after it.
 */
export function validateIdentifier(identifier: string, parameterName: string): void {
  if (identifier.trim().length === 0) {
    throw new TypeError(`An identifier cannot be empty (${parameterName}).`);
  }

  if (identifier.includes('`')) {
    throw new TypeError(
      `The identifier '${identifier}' holds a backtick, which CamusDB cannot quote (${parameterName}).`,
    );
  }

  if (identifier.endsWith('\\')) {
    throw new TypeError(
      `The identifier '${identifier}' ends with a backslash (${parameterName}). CamusDB's lexer reads a ` +
        'backslash and the character after it as one unit, so the backslash would consume the closing backtick.',
    );
  }
}

/**
 * True when a string can serve as a database name.
 *
 * The name travels as a request field rather than as SQL text, so there is no injection to close
 * here. What the test protects is the cache keys: the prepared-statement policy, the gRPC batcher,
 * and the REST prepared-statement cache each join a database name and a statement with a newline,
 * and each states that a database name holds no newline. A name that held one would make two
 * distinct pairs collide on one key. Every control character is refused, not the newline alone,
 * because none of them names a database.
 *
 * It reports a verdict rather than throwing, because the two call sites raise different error
 * types: a configuration failure is a `CamusError`, and a bad argument is a `TypeError`.
 */
export function isValidDatabaseName(database: string): boolean {
  if (database.trim().length === 0) return false;

  // eslint-disable-next-line no-control-regex -- the point of the test is to find these characters.
  return !/[\u0000-\u001f\u007f]/.test(database);
}

/**
 * Refuses a name that is emitted into SQL as bare text and therefore cannot be escaped at all.
 * Letters, digits, and `_ - . :` are allowed.
 */
export function validateBareName(name: string, maxLength: number, parameterName: string): void {
  if (name.trim().length === 0) {
    throw new TypeError(`'${parameterName}' cannot be empty.`);
  }

  if (name.length > maxLength) {
    throw new TypeError(
      `'${parameterName}' is ${String(name.length)} characters; at most ${String(maxLength)} are allowed.`,
    );
  }

  for (const character of name) {
    if (/[\p{L}\p{Nd}_\-.:]/u.test(character)) continue;

    throw new TypeError(
      `'${parameterName}' holds the character '${character}', which is not allowed. Use letters, digits, ` +
        'or one of _ - . : — the name is emitted into SQL as text and cannot be escaped.',
    );
  }
}
