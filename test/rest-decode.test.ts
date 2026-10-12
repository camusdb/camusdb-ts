import { describe, expect, it } from 'vitest';

import { ColumnType } from '../src/column-type.js';
import type { ColumnValue } from '../src/column-value.js';
import { parseLossless } from '../src/json.js';
import { decodeValue as decodeGrpc, encodeValue } from '../src/transport/grpc/codec.js';
import { decodeCell, readSchema, resultSetFromWire } from '../src/transport/rest-decode.js';
import { decodeValue } from '../src/values/decode.js';
import { dateToDayTicks, dateToTicks } from '../src/values/ticks.js';
import { uuidToHalves } from '../src/values/uuid.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';

// The halves exactly as the server writes them: signed 64-bit integers.
const UUID_PAIR = '[6128981282234515924,-6406858213580079104]';

const DAY = new Date('2024-03-15T00:00:00.000Z');
const INSTANT = new Date('2024-03-15T12:34:56.789Z');
const DAY_TICKS = dateToDayTicks(DAY).toString();
const INSTANT_TICKS = dateToTicks(INSTANT).toString();

/** The float32 nearest -9.321863e23, which the server writes as its shortest text. */
const FLOAT32 = Math.fround(-9.321863e23);

/**
 * Decodes a REST query body, written as the raw text a server sends, to the values a caller sees.
 */
function decodeBody(text: string, int64: 'auto' | 'bigint' = 'auto'): unknown[][] {
  const body = parseLossless(text) as { columns: unknown; rows: unknown };
  const result = resultSetFromWire(body.columns, body.rows);

  const rows: unknown[][] = [];

  for (let r = 0; r < result.rowCount; r++) {
    const row: unknown[] = [];
    for (let c = 0; c < result.columnCount; c++) row.push(decodeValue(result.cell(r, c), { int64 }));
    rows.push(row);
  }

  return rows;
}

/** One array column with the given element type, and one row holding `cell`. */
function arrayBody(cell: string, elementType?: ColumnType): string {
  const type = elementType === undefined ? '' : `,"elementType":${String(elementType)}`;

  return `{"status":"ok","columns":[{"name":"a","type":10${type}}],"rows":[[${cell}]]}`;
}

function decodeArray(cell: string, elementType?: ColumnType, int64: 'auto' | 'bigint' = 'auto'): unknown {
  return decodeBody(arrayBody(cell, elementType), int64)[0]![0];
}

function rawArray(cell: string, elementType?: ColumnType): ColumnValue {
  const body = parseLossless(arrayBody(cell, elementType)) as { columns: unknown; rows: unknown };
  return resultSetFromWire(body.columns, body.rows).cell(0, 0);
}

describe('readSchema', () => {
  it('reads the element type of an array column', () => {
    const schema = readSchema([
      { name: 'id', type: ColumnType.Integer64 },
      { name: 'ad', type: ColumnType.Array, elementType: ColumnType.Date },
      { name: 'old', type: ColumnType.Array },
    ]);

    expect(schema.elementTypes).toEqual([ColumnType.Null, ColumnType.Date, ColumnType.Null]);
  });

  it('ignores an element type it cannot use', () => {
    const schema = readSchema([
      { name: 'unknown', type: ColumnType.Array, elementType: 99 },
      { name: 'nested', type: ColumnType.Array, elementType: ColumnType.Array },
      { name: 'text', type: ColumnType.Array, elementType: 'x' },
      { name: 'scalar', type: ColumnType.Integer64, elementType: ColumnType.Date },
    ]);

    expect(schema.elementTypes).toEqual([ColumnType.Null, ColumnType.Null, ColumnType.Null, ColumnType.Null]);
  });
});

