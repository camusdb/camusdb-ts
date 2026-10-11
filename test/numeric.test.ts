import { describe, expect, it } from 'vitest';

import { ColumnType, columnTypeName, isColumnType } from '../src/column-type.js';
import { columnValueToJson } from '../src/column-value.js';
import { CamusErrorCode } from '../src/error-codes.js';
import { CamusError } from '../src/errors.js';
import { parseLossless, stringifyLossless } from '../src/json.js';
import { frameCost } from '../src/transport/grpc/batch-frames.js';
import { buildResultSet, decodeValue as decodeGrpc, encodeValue } from '../src/transport/grpc/codec.js';
import { GrpcBatchStatementKind } from '../src/transport/grpc/messages.js';
import { loadGrpc, serviceConstructor } from '../src/transport/grpc/proto.js';
import { decodeCell, resultSetFromWire } from '../src/transport/rest-decode.js';
import { decodeValue } from '../src/values/decode.js';
import { encodeParameter } from '../src/values/encode.js';
import { camus } from '../src/values/typed.js';

/** Wider than a JavaScript number and wider than a .NET decimal. */
const WIDE = '12345678901234567890.123456789';

describe('the numeric column type', () => {
  it('is wire type 12', () => {
    expect(ColumnType.Numeric).toBe(12);
    expect(isColumnType(12)).toBe(true);
    expect(columnTypeName(ColumnType.Numeric)).toBe('Numeric');
  });
});

describe('camus.numeric', () => {
  it('binds a string as it is', () => {
    expect(encodeParameter(camus.numeric(WIDE))).toEqual({ type: ColumnType.Numeric, strValue: WIDE });
  });

  it('accepts the forms the server reads', () => {
    for (const text of ['0', '-12.5', '+3', '1.', '.5', '1.5e3', '1E-9', '-0.000000001']) {
      expect(encodeParameter(camus.numeric(text)).strValue).toBe(text);
    }
  });

  it('trims white space around the text', () => {
    expect(encodeParameter(camus.numeric(' 9.99 ')).strValue).toBe('9.99');
  });

  it('refuses text that is not a decimal number', () => {
    for (const text of ['', 'abc', '1.2.3', '1e', '--1', '.', '0x10', 'NaN', '1,5']) {
      expect(() => camus.numeric(text), text).toThrow(CamusError);
    }
  });

  it('binds a bigint with every digit', () => {
    expect(encodeParameter(camus.numeric(123456789012345678901234567890n)).strValue).toBe(
      '123456789012345678901234567890',
    );
  });

  it('binds a number as its shortest text, not its binary value', () => {
    expect(encodeParameter(camus.numeric(0.1)).strValue).toBe('0.1');
    expect(encodeParameter(camus.numeric(19.99)).strValue).toBe('19.99');
    expect(encodeParameter(camus.numeric(42)).strValue).toBe('42');
    expect(encodeParameter(camus.numeric(1e21)).strValue).toBe('1e+21');
  });

  it('refuses a number that is not finite', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      try {
        camus.numeric(value);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CamusError);
        expect((error as CamusError).code).toBe(CamusErrorCode.InvalidParameter);
      }
    }
  });

  it('refuses an array of numerics, because the server has no ARRAY(NUMERIC)', () => {
    expect(() => camus.array(['1.5'], ColumnType.Numeric)).toThrow(/ARRAY\(NUMERIC\)/);
    expect(() => encodeParameter([camus.numeric('1.5'), camus.numeric('2')])).toThrow(/ARRAY\(NUMERIC\)/);
  });

  it('does not change what a plain number binds as', () => {
    expect(encodeParameter(19.99)).toEqual({ type: ColumnType.Float64, floatValue: 19.99 });
  });
});

