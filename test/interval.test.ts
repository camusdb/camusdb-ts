/**
 * This file is part of CamusDB
 *
 * Offline coverage for the interval support: the ISO-8601 text in CamusInterval, the millisecond
 * conversions, and parameter binding. The server sends an interval as its ISO-8601 text in a string
 * column, and reads a parameter as text with CAST(@p AS interval). No server is required.
 */

import { describe, expect, it } from 'vitest';

import { ColumnType } from '../src/column-type.js';
import { CamusErrorCode } from '../src/error-codes.js';
import { CamusError } from '../src/errors.js';
import { CamusInterval } from '../src/interval.js';
import { decodeValue } from '../src/values/decode.js';
import { encodeParameter } from '../src/values/encode.js';
import { camus } from '../src/values/typed.js';

const MICROS_PER_HOUR = 3_600_000_000n;

function interval(months: number, days: number, micros: bigint): CamusInterval {
  return new CamusInterval(months, days, micros);
}

describe('CamusInterval text', () => {
  // Each pair is the server's FormatIso output for the parts, checked on the live server.
  it.each<[string, number, number, bigint]>([
    ['PT0S', 0, 0, 0n],
    ['P1DT2H', 0, 1, 2n * MICROS_PER_HOUR],
    ['P1DT15H', 0, 1, 15n * MICROS_PER_HOUR],
    ['P-7D', 0, -7, 0n],
    ['P43Y9M27D', 525, 27, 0n],
    ['P1Y2M3DT4H5M6.5S', 14, 3, 4n * MICROS_PER_HOUR + 5n * 60_000_000n + 6_500_000n],
    ['P-1DT-12H', 0, -1, -12n * MICROS_PER_HOUR],
    ['PT-1H-30M-5.25S', 0, 0, -(MICROS_PER_HOUR + 30n * 60_000_000n + 5_250_000n)],
    ['P1DT2H3M4.123457S', 0, 1, 2n * MICROS_PER_HOUR + 3n * 60_000_000n + 4_123_457n],
    ['PT-0.000001S', 0, 0, -1n],
    ['P-1Y-2M', -14, 0, 0n],
  ])('round-trips the server text %s', (text, months, days, micros) => {
    const value = CamusInterval.parse(text);

    expect(value.equals(interval(months, days, micros))).toBe(true);
    expect(value.toString()).toBe(text);
  });

  it.each<[string, number, number, bigint]>([
    ['P2W', 0, 14, 0n],
    ['p1dt2h', 0, 1, 2n * MICROS_PER_HOUR],
    [' PT1.0000005S ', 0, 0, 1_000_000n],
    ['PT1.0000015S', 0, 0, 1_000_002n],
    ['PT-1.0000015S', 0, 0, -1_000_002n],
    ['P+1D', 0, 1, 0n],
    ['PT1.5S1H', 0, 0, MICROS_PER_HOUR + 1_500_000n],
  ])('reads the other ISO form %s', (text, months, days, micros) => {
    expect(CamusInterval.parse(text)).toEqual(interval(months, days, micros));
  });

  it.each([
    '',
    'P',
    'PT',
    'P1DT',
    '1 day',
    '01:00:00',
    'P1.5D',
    'P1H',
    'PT1D',
    'P1DT2H3',
    'PTT1H',
    'P1..2D',
    'P-D',
  ])('refuses %j, which is not an ISO interval', (text) => {
    expect(CamusInterval.tryParse(text)).toBeUndefined();
    expect(() => CamusInterval.parse(text)).toThrow(SyntaxError);
  });

  it('refuses a part out of range', () => {
    expect(() => CamusInterval.parse('P9999999999D')).toThrow(RangeError);
    expect(() => CamusInterval.parse('P178956971Y')).toThrow(RangeError);
    expect(CamusInterval.tryParse('P9999999999D')).toBeUndefined();
    expect(CamusInterval.tryParse(null)).toBeUndefined();
    expect(CamusInterval.tryParse(undefined)).toBeUndefined();
  });

  it('compares the three parts for equality', () => {
    // On the server INTERVAL 'P1M' = INTERVAL 'P30D' is true. Here the parts differ.
    expect(interval(1, 0, 0n).equals(interval(0, 30, 0n))).toBe(false);
    expect(interval(1, 2, 3n).equals(CamusInterval.parse('P1M2DT0.000003S'))).toBe(true);
  });

  it('writes its text in JSON', () => {
    expect(JSON.stringify({ d: interval(0, 1, 0n) })).toBe('{"d":"P1D"}');
  });

  it('refuses a part that is not an integer or is out of range', () => {
    expect(() => new CamusInterval(1.5, 0)).toThrow(RangeError);
    expect(() => new CamusInterval(0, 2 ** 31)).toThrow(RangeError);
    expect(() => new CamusInterval(0, 0, 2 ** 60)).toThrow(RangeError);
    expect(() => new CamusInterval(0, 0, 1n << 63n)).toThrow(RangeError);
    expect(new CamusInterval(0, 0, 5).microseconds).toBe(5n);
    expect(Object.is(new CamusInterval(-0, -0).months, 0)).toBe(true);
  });
});