describe('a typed REST array', () => {
  it('decodes date and datetime elements as Date', () => {
    expect(decodeArray(`[${DAY_TICKS},null]`, ColumnType.Date)).toEqual([DAY, null]);
    expect(decodeArray(`[${INSTANT_TICKS}]`, ColumnType.DateTime)).toEqual([INSTANT]);
  });

  it('decodes bytes elements from base64', () => {
    expect(decodeArray('["AQID",""]', ColumnType.Bytes)).toEqual([
      new Uint8Array([1, 2, 3]),
      new Uint8Array(0),
    ]);
  });

  it('decodes uuid elements from their halves', () => {
    expect(decodeArray(`[${UUID_PAIR},null]`, ColumnType.Uuid)).toEqual([UUID, null]);
  });

  it('decodes float64 elements as numbers, whole or not, keeping a negative zero', () => {
    const decoded = decodeArray('[0,-0,1.5,3,1E+300]', ColumnType.Float64, 'bigint') as number[];

    expect(decoded).toEqual([0, -0, 1.5, 3, 1e300]);
    expect(Object.is(decoded[1], -0)).toBe(true);
    expect(decoded.every((item) => typeof item === 'number')).toBe(true);
  });

  it('rounds float32 elements to single precision', () => {
    const decoded = decodeArray('[-9.321863E+23,-0,0.1]', ColumnType.Float32) as number[];

    expect(decoded).toEqual([FLOAT32, -0, Math.fround(0.1)]);
    expect(Object.is(decoded[1], -0)).toBe(true);
  });

  it('decodes int64 elements per the int64 mode', () => {
    expect(decodeArray('[1,9223372036854775807]', ColumnType.Integer64)).toEqual([1, 9223372036854775807n]);
    expect(decodeArray('[1,2]', ColumnType.Integer64, 'bigint')).toEqual([1n, 2n]);
  });

  it('decodes bool, string, id, and numeric elements', () => {
    expect(decodeArray('[true,false,null]', ColumnType.Bool)).toEqual([true, false, null]);
    expect(decodeArray('["a","1"]', ColumnType.String)).toEqual(['a', '1']);
    expect(decodeArray('["6630f5b2c7a7e1e2a3b4c5d6"]', ColumnType.Id)).toEqual(['6630f5b2c7a7e1e2a3b4c5d6']);
    expect(decodeArray('["12.5"]', ColumnType.Numeric)).toEqual(['12.5']);
  });

  it('reports the schema element type on the array value', () => {
    expect(rawArray('[]', ColumnType.Date).arrayElementType).toBe(ColumnType.Date);
    expect(rawArray('[null]', ColumnType.Float64).arrayElementType).toBe(ColumnType.Float64);
  });

  it('decodes exactly as gRPC does', () => {
    const halves = uuidToHalves(UUID);

    const cases: [string, ColumnType, ColumnValue[]][] = [
      [`[${DAY_TICKS}]`, ColumnType.Date, [{ type: ColumnType.Date, longValue: BigInt(DAY_TICKS) }]],
      [
        `[${INSTANT_TICKS}]`,
        ColumnType.DateTime,
        [{ type: ColumnType.DateTime, longValue: BigInt(INSTANT_TICKS) }],
      ],
      ['["AQID"]', ColumnType.Bytes, [{ type: ColumnType.Bytes, bytesValue: new Uint8Array([1, 2, 3]) }]],
      [
        `[${UUID_PAIR}]`,
        ColumnType.Uuid,
        [{ type: ColumnType.Uuid, uuidHigh: halves.high, longValue: halves.low }],
      ],
      [
        '[0,-0,2.5]',
        ColumnType.Float64,
        [0, -0, 2.5].map((floatValue) => ({ type: ColumnType.Float64, floatValue })),
      ],
      // A gRPC float32 arrives through a protobuf `float`, so it already is single precision.
      ['[-9.321863E+23]', ColumnType.Float32, [{ type: ColumnType.Float32, floatValue: FLOAT32 }]],
      [
        '[7,null]',
        ColumnType.Integer64,
        [{ type: ColumnType.Integer64, longValue: 7n }, { type: ColumnType.Null }],
      ],
    ];

    for (const [cell, elementType, items] of cases) {
      const grpc = decodeGrpc(
        encodeValue({ type: ColumnType.Array, arrayElementType: elementType, arrayValues: items }),
      );

      for (const int64 of ['auto', 'bigint'] as const) {
        expect(decodeArray(cell, elementType, int64)).toEqual(decodeValue(grpc, { int64 }));
      }

      expect(rawArray(cell, elementType).arrayElementType).toBe(grpc.arrayElementType);
    }
  });
});

describe('an untyped REST array, from a server that reports no element type', () => {
  it('keeps the token reading for the types JSON names', () => {
    expect(decodeArray('["a",null,"b"]')).toEqual(['a', null, 'b']);
    expect(decodeArray('[true,false]')).toEqual([true, false]);
    expect(decodeArray('[1,2]', undefined, 'bigint')).toEqual([1n, 2n]);
    expect(decodeArray('[1.5,2.25]')).toEqual([1.5, 2.25]);
  });

  it('leaves dates and bytes as the tokens they arrived as', () => {
    expect(decodeArray(`[${DAY_TICKS}]`)).toEqual([BigInt(DAY_TICKS)]);
    expect(decodeArray('["AQID"]')).toEqual(['AQID']);
  });

  it('reads a whole-numbered float array as integers, which it cannot tell apart', () => {
    expect(decodeArray('[0,3]', undefined, 'bigint')).toEqual([0n, 3n]);
  });

  it('reads every number as a float when one of them is a fraction or a negative zero', () => {
    const fraction = decodeArray('[0,1.5,3]', undefined, 'bigint') as number[];
    expect(fraction).toEqual([0, 1.5, 3]);
    expect(rawArray('[0,1.5,3]').arrayElementType).toBe(ColumnType.Float64);

    const negativeZero = decodeArray('[-0,2]', undefined, 'bigint') as number[];
    expect(negativeZero).toEqual([-0, 2]);
    expect(Object.is(negativeZero[0], -0)).toBe(true);
  });

  it('recovers uuid elements from their halves', () => {
    expect(decodeArray(`[${UUID_PAIR},null]`)).toEqual([UUID, null]);
    expect(rawArray(`[${UUID_PAIR}]`).arrayElementType).toBe(ColumnType.Uuid);
  });
});

describe('a REST float32 cell', () => {
  it('is rounded to the float32 the server stored', () => {
    const cell = decodeCell(-9.321863e23, ColumnType.Float32);

    expect(cell).toEqual({ type: ColumnType.Float32, floatValue: FLOAT32 });
    expect(cell.floatValue).toBe(-9.321863238689577e23);
  });

  it('decodes the server text as gRPC does', () => {
    const body =
      '{"status":"ok","columns":[{"name":"g","type":6},{"name":"f","type":5}],"rows":[[-9.321863E+23,0.1]]}';

    expect(decodeBody(body)).toEqual([[FLOAT32, 0.1]]);
  });

  it('keeps a negative zero', () => {
    expect(Object.is(decodeCell(-0, ColumnType.Float32).floatValue, -0)).toBe(true);
    expect(Object.is(decodeCell(-0, ColumnType.Float64).floatValue, -0)).toBe(true);
  });

  it('reads a float written as a long integer as a float', () => {
    expect(decodeCell(12345678901234567890n, ColumnType.Float64)).toEqual({
      type: ColumnType.Float64,
      floatValue: Number(12345678901234567890n),
    });
  });
});
