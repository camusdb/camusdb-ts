import { describe, expect, it } from 'vitest';

import { asBigInt, asNumber, parseLossless, stringifyLossless } from '../src/json.js';

describe('parseLossless', () => {
  it('reads an integer inside the safe range as a number', () => {
    expect(parseLossless('{"a":42}')).toEqual({ a: 42 });
  });

  it('reads an integer outside the safe range as a bigint', () => {
    const parsed = parseLossless('{"txnIdPT":638765432109876543}') as { txnIdPT: bigint };

    expect(typeof parsed.txnIdPT).toBe('bigint');
    expect(parsed.txnIdPT).toBe(638765432109876543n);
  });

  it('keeps a 64-bit value that JSON.parse would round', () => {
    const text = '[9007199254740993]';

    expect((JSON.parse(text) as number[])[0]).toBe(9007199254740992);
    expect((parseLossless(text) as bigint[])[0]).toBe(9007199254740993n);
  });

  it('reads a negative integer outside the safe range', () => {
    expect(parseLossless('[-9223372036854775808]')).toEqual([-9223372036854775808n]);
  });

  it('reads a fractional number as a number even when it is long', () => {
    expect(parseLossless('[1234567890123456789.5]')).toEqual([Number('1234567890123456789.5')]);
  });

  it('reads an exponent as a number even when it is long', () => {
    expect(parseLossless('[12345678901234567890e-3]')).toEqual([Number('12345678901234567890e-3')]);
  });

  it('reads strings, escapes, nesting, and literals', () => {
    const text = '{"a":"x\\ny","b":[true,false,null],"c":{"d":[{"e":11111111111111111111}]}}';

    expect(parseLossless(text)).toEqual({
      a: 'x\ny',
      b: [true, false, null],
      c: { d: [{ e: 11111111111111111111n }] },
    });
  });

  it('is not confused by a long digit run inside a string', () => {
    expect(parseLossless('{"a":"1234567890123456789","b":1}')).toEqual({
      a: '1234567890123456789',
      b: 1,
    });
  });

  it('stores a prototype-polluting key as an own property', () => {
    const parsed = parseLossless('{"__proto__":{"polluted":11111111111111111111},"a":1}') as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parsed.a).toBe(1);
  });

  it('refuses text after the value', () => {
    expect(() => parseLossless('{"a":11111111111111111111} trailing')).toThrow(SyntaxError);
  });

  it('refuses an unterminated string', () => {
    expect(() => parseLossless('{"a":"11111111111111111111')).toThrow(SyntaxError);
  });
});

describe('stringifyLossless', () => {
  it('writes a bigint as a JSON number', () => {
    expect(stringifyLossless({ a: 9223372036854775807n })).toBe('{"a":9223372036854775807}');
  });

  it('round-trips a 64-bit value', () => {
    const value = { longValue: -9223372036854775808n };
    const parsed = parseLossless(stringifyLossless(value)) as { longValue: bigint };

    expect(parsed.longValue).toBe(value.longValue);
  });

  it('matches JSON.stringify for everything else', () => {
    const value = {
      s: 'a"b\\c\nd',
      n: 1.5,
      b: true,
      z: null,
      list: [1, 'two', false, null],
      nested: { deep: { deeper: [] } },
    };

    expect(stringifyLossless(value)).toBe(JSON.stringify(value));
  });

  it('omits undefined in an object and writes null in an array', () => {
    expect(stringifyLossless({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(stringifyLossless([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('writes a non-finite number as null, as JSON.stringify does', () => {
    expect(stringifyLossless([Number.NaN, Number.POSITIVE_INFINITY])).toBe('[null,null]');
  });

  it('uses toJSON when a value has one', () => {
    expect(stringifyLossless({ at: new Date(0) })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
  });

  it('writes a Map as an object', () => {
    expect(stringifyLossless(new Map([['a', 1n]]))).toBe('{"a":1}');
  });

  it('escapes control characters', () => {
    expect(stringifyLossless('')).toBe('"\\u0001"');
  });

  it('refuses a value nested past the depth limit', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 300; i++) deep = [deep];

    expect(() => stringifyLossless(deep)).toThrow(TypeError);
  });
});

describe('asBigInt and asNumber', () => {
  it('read every wire form of a 64-bit value', () => {
    expect(asBigInt(5)).toBe(5n);
    expect(asBigInt(5n)).toBe(5n);
    expect(asBigInt('5')).toBe(5n);
    expect(asBigInt('nope', 7n)).toBe(7n);
    expect(asBigInt(undefined)).toBe(0n);

    expect(asNumber(5)).toBe(5);
    expect(asNumber(5n)).toBe(5);
    expect(asNumber('5')).toBe(5);
    expect(asNumber(Number.NaN, 3)).toBe(3);
  });
});
