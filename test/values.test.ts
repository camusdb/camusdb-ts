import { describe, expect, it } from 'vitest';

import { ColumnType, columnTypeName, isColumnType } from '../src/column-type.js';
import { columnValueToJson } from '../src/column-value.js';
import { CamusError } from '../src/errors.js';
import { CamusObjectId } from '../src/object-id.js';
import { CamusVector } from '../src/vector.js';
import { decodeValue } from '../src/values/decode.js';
import { encodeParameter, encodeParameters } from '../src/values/encode.js';
import { dateToDayTicks, dateToTicks, ticksToDate } from '../src/values/ticks.js';
import { camus } from '../src/values/typed.js';
import { bytesToUuid, halvesToUuid, isUuid, uuidToBytes, uuidToHalves } from '../src/values/uuid.js';

describe('ticks', () => {
  it('round-trips the Unix epoch', () => {
    const epoch = new Date(0);

    expect(dateToTicks(epoch)).toBe(621355968000000000n);
    expect(ticksToDate(dateToTicks(epoch)).getTime()).toBe(0);
  });

  it('round-trips an ordinary instant', () => {
    const instant = new Date('2024-03-15T12:34:56.789Z');

    expect(ticksToDate(dateToTicks(instant)).toISOString()).toBe(instant.toISOString());
  });

  it('round-trips an instant before the epoch', () => {
    const instant = new Date('1900-01-01T00:00:00.000Z');

    expect(ticksToDate(dateToTicks(instant)).toISOString()).toBe(instant.toISOString());
  });

  it('truncates a date column to UTC midnight', () => {
    const instant = new Date('2024-03-15T23:59:59.999Z');
    const midnight = ticksToDate(dateToDayTicks(instant));

    expect(midnight.toISOString()).toBe('2024-03-15T00:00:00.000Z');
  });

  it('truncates toward the past before the epoch', () => {
    const instant = new Date('1900-06-15T13:00:00.000Z');

    expect(ticksToDate(dateToDayTicks(instant)).toISOString()).toBe('1900-06-15T00:00:00.000Z');
  });

  it('refuses an invalid date', () => {
    expect(() => dateToTicks(new Date('nope'))).toThrow(RangeError);
  });
});

describe('uuid', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';

  it('recognizes a canonical string', () => {
    expect(isUuid(uuid)).toBe(true);
    expect(isUuid(uuid.toUpperCase())).toBe(true);
    expect(isUuid('550e8400e29b41d4a716446655440000')).toBe(false);
    expect(isUuid('not a uuid')).toBe(false);
  });

  it('round-trips through bytes', () => {
    expect(bytesToUuid(uuidToBytes(uuid))).toBe(uuid);
  });

  it('round-trips through halves', () => {
    const { high, low } = uuidToHalves(uuid);

    expect(halvesToUuid(high, low)).toBe(uuid);
  });

  it('round-trips a value whose high half is negative as a signed integer', () => {
    const large = 'ffffffff-ffff-ffff-8000-000000000001';
    const { high, low } = uuidToHalves(large);

    expect(high).toBe(-1n);
    expect(halvesToUuid(high, low)).toBe(large);
  });

  it('refuses the wrong byte count', () => {
    expect(() => bytesToUuid(new Uint8Array(15))).toThrow(TypeError);
    expect(() => uuidToBytes('abc')).toThrow(TypeError);
  });
});