describe('CamusInterval milliseconds', () => {
  it('converts a duration with its whole days in the days part', () => {
    const ms = ((24 + 2) * 60 + 3) * 60_000 + 4_500;
    const value = CamusInterval.fromMilliseconds(ms);

    expect(value).toEqual(interval(0, 1, 2n * MICROS_PER_HOUR + 3n * 60_000_000n + 4_500_000n));
    expect(value.toString()).toBe('P1DT2H3M4.5S');
    expect(value.toMilliseconds()).toBe(ms);

    const negative = -36 * 3_600_000;
    expect(CamusInterval.fromMilliseconds(negative).toString()).toBe('P-1DT-12H');
    expect(CamusInterval.parse('P-1DT-12H').toMilliseconds()).toBe(negative);
    expect(CamusInterval.fromMilliseconds(0).toString()).toBe('PT0S');
    expect(CamusInterval.fromMilliseconds(-0).toString()).toBe('PT0S');
  });

  it('rounds a fraction of a microsecond to even', () => {
    expect(CamusInterval.fromMilliseconds(0.0005).microseconds).toBe(0n);
    expect(CamusInterval.fromMilliseconds(0.0015).microseconds).toBe(2n);
    expect(CamusInterval.fromMilliseconds(-0.0015).microseconds).toBe(-2n);
    expect(CamusInterval.fromMilliseconds(1.5e-7).microseconds).toBe(0n);
    expect(CamusInterval.fromMilliseconds(0.001).microseconds).toBe(1n);
  });

  it('refuses a value that is not finite', () => {
    expect(() => CamusInterval.fromMilliseconds(Number.NaN)).toThrow(RangeError);
    expect(() => CamusInterval.fromMilliseconds(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('refuses a month part', () => {
    expect(() => CamusInterval.parse('P1M').toMilliseconds()).toThrow(/CamusInterval/);
  });
});

describe('interval parameters', () => {
  it('binds a CamusInterval as its text', () => {
    expect(encodeParameter(interval(14, 3, 0n))).toEqual({ type: ColumnType.String, strValue: 'P1Y2M3D' });
    expect(encodeParameter(CamusInterval.fromMilliseconds(90 * 60_000))).toEqual({
      type: ColumnType.String,
      strValue: 'PT1H30M',
    });
  });

  it('binds camus.interval from a CamusInterval or from ISO text', () => {
    expect(encodeParameter(camus.interval(interval(0, 1, 0n)))).toEqual({
      type: ColumnType.String,
      strValue: 'P1D',
    });
    expect(encodeParameter(camus.interval(' PT1.0000005S '))).toEqual({
      type: ColumnType.String,
      strValue: 'PT1.0000005S',
    });
  });

  it('refuses camus.interval text that is not an ISO interval', () => {
    expect(() => camus.interval('1 day')).toThrow(CamusError);

    try {
      camus.interval('01:00:00');
    } catch (error) {
      expect((error as CamusError).code).toBe(CamusErrorCode.InvalidParameter);
    }
  });

  it('needs a stated element type for an array of intervals', () => {
    const spans = [CamusInterval.fromMilliseconds(3_600_000), null, interval(0, 1, 0n)];

    expect(() => encodeParameter(spans)).toThrow(/camus\.array\(items, ColumnType\.String\)/);

    expect(encodeParameter(camus.array(spans, ColumnType.String))).toEqual({
      type: ColumnType.Array,
      arrayElementType: ColumnType.String,
      arrayValues: [
        { type: ColumnType.String, strValue: 'PT1H' },
        { type: ColumnType.Null },
        { type: ColumnType.String, strValue: 'P1D' },
      ],
    });
  });

  it('reads a result interval as text that parses', () => {
    const cell = decodeValue({ type: ColumnType.String, strValue: 'P1DT2H3M4.123457S' });

    expect(cell).toBe('P1DT2H3M4.123457S');
    expect(CamusInterval.parse(cell as string).toMilliseconds()).toBe(93_784_123.457);
  });
});
