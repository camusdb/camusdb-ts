/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * Reads a SQL text for the driver's spans: the tables it names, for `db.collection.name` and
 * `db.query.summary`, and a copy with its literal values removed, for `db.query.text` under
 * `traceQueryText: 'sanitized'`.
 *
 * This is a scan of tokens, not a parse. It knows string, number and bytes literals, backtick
 * identifiers, `@` parameters and comments, and it takes a table from the name that follows `FROM`,
 * `JOIN`, `INTO`, `UPDATE` or `TABLE`. A comma join names only its first table, and a common table
 * expression is named as a table. Literal values never reach a summary, because a table name is
 * never a literal. The .NET driver has the same scan, so both drivers name a span the same way.
 *
 * @internal
 */

/** The longest summary the driver writes. Longer summaries end at the last whole table. */
export const MAX_SUMMARY_LENGTH = 255;

/** The text a sanitized SQL text has in place of each literal value. */
const PLACEHOLDER = '?';

/** Keywords after which the next name is a table. */
const TABLE_KEYWORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE']);

/**
 * Keywords that can follow a table keyword without being a table: `DO UPDATE SET`,
 * `CREATE TABLE IF NOT EXISTS`, `TRUNCATE TABLE`, `DELETE FROM ONLY`.
 */
const NOT_TABLES = new Set([
  'SET',
  'SELECT',
  'IF',
  'NOT',
  'EXISTS',
  'ONLY',
  'LATERAL',
  'WHERE',
  'VALUES',
  'AS',
  'TABLE',
]);

/** Functions whose arguments contain `FROM` without naming a table. */
const FROM_FUNCTIONS = new Set(['EXTRACT', 'TRIM', 'SUBSTRING', 'SUBSTR', 'POSITION', 'OVERLAY']);

/** Each list of two or more placeholders. */
const PLACEHOLDER_LIST = /\?(?:\s*,\s*\?)+/g;

const TokenKind = {
  Word: 0,
  Identifier: 1,
  Parameter: 2,
  Literal: 3,
  Comment: 4,
  Punctuation: 5,
} as const;

type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  readonly length: number;

  /** The word, the identifier without backticks, or the punctuation character. Empty for a literal or a comment. */
  readonly text: string;
}

/** The tables `sql` names, in the order it names them, each once. */
export function queryTables(sql: string): string[] {
  const tokens = tokenize(sql);
  const tables: string[] = [];
  const fromIsArgument: boolean[] = [];
  let expectTable = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;

    if (token.kind === TokenKind.Comment) continue;

    if (token.kind === TokenKind.Punctuation) {
      if (token.text === '(') {
        const previous = index > 0 ? tokens[index - 1] : undefined;
        fromIsArgument.push(
          previous?.kind === TokenKind.Word && FROM_FUNCTIONS.has(previous.text.toUpperCase()),
        );
      } else if (token.text === ')' && fromIsArgument.length > 0) {
        fromIsArgument.pop();
      }

      expectTable = false;
      continue;
    }

    const keyword = token.kind === TokenKind.Word ? token.text.toUpperCase() : undefined;

    if (expectTable) {
      expectTable = false;

      if (token.kind === TokenKind.Identifier || (keyword !== undefined && !NOT_TABLES.has(keyword))) {
        const [table, last] = qualifiedName(tokens, index);
        index = last;
        if (!tables.includes(table)) tables.push(table);
        continue;
      }

      // CREATE TABLE IF NOT EXISTS t: the table follows the condition.
      if (keyword === 'IF') {
        while (index + 1 < tokens.length && tokens[index + 1]!.kind === TokenKind.Word) {
          const next = tokens[index + 1]!.text.toUpperCase();
          if (next !== 'NOT' && next !== 'EXISTS') break;
          index++;
        }

        expectTable = true;
        continue;
      }
    }

    if (keyword !== undefined && TABLE_KEYWORDS.has(keyword)) {
      const insideArgument = fromIsArgument.length > 0 && fromIsArgument[fromIsArgument.length - 1]!;
      expectTable = !(insideArgument && keyword === 'FROM');
    } else if (index === 0 && keyword === 'TRUNCATE') {
      // TRUNCATE t, as well as TRUNCATE TABLE t.
      expectTable = true;
    }
  }

  return tables;
}

/**
 * The `db.query.summary` of a statement: its operation followed by its tables, such as
 * `SELECT orders customers`. `undefined` when the statement names no table.
 */
export function querySummary(
  operationName: string | undefined,
  tables: readonly string[],
): string | undefined {
  if (tables.length === 0) return undefined;

  let summary = operationName ?? '';

  for (const table of tables) {
    const length = summary.length === 0 ? table.length : summary.length + 1 + table.length;
    if (length > MAX_SUMMARY_LENGTH) break;

    summary = summary.length === 0 ? table : `${summary} ${table}`;
  }

  return summary.length === 0 ? undefined : summary;
}

/**
 * `sql` with each string, number and bytes literal replaced by `?`, each comment removed, and each
 * list of two or more `?` written as `?, ...`. Identifiers, keywords and `@` parameters are kept as
 * they are.
 */
