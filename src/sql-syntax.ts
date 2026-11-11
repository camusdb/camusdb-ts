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
 * Refuses a value that cannot be written as a literal on every server this driver supports.
 *
 * A CamusDB server from 0.9.9 on reads a backslash in a plain `'...'` string as an ordinary
 * character, and only an `E'...'` string treats it as an escape. An older server reads a backslash
 * and the character after it as one unit in every string. On such a server, a doubled quote stops
 * escaping the quote when a backslash precedes it, and a trailing backslash consumes the literal's
 * closing quote. Neither case has a spelling that both lexers read the same way, so both are
 * refused here rather than sent as a statement that could parse as something else.
 */
export function validateSqlLiteral(value: string, target: string): void {
  let index = value.indexOf('\\');

  while (index >= 0) {
    if (index === value.length - 1) {
      throw new TypeError(
        `The value for ${target} ends with a backslash. A CamusDB server before 0.9.9 reads a backslash ` +
          "and the character after it as one unit, so a trailing backslash would consume the literal's closing quote.",
      );
    }

    if (value[index + 1] === "'") {
      throw new TypeError(
        `The value for ${target} has a backslash immediately before a quote at position ${String(index)}. ` +
          'A CamusDB server before 0.9.9 reads that pair as one unit, so the quote cannot be escaped.',
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

/**
 * True when the name is a plain identifier: a letter or `_`, then letters, digits, or `_`, all ASCII.
 * The server reads the procedure name of `CALL` only in this form, not delimited, so such a name is
 * emitted as written and any other name has no spelling.
 */
export function isPlainIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

const RETURNING = 'RETURNING';

/**
 * True when `sql` holds the keyword `RETURNING` as a token: not inside a string literal, a
 * delimited identifier, or a comment, and not as part of a longer name or an `@placeholder`.
 *
 * `RETURNING` is a reserved word on the server, so a token match is the clause itself. A column or
 * a table called `returning` must be written with backticks, which this skips. Literals are skipped
 * with `skipQuoted`, the scan `sanitizeQueryText` uses too, so both read a string the way the
 * server does. Dollar-quoted text is skipped whole.
 */
export function hasReturningKeyword(sql: string): boolean {
  let i = 0;

  while (i < sql.length) {
    const c = sql[i]!;

    if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(sql, i, c, false);
      continue;
    }

    // An `E'...'` string is the one kind in which a backslash escapes the next character.
    if ((c === 'e' || c === 'E') && (sql[i + 1] === "'" || sql[i + 1] === '"')) {
      i = skipQuoted(sql, i + 1, sql[i + 1]!, true);
      continue;
    }

    if (c === '$' && dollarQuoteLength(sql, i) > 0) {
      i = skipDollarQuoted(sql, i);
      continue;
    }

    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }

    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }

    if (isWordCharacter(c)) {
      const start = i;

      while (
        i < sql.length &&
        isWordCharacter(sql[i]!) &&
        !(sql[i] === '$' && dollarQuoteLength(sql, i) > 0)
      ) {
        i++;
      }

      if (i - start === RETURNING.length && sql.slice(start, i).toUpperCase() === RETURNING) return true;

      continue;
    }

    i++;
  }

  return false;
}

/** `@`, `$`, and `.` join the word, so `@returning` and `t.returning` are not the keyword. */
function isWordCharacter(character: string): boolean {
  return /[\p{L}\p{Nd}_@$.]/u.test(character);
}

/**
 * The length of the dollar quote that opens at `start`: `$$`, or `$`, a tag, and `$`, as in `$fn$`.
 * Zero when the character there opens no quote.
 *
 * The rule is the server lexer's: a tag is a letter or `_`, then letters, digits, or `_`, all ASCII.
 * A dollar quote holds the body of `CREATE FUNCTION … LANGUAGE csharp`.
 *
 * @internal
 */
export function dollarQuoteLength(sql: string, start: number): number {
  if (sql[start] !== '$') return 0;

  let i = start + 1;

  if (i < sql.length && isAsciiTagStart(sql[i]!)) {
    while (i < sql.length && isAsciiTagPart(sql[i]!)) i++;
  }

  return sql[i] === '$' ? i + 1 - start : 0;
}

/**
 * The index after the dollar-quoted text that opens at `start`. The text between two equal quotes
 * is raw: quotes, semicolons, and comments in it are text, with no escape. With no closing quote,
 * the rest of the text is in it, as the server's script splitter reads it. The caller must first
 * make sure that a quote opens there (`dollarQuoteLength`).
 *
 * @internal
 */
export function skipDollarQuoted(sql: string, start: number): number {
  const length = dollarQuoteLength(sql, start);
  const quote = sql.slice(start, start + length);
  const close = sql.indexOf(quote, start + length);

  return close < 0 ? sql.length : close + length;
}

function isAsciiTagStart(character: string): boolean {
  return (
    character === '_' || (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z')
  );
}

function isAsciiTagPart(character: string): boolean {
  return isAsciiTagStart(character) || (character >= '0' && character <= '9');
}

/**
 * The index after the quoted run that opens at `index`, or the end of the text when the run never
 * closes. A doubled quote is part of the run. A backslash escapes the next character only when
 * `backslashEscapes` is set, which is for an `E'...'` string: the server reads a backslash in any
 * other string as an ordinary character.
 *
 * @internal
 */
export function skipQuoted(sql: string, index: number, quote: string, backslashEscapes: boolean): number {
  index++;

  while (index < sql.length) {
    const current = sql[index];

    if (current === '\\' && backslashEscapes) {
      index += 2;
      continue;
    }

    if (current === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }

      return index + 1;
    }

    index++;
  }

  return sql.length;
}
