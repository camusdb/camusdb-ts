import { describe, expect, it } from 'vitest';

import {
  MAX_QUERY_TEXT_LENGTH,
  MAX_SUMMARY_LENGTH,
  querySummary,
  queryTables,
  sanitizeQueryText,
  truncateQueryText,
} from '../src/query-text.js';
import { hasReturningKeyword } from '../src/sql-syntax.js';

// The tables and the sanitized text the driver's spans take from a SQL text. The cases are those of
// the .NET driver, so both drivers name a span the same way.

describe('queryTables', () => {
  it.each([
    ['SELECT * FROM robots', 'robots'],
    ['select `r`.`id` from `robots` as `r` where `r`.`id` = @id', 'robots'],
    ['SELECT * FROM shop.robots', 'shop.robots'],
    ['SELECT * FROM `shop`.`robots` r', 'shop.robots'],
    ['SELECT a.id FROM a INNER JOIN b ON b.a_id = a.id LEFT JOIN c ON c.id = b.c_id', 'a,b,c'],
    ['SELECT * FROM a JOIN a AS a2 ON a2.parent = a.id', 'a'],
    ['INSERT INTO `wallets` (`id`, `amount`) VALUES (@p0, @p1)', 'wallets'],
    ['INSERT INTO audit SELECT * FROM events', 'audit,events'],
    ['UPDATE `players` SET `name` = @p0 WHERE `id` = @p1', 'players'],
    ['DELETE FROM sessions WHERE expires < 100', 'sessions'],
    ['INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 2', 't'],
    [
      'INSERT INTO t (k, n) VALUES (1, 2) ON CONFLICT ON CONSTRAINT t_pkey DO UPDATE SET n = t.n + excluded.n',
      't',
    ],
    ['UPSERT INTO `counters` (`k`, `n`) VALUES (@p0, @p1) RETURNING n', 'counters'],
    ['SELECT a FROM t UNION SELECT b FROM u EXCEPT SELECT c FROM v', 't,u,v'],
    ['(SELECT a FROM t ORDER BY a LIMIT 5) UNION ALL SELECT b FROM u ORDER BY 1', 't,u'],
    ['CREATE TABLE IF NOT EXISTS robots (id OID PRIMARY KEY)', 'robots'],
    ['DROP TABLE IF EXISTS robots', 'robots'],
    ['TRUNCATE robots', 'robots'],
    ['TRUNCATE TABLE robots', 'robots'],
    ['SELECT * FROM (SELECT id FROM inner_table) AS x', 'inner_table'],
    ['SELECT * FROM a WHERE id IN (SELECT a_id FROM b)', 'a,b'],
    ['SELECT EXTRACT(YEAR FROM created) FROM orders', 'orders'],
    ["SELECT TRIM(LEADING 'x' FROM name) FROM robots", 'robots'],
    ['SELECT * FROM -- comment\n robots', 'robots'],
    ["SELECT 'FROM fake' FROM robots", 'robots'],
    ['SELECT 1', ''],
    ['BEGIN', ''],
    [
      'CREATE FUNCTION f(s STRING) RETURNS STRING LANGUAGE csharp AS $$\n    // read from cache\n    return string.Join(",", s);\n$$',
      '',
    ],
    [
      'CREATE FUNCTION f(c STRING) RETURNS BOOL LANGUAGE csharp AS $$ return c == "\'"; $$; SELECT * FROM robots',
      'robots',
    ],
    ['SELECT f(name) FROM robots WHERE g($x$ from fake $$ $x$)', 'robots'],
  ])('names each table of %j once, in order', (sql, expected) => {
    expect(queryTables(sql)).toEqual(expected.length === 0 ? [] : expected.split(','));
  });
});

describe('querySummary', () => {
  it('is the operation and its tables', () => {
    expect(querySummary('SELECT', ['orders', 'customers'])).toBe('SELECT orders customers');
    expect(querySummary(undefined, ['orders'])).toBe('orders');
    expect(querySummary('SELECT', [])).toBeUndefined();
  });

  it('stops at the last whole table that fits', () => {
    const tables = Array.from({ length: 40 }, (_, index) => `table_number_${String(index).padStart(2, '0')}`);

    const summary = querySummary('SELECT', tables)!;

    expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    expect(summary.startsWith('SELECT table_number_00 table_number_01')).toBe(true);
    expect(summary.endsWith(tables.filter((name) => summary.includes(name)).at(-1)!)).toBe(true);
  });
});