export function sanitizeQueryText(sql: string): string {
  let sanitized = '';
  let position = 0;

  for (const token of tokenize(sql)) {
    sanitized += sql.slice(position, token.start);

    if (token.kind === TokenKind.Literal) sanitized += PLACEHOLDER;
    else if (token.kind === TokenKind.Comment) sanitized += ' ';
    else sanitized += sql.slice(token.start, token.start + token.length);

    position = token.start + token.length;
  }

  sanitized += sql.slice(position);
  return sanitized.replace(PLACEHOLDER_LIST, '?, ...');
}

/**
 * A name and the `.name` parts after it, without backticks: `shop.orders`. It also reports the
 * index of the last token of the name.
 */
function qualifiedName(tokens: readonly Token[], index: number): [string, number] {
  let name = tokens[index]!.text;

  while (
    index + 2 < tokens.length &&
    tokens[index + 1]!.kind === TokenKind.Punctuation &&
    tokens[index + 1]!.text === '.' &&
    (tokens[index + 2]!.kind === TokenKind.Identifier || tokens[index + 2]!.kind === TokenKind.Word)
  ) {
    name += `.${tokens[index + 2]!.text}`;
    index += 2;
  }

  return [name, index];
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < sql.length) {
    const current = sql[index]!;
    const next = index + 1 < sql.length ? sql[index + 1]! : '';
    const start = index;

    if (isWhiteSpace(current)) {
      index++;
    } else if (current === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index++;
      tokens.push({ kind: TokenKind.Comment, start, length: index - start, text: '' });
    } else if (current === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end < 0 ? sql.length : end + 2;
      tokens.push({ kind: TokenKind.Comment, start, length: index - start, text: '' });
    } else if (current === "'" || current === '"') {
      index = skipQuoted(sql, index, current, false);
      tokens.push({ kind: TokenKind.Literal, start, length: index - start, text: '' });
    } else if ((current === 'e' || current === 'E') && (next === "'" || next === '"')) {
      index = skipQuoted(sql, index + 1, next, true);
      tokens.push({ kind: TokenKind.Literal, start, length: index - start, text: '' });
    } else if ((current === 'x' || current === 'X') && next === "'") {
      index = skipQuoted(sql, index + 1, "'", false);
      tokens.push({ kind: TokenKind.Literal, start, length: index - start, text: '' });
    } else if (current === '`') {
      index = skipQuoted(sql, index, '`', false);
      const text = sql.slice(start + 1, start + 1 + Math.max(0, index - start - 2)).replaceAll('``', '`');
      tokens.push({ kind: TokenKind.Identifier, start, length: index - start, text });
    } else if (isAsciiDigit(current) || (current === '.' && isAsciiDigit(next))) {
      index = skipNumber(sql, index);
      tokens.push({ kind: TokenKind.Literal, start, length: index - start, text: '' });
    } else if (isWordStart(current) || (current === '@' && isWordStart(next))) {
      index++;
      while (index < sql.length && isWordPart(sql[index]!)) index++;

      const kind = current === '@' ? TokenKind.Parameter : TokenKind.Word;
      tokens.push({ kind, start, length: index - start, text: sql.slice(start, index) });
    } else {
      index++;
      tokens.push({ kind: TokenKind.Punctuation, start, length: 1, text: current });
    }
  }

  return tokens;
}

/**
 * The index after the quoted run that opens at `index`. A doubled quote is part of the run. A
 * backslash escapes the next character only in an `E'...'` string: in any other string it is an
 * ordinary character, as the server reads it.
 */
function skipQuoted(sql: string, index: number, quote: string, backslashEscapes: boolean): number {
  index++;

  while (index < sql.length) {
    const current = sql[index];

    if (current === '\\' && backslashEscapes) {
      index += 2;
      continue;
    }

    if (current === quote) {
      if (index + 1 < sql.length && sql[index + 1] === quote) {
        index += 2;
        continue;
      }

      return index + 1;
    }

    index++;
  }

  return sql.length;
}

function skipNumber(sql: string, index: number): number {
  if (sql[index] === '0' && (sql[index + 1] === 'x' || sql[index + 1] === 'X')) {
    index += 2;
    while (index < sql.length && /[0-9A-Fa-f]/.test(sql[index]!)) index++;
    return index;
  }

  while (index < sql.length && (isAsciiDigit(sql[index]!) || sql[index] === '.')) index++;

  if (sql[index] === 'e' || sql[index] === 'E') {
    let exponent = index + 1;
    if (sql[exponent] === '+' || sql[exponent] === '-') exponent++;

    if (exponent < sql.length && isAsciiDigit(sql[exponent]!)) {
      index = exponent;
      while (index < sql.length && isAsciiDigit(sql[index]!)) index++;
    }
  }

  return index;
}

function isWhiteSpace(value: string): boolean {
  return /\s/.test(value);
}

function isAsciiDigit(value: string): boolean {
  return value >= '0' && value <= '9';
}

function isWordStart(value: string): boolean {
  return value === '_' || /\p{L}/u.test(value);
}

function isWordPart(value: string): boolean {
  return value === '_' || value === '$' || /[\p{L}\p{Nd}]/u.test(value);
}
