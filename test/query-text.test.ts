import { describe, expect, it } from 'vitest';

import { MAX_SUMMARY_LENGTH, querySummary, queryTables, sanitizeQueryText } from '../src/query-text.js';

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
      'SELECT FROM JOIN INTO UPDATE TABLE IF NOT EXISTS TRUNCATE EXTRACT(`\'"\\-/*@.,;()0123456789xXeE \n';

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
  ])('replaces each literal value of %j', (sql, expected) => {
    expect(sanitizeQueryText(sql)).toBe(expected);
  });
});