describe('the scan', () => {
  it('reads any text without an exception', () => {
    // The scan runs inside every sampled operation, so it must accept any text, finished or not.
    const alphabet =
      'SELECT FROM JOIN INTO UPDATE TABLE IF NOT EXISTS TRUNCATE EXTRACT(`\'"\\-/*@.,;()$0123456789xXeE \n';

    // A fixed linear congruential sequence, so a failure repeats.
    let seed = 20261026;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };

    for (let sample = 0; sample < 20_000; sample++) {
      let sql = '';
      const length = next(40);
      for (let index = 0; index < length; index++) sql += alphabet[next(alphabet.length)];

      querySummary('SELECT', queryTables(sql));
      sanitizeQueryText(sql);
    }
  });
});

describe('sanitizeQueryText', () => {
  it.each([
    ["SELECT * FROM t WHERE email = 'a@b.co'", 'SELECT * FROM t WHERE email = ?'],
    ['SELECT * FROM t WHERE name = "Ana"', 'SELECT * FROM t WHERE name = ?'],
    ["SELECT * FROM t WHERE name = 'O''Brien'", 'SELECT * FROM t WHERE name = ?'],
    ["SELECT * FROM t WHERE path = 'C:\\' AND id = 1", 'SELECT * FROM t WHERE path = ? AND id = ?'],
    ["SELECT * FROM t WHERE note = E'it\\'s' AND id = 2", 'SELECT * FROM t WHERE note = ? AND id = ?'],
    ["SELECT * FROM t WHERE data = x'DEADBEEF'", 'SELECT * FROM t WHERE data = ?'],
    ['SELECT * FROM t WHERE score > -1.5e3 AND flag = 0x1F', 'SELECT * FROM t WHERE score > -? AND flag = ?'],
    ['SELECT * FROM t2 WHERE `t2`.`col1` = @p0', 'SELECT * FROM t2 WHERE `t2`.`col1` = @p0'],
    ["SELECT * FROM t WHERE id IN ('a', 'b', 'c', 'd')", 'SELECT * FROM t WHERE id IN (?, ...)'],
    ['SELECT * FROM t WHERE id = 1 -- player 42\nLIMIT 5', 'SELECT * FROM t WHERE id = ?  \nLIMIT ?'],
    ['SELECT /* user 7 */ id FROM t', 'SELECT   id FROM t'],
    ['SELECT * FROM t WHERE b = TRUE AND c IS NULL', 'SELECT * FROM t WHERE b = TRUE AND c IS NULL'],
    ["SELECT * FROM t WHERE s = 'unterminated", 'SELECT * FROM t WHERE s = ?'],
    [
      "CREATE FUNCTION f(s STRING) RETURNS STRING LANGUAGE csharp AS $$\n    return s.Replace('\\'', '-') + \"secret\";\n$$",
      'CREATE FUNCTION f(s STRING) RETURNS STRING LANGUAGE csharp AS ?',
    ],
    [
      'CREATE FUNCTION f() RETURNS STRING LANGUAGE csharp AS$fn$ return "$$"; $fn$',
      'CREATE FUNCTION f() RETURNS STRING LANGUAGE csharp AS?',
    ],
    ["SELECT $$ unterminated 'x", 'SELECT ?'],
    ['SELECT price$ FROM t WHERE a = $1', 'SELECT price$ FROM t WHERE a = $?'],
  ])('replaces each literal value of %j', (sql, expected) => {
    expect(sanitizeQueryText(sql)).toBe(expected);
  });
});

describe('truncateQueryText', () => {
  it('keeps a text at the limit as it is', () => {
    const text = 'x'.repeat(MAX_QUERY_TEXT_LENGTH);

    expect(truncateQueryText(text)).toBe(text);
  });

  it('cuts a longer text and marks the cut', () => {
    const cut = truncateQueryText('x'.repeat(MAX_QUERY_TEXT_LENGTH * 10));

    expect(cut).toHaveLength(MAX_QUERY_TEXT_LENGTH);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    // The pair takes the last code unit before the marker and the first one after it.
    const cut = truncateQueryText('x'.repeat(MAX_QUERY_TEXT_LENGTH - 2) + '😀'.repeat(10));

    expect(cut).toHaveLength(MAX_QUERY_TEXT_LENGTH - 1);
    expect(cut.endsWith('x…')).toBe(true);
  });
});

// The sanitizer and the RETURNING scan read a string the same way the server does: a backslash is
// an escape only in an E'...' string.
describe('one string grammar', () => {
  it.each([
    ["INSERT INTO t (a) VALUES ('a\\') RETURNING a", 'INSERT INTO t (a) VALUES (?) RETURNING a', true],
    ["INSERT INTO t (a) VALUES (E'a\\'') RETURNING a", 'INSERT INTO t (a) VALUES (?) RETURNING a', true],
    ["INSERT INTO t (a) VALUES ('a\\'' RETURNING a')", 'INSERT INTO t (a) VALUES (?)', false],
  ])('reads %j', (sql, sanitized, returning) => {
    expect(sanitizeQueryText(sql)).toBe(sanitized);
    expect(hasReturningKeyword(sql)).toBe(returning);
  });
});