describe('a numeric value on REST', () => {
  it('writes the decimal text in strValue', () => {
    const json = stringifyLossless(columnValueToJson(encodeParameter(camus.numeric(WIDE))));

    expect(JSON.parse(json)).toEqual({ type: 12, strValue: WIDE });
  });

  it('reads the canonical text of a numeric column', () => {
    const result = resultSetFromWire(
      [{ name: 'price', type: ColumnType.Numeric }],
      parseLossless(`[["${WIDE}"],["-0.5"],[null]]`),
    );

    expect(result.rawRow(0)[0]).toEqual({ type: ColumnType.Numeric, strValue: WIDE });
    expect(decodeValue(result.cell(1, 0))).toBe('-0.5');
    expect(decodeValue(result.cell(2, 0))).toBeNull();
  });

  it('reads a JSON number in a numeric column as numeric text', () => {
    // SELECT COALESCE(p, 0) with a NULL p: the metadata says numeric, the cell is the int64 0.
    expect(decodeCell(0, ColumnType.Numeric)).toEqual({ type: ColumnType.Numeric, strValue: '0' });
    expect(decodeCell(1.5, ColumnType.Numeric)).toEqual({ type: ColumnType.Numeric, strValue: '1.5' });

    const wide = parseLossless('[123456789012345678901234567890]') as unknown[];
    expect(decodeCell(wide[0], ColumnType.Numeric)).toEqual({
      type: ColumnType.Numeric,
      strValue: '123456789012345678901234567890',
    });
  });

  it('reads a numeric through decodeValue as its exact string', () => {
    expect(decodeValue({ type: ColumnType.Numeric, strValue: WIDE })).toBe(WIDE);
  });
});

describe('a numeric value on gRPC', () => {
  it('travels in numericValue', () => {
    expect(encodeValue({ type: ColumnType.Numeric, strValue: WIDE })).toEqual({ numericValue: WIDE });
    expect(decodeGrpc({ kind: 'numericValue', numericValue: '-12.5' })).toEqual({
      type: ColumnType.Numeric,
      strValue: '-12.5',
    });
  });

  it('infers the branch when the message carries no kind', () => {
    expect(decodeGrpc({ numericValue: '7' })).toEqual({ type: ColumnType.Numeric, strValue: '7' });
  });

  it('builds a result set with numeric cells', () => {
    const result = buildResultSet({ columns: [{ name: 'total', type: ColumnType.Numeric }] }, [
      { values: [{ kind: 'numericValue', numericValue: WIDE }] },
    ]);

    expect(result.columns[0]!.typeName).toBe('Numeric');
    expect(decodeValue(result.cell(0, 0))).toBe(WIDE);
  });

  it('reads a number in a numeric column as numeric text, as REST does', () => {
    // SELECT COALESCE(p, 0) with a NULL p: the schema says numeric, the value is the int64 0.
    const result = buildResultSet({ columns: [{ name: 'p', type: ColumnType.Numeric }] }, [
      { values: [{ kind: 'int64Value', int64Value: '0' }] },
      { values: [{ kind: 'float64Value', float64Value: 1.5 }] },
      { values: [{ kind: 'nullValue', nullValue: 0 }] },
    ]);

    expect(result.cell(0, 0)).toEqual({ type: ColumnType.Numeric, strValue: '0' });
    expect(result.cell(1, 0)).toEqual({ type: ColumnType.Numeric, strValue: '1.5' });
    expect(decodeValue(result.cell(2, 0))).toBeNull();
  });

  it('counts the text in the frame cost', () => {
    const cost = (text: string): number =>
      frameCost({
        requestId: 1,
        kind: GrpcBatchStatementKind.Query,
        request: {
          database: 'd',
          sql: 's',
          parameters: { '@p': { kind: 'numericValue', numericValue: text } },
        },
      });

    const short = cost('1');
    const long = cost(WIDE);

    expect(long - short).toBe(WIDE.length - 1);
  });

  it('round-trips through the protobuf encoding of the proto file', async () => {
    const { definition } = await loadGrpc();
    const sql = serviceConstructor(definition, 'CamusSql') as unknown as {
      service: Record<
        string,
        {
          requestSerialize: (value: unknown) => Buffer;
          requestDeserialize: (bytes: Buffer) => { parameters: Record<string, unknown> };
        }
      >;
    };
    const method = sql.service.ExecuteQuery!;

    const bytes = method.requestSerialize({
      database: 'd',
      sql: 'SELECT @p',
      parameters: { '@p': encodeValue({ type: ColumnType.Numeric, strValue: WIDE }) },
    });

    const decoded = method.requestDeserialize(bytes).parameters['@p'] as Parameters<typeof decodeGrpc>[0];

    expect(decoded.kind).toBe('numericValue');
    expect(decodeGrpc(decoded)).toEqual({ type: ColumnType.Numeric, strValue: WIDE });
  });
});