describe('CamusObjectId', () => {
  it('generates 24 lowercase hexadecimal characters', () => {
    const id = CamusObjectId.generateAsString();

    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('round-trips through its string form', () => {
    const id = CamusObjectId.generate();

    expect(CamusObjectId.parse(id.toString()).equals(id)).toBe(true);
  });

  it('generates increasing ids inside one second', () => {
    const first = CamusObjectId.generate();
    const second = CamusObjectId.generate();

    expect(second.compareTo(first)).toBeGreaterThan(0);
  });

  it('reports the null value', () => {
    expect(new CamusObjectId(0, 0, 0).isNull()).toBe(true);
    expect(CamusObjectId.generate().isNull()).toBe(false);
  });

  it('produces 12 bytes', () => {
    expect(CamusObjectId.generate().toBytes()).toHaveLength(12);
  });

  it('refuses a value that is not 24 hexadecimal characters', () => {
    expect(() => CamusObjectId.parse('abc')).toThrow(TypeError);
    expect(() => CamusObjectId.parse('z'.repeat(24))).toThrow(TypeError);
  });

  it('renders as its string form in JSON', () => {
    const id = CamusObjectId.generate();

    expect(JSON.stringify({ id })).toBe(`{"id":"${id.toString()}"}`);
  });
});

describe('CamusVector', () => {
  it('round-trips an embedding', () => {
    const vector = [0.5, -1.25, 0, 3.75];
    const bytes = CamusVector.toBytes(vector);

    expect(bytes).toHaveLength(16);
    expect([...CamusVector.toFloats(bytes)]).toEqual(vector);
  });

  it('reports the dimension count', () => {
    expect(CamusVector.dimensions(new Uint8Array(32))).toBe(8);
  });

  it('refuses a byte count that is not a multiple of four', () => {
    expect(() => CamusVector.dimensions(new Uint8Array(7))).toThrow(CamusError);

    try {
      CamusVector.dimensions(new Uint8Array(7));
    } catch (error) {
      expect(CamusError.is(error) && error.code).toBe('CADB0410');
    }
  });
});

describe('encodeParameter', () => {
  it('infers a column type from a JavaScript value', () => {
    expect(encodeParameter(null).type).toBe(ColumnType.Null);
    expect(encodeParameter(undefined).type).toBe(ColumnType.Null);
    expect(encodeParameter(true)).toEqual({ type: ColumnType.Bool, boolValue: true });
    expect(encodeParameter(42)).toEqual({ type: ColumnType.Integer64, longValue: 42n });
    expect(encodeParameter(1.5)).toEqual({ type: ColumnType.Float64, floatValue: 1.5 });
    expect(encodeParameter(7n)).toEqual({ type: ColumnType.Integer64, longValue: 7n });
    expect(encodeParameter('x')).toEqual({ type: ColumnType.String, strValue: 'x' });
  });

  it('sends a Date as a datetime', () => {
    const value = encodeParameter(new Date('2024-01-01T00:00:00Z'));

    expect(value.type).toBe(ColumnType.DateTime);
    expect(ticksToDate(value.longValue!).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('does not read a UUID-shaped string as a uuid', () => {
    expect(encodeParameter('550e8400-e29b-41d4-a716-446655440000').type).toBe(ColumnType.String);
  });

  it('sends an ObjectId as an id', () => {
    const id = CamusObjectId.generate();

    expect(encodeParameter(id)).toEqual({ type: ColumnType.Id, strValue: id.toString() });
  });

  it('sends bytes as bytes', () => {
    const value = encodeParameter(new Uint8Array([1, 2, 3]));

    expect(value.type).toBe(ColumnType.Bytes);
    expect([...value.bytesValue!]).toEqual([1, 2, 3]);
  });

  it('packs a Float32Array as a vector', () => {
    const value = encodeParameter(new Float32Array([1, 2]));

    expect(value.type).toBe(ColumnType.Bytes);
    expect([...CamusVector.toFloats(value.bytesValue!)]).toEqual([1, 2]);
  });

  it('infers an array element type from the first element that is not null', () => {
    const value = encodeParameter([null, 'b', null]);

    expect(value.type).toBe(ColumnType.Array);
    expect(value.arrayElementType).toBe(ColumnType.String);
    expect(value.arrayValues).toHaveLength(3);
    expect(value.arrayValues![0]!.type).toBe(ColumnType.Null);
    expect(value.arrayValues![1]!.strValue).toBe('b');
  });

  it('infers nothing from an empty array', () => {
    const value = encodeParameter([]);

    expect(value.arrayElementType).toBe(ColumnType.Null);
    expect(value.arrayValues).toHaveLength(0);
  });

  it('refuses an array whose elements are all null', () => {
    expect(() => encodeParameter([null, null])).toThrow(CamusError);
  });

  it('refuses a value it cannot map', () => {
    expect(() => encodeParameter(Symbol('x'))).toThrow(CamusError);
    expect(() => encodeParameter({ a: 1 })).toThrow(CamusError);
  });
});

describe('camus helpers', () => {
  it('states a uuid', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const value = encodeParameter(camus.uuid(uuid));

    expect(value.type).toBe(ColumnType.Uuid);
    expect(value.strValue).toBe(uuid);
    expect(halvesToUuid(value.uuidHigh!, value.longValue!)).toBe(uuid);
  });

  it('refuses a uuid string that is not canonical', () => {
    expect(() => camus.uuid('nope')).toThrow(CamusError);
  });

  it('states a date-only column', () => {
    const value = encodeParameter(camus.date(new Date('2024-03-15T18:00:00Z')));

    expect(value.type).toBe(ColumnType.Date);
    expect(ticksToDate(value.longValue!).toISOString()).toBe('2024-03-15T00:00:00.000Z');
  });

  it('states a float32 column', () => {
    expect(encodeParameter(camus.float32(1.5))).toEqual({ type: ColumnType.Float32, floatValue: 1.5 });
  });

  it('states an empty array element type', () => {
    const value = encodeParameter(camus.array([], ColumnType.Integer64));

    expect(value.type).toBe(ColumnType.Array);
    expect(value.arrayElementType).toBe(ColumnType.Integer64);
    expect(value.arrayValues).toHaveLength(0);
  });

  it('states an array element type that inference would read differently', () => {
    const value = encodeParameter(camus.array([1, 2], ColumnType.Float64));

    expect(value.arrayElementType).toBe(ColumnType.Float64);
    expect(value.arrayValues!.map((item) => item.floatValue)).toEqual([1, 2]);
  });

  it('passes a hand-built value through', () => {
    const raw = { type: ColumnType.String, strValue: 'x' };

    expect(encodeParameter(camus.raw(raw))).toBe(raw);
  });

  it('refuses an int64 that is not an integer', () => {
    expect(() => camus.int64(1.5)).toThrow(CamusError);
  });
});

describe('encodeParameters', () => {
  it('adds a leading @ to every name', () => {
    const encoded = encodeParameters({ year: 1974, '@name': 'r1' })!;

    expect([...encoded.keys()].sort()).toEqual(['@name', '@year']);
  });

  it('reports no parameters as undefined', () => {
    expect(encodeParameters(undefined)).toBeUndefined();
    expect(encodeParameters({})).toBeUndefined();
  });

  it('refuses the same parameter written both ways', () => {
    expect(() => encodeParameters({ year: 1, '@year': 2 })).toThrow(CamusError);
  });
});

describe('columnValueToJson', () => {
  it('writes only the fields the declared type reads', () => {
    expect(columnValueToJson({ type: ColumnType.Integer64, longValue: 5n, strValue: 'ignored' })).toEqual({
      type: ColumnType.Integer64,
      longValue: 5n,
    });
  });

  it('writes bytes as base64', () => {
    expect(columnValueToJson({ type: ColumnType.Bytes, bytesValue: new Uint8Array([1, 2, 3]) })).toEqual({
      type: ColumnType.Bytes,
      bytesValue: 'AQID',
    });
  });

  it('keeps a 64-bit value as a bigint', () => {
    const json = columnValueToJson({ type: ColumnType.Integer64, longValue: 9223372036854775807n });

    expect(json.longValue).toBe(9223372036854775807n);
  });
});

describe('decodeValue', () => {
  it('maps every column type to a JavaScript value', () => {
    expect(decodeValue({ type: ColumnType.Null })).toBeNull();
    expect(decodeValue({ type: ColumnType.String, strValue: 'x' })).toBe('x');
    expect(decodeValue({ type: ColumnType.Id, strValue: 'abc' })).toBe('abc');
    expect(decodeValue({ type: ColumnType.Bool, boolValue: true })).toBe(true);
    expect(decodeValue({ type: ColumnType.Float64, floatValue: 1.5 })).toBe(1.5);
    expect(decodeValue({ type: ColumnType.Integer64, longValue: 5n })).toBe(5);
  });

  it('reads an int64 as a number when it is safe and a bigint when it is not', () => {
    expect(decodeValue({ type: ColumnType.Integer64, longValue: 5n }, { int64: 'auto' })).toBe(5);
    expect(decodeValue({ type: ColumnType.Integer64, longValue: 9007199254740993n }, { int64: 'auto' })).toBe(
      9007199254740993n,
    );
  });

  it('honours an explicit int64 mode', () => {
    expect(decodeValue({ type: ColumnType.Integer64, longValue: 5n }, { int64: 'bigint' })).toBe(5n);
    expect(
      decodeValue({ type: ColumnType.Integer64, longValue: 9007199254740993n }, { int64: 'number' }),
    ).toBe(9007199254740992);
  });

  it('reads a uuid from its halves', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const { high, low } = uuidToHalves(uuid);

    expect(decodeValue({ type: ColumnType.Uuid, uuidHigh: high, longValue: low })).toBe(uuid);
  });

  it('falls back to the canonical string for an all-zero uuid', () => {
    expect(decodeValue({ type: ColumnType.Uuid, uuidValue: '00000000-0000-0000-0000-000000000000' })).toBe(
      '00000000-0000-0000-0000-000000000000',
    );
  });

  it('reads a date as a UTC Date', () => {
    const value = decodeValue({
      type: ColumnType.DateTime,
      longValue: dateToTicks(new Date('2024-03-15T12:00:00Z')),
    });

    expect((value as Date).toISOString()).toBe('2024-03-15T12:00:00.000Z');
  });

  it('reads an array element by element', () => {
    const value = decodeValue({
      type: ColumnType.Array,
      arrayElementType: ColumnType.Integer64,
      arrayValues: [{ type: ColumnType.Integer64, longValue: 1n }, { type: ColumnType.Null }],
    });

    expect(value).toEqual([1, null]);
  });
});

describe('columnTypeName', () => {
  it('names every declared type', () => {
    expect(columnTypeName(ColumnType.Uuid)).toBe('Uuid');
    expect(columnTypeName(99 as ColumnType)).toBe('Unknown(99)');
    expect(isColumnType(11)).toBe(true);
    expect(isColumnType(99)).toBe(false);
  });
});
