/**
 * Offline coverage for Infinity, -Infinity, and NaN in float columns over REST. JSON has no number
 * for these values, so a server with the PostgreSQL float rule writes them as the strings
 * "Infinity", "-Infinity", and "NaN", in a cell and in an array element, and reads the same strings
 * in a float parameter. The cases are those of the .NET driver.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NO_CREDENTIALS } from '../src/auth/credentials.js';
import { CamusTokenProvider } from '../src/auth/token-provider.js';
import { ColumnType } from '../src/column-type.js';
import { columnValueToJson } from '../src/column-value.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { parseLossless } from '../src/json.js';
import { decodeCell, resultSetFromWire } from '../src/transport/rest-decode.js';
import { RestTransport } from '../src/transport/rest-transport.js';
import type { TransportSqlRequest } from '../src/transport/transport.js';
import { decodeValue } from '../src/values/decode.js';
import { encodeParameter } from '../src/values/encode.js';
import { FakeCamusServer } from './support/fake-server.js';

const NON_FINITE: [string, number][] = [
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['NaN', Number.NaN],
];

function decodeBody(text: string): unknown[][] {
  const body = parseLossless(text) as { columns: unknown; rows: unknown };
  const result = resultSetFromWire(body.columns, body.rows);
  const rows: unknown[][] = [];

  for (let r = 0; r < result.rowCount; r++) {
    const row: unknown[] = [];
    for (let c = 0; c < result.columnCount; c++) row.push(decodeValue(result.cell(r, c)));
    rows.push(row);
  }

  return rows;
}

describe('a non-finite float cell over REST', () => {
  it.each(NON_FINITE)('reads %j in a float64 cell as the float value', (text, value) => {
    expect(decodeCell(text, ColumnType.Float64)).toEqual({ type: ColumnType.Float64, floatValue: value });
  });

  it.each(NON_FINITE)('reads %j in a float32 cell as the float value', (text, value) => {
    expect(decodeCell(text, ColumnType.Float32)).toEqual({ type: ColumnType.Float32, floatValue: value });
  });

  it('decodes a whole body as gRPC gives it', () => {
    const body =
      `{"status":"ok","columns":[{"name":"g","type":${String(ColumnType.Float64)}},` +
      `{"name":"f","type":${String(ColumnType.Float32)}}],` +
      '"rows":[["Infinity","-Infinity"],["NaN",1.5]]}';

    expect(decodeBody(body)).toEqual([
      [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      [Number.NaN, 1.5],
    ]);
  });

  it('reads the names in a float array element', () => {
    const body =
      `{"status":"ok","columns":[{"name":"a","type":10,"elementType":${String(ColumnType.Float64)}},` +
      `{"name":"b","type":10,"elementType":${String(ColumnType.Float32)}}],` +
      '"rows":[[[1.5,"Infinity",null,"NaN"],["-Infinity",0.1]]]}';

    expect(decodeBody(body)).toEqual([
      [
        [1.5, Number.POSITIVE_INFINITY, null, Number.NaN],
        [Number.NEGATIVE_INFINITY, Math.fround(0.1)],
      ],
    ]);
  });

  it.each(['infinity', 'inf', '+Infinity', 'nan', ' NaN', 'Infinity ', '1.5', ''])(
    'keeps %j in a float cell as a string',
    (text) => {
      expect(decodeCell(text, ColumnType.Float64)).toEqual({ type: ColumnType.String, strValue: text });
      expect(decodeCell(text, ColumnType.Float32)).toEqual({ type: ColumnType.String, strValue: text });
    },
  );

  it.each(NON_FINITE)('keeps %j in a column that is not a float as a string', (text) => {
    expect(decodeCell(text, ColumnType.String)).toEqual({ type: ColumnType.String, strValue: text });
    expect(decodeCell(text, ColumnType.Integer64)).toEqual({ type: ColumnType.String, strValue: text });
  });

  it('keeps the names as strings in an array with no element type', () => {
    const body = '{"status":"ok","columns":[{"name":"a","type":10}],"rows":[[["Infinity","NaN"]]]}';

    expect(decodeBody(body)).toEqual([[['Infinity', 'NaN']]]);
  });
});

describe('a non-finite float parameter over REST', () => {
  it.each(NON_FINITE)('writes %j by name', (text, value) => {
    expect(columnValueToJson({ type: ColumnType.Float64, floatValue: value })).toEqual({
      type: ColumnType.Float64,
      floatValue: text,
    });
    expect(columnValueToJson({ type: ColumnType.Float32, floatValue: value })).toEqual({
      type: ColumnType.Float32,
      floatValue: text,
    });
  });

  it('keeps a finite number, and the sign of a negative zero', () => {
    expect(columnValueToJson({ type: ColumnType.Float64, floatValue: 1.5 })).toEqual({
      type: ColumnType.Float64,
      floatValue: 1.5,
    });
    expect(Object.is(columnValueToJson({ type: ColumnType.Float64, floatValue: -0 }).floatValue, -0)).toBe(
      true,
    );
  });

  it('writes a non-finite array element by name', () => {
    const json = columnValueToJson(encodeParameter([1.5, Number.POSITIVE_INFINITY, Number.NaN]));

    expect(json.arrayValues!.map((item) => item.floatValue)).toEqual([1.5, 'Infinity', 'NaN']);
  });
});

describe('a non-finite float parameter in a request', () => {
  let server: FakeCamusServer;

  beforeAll(async () => {
    server = await FakeCamusServer.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
    CamusEndpointPool.resetShared();
    CamusTokenProvider.resetShared();
  });

  function transport(): RestTransport {
    const auth = new CamusTokenProvider({
      credentials: NO_CREDENTIALS,
      resolveLoginClient: () => {
        throw new Error('no login expected');
      },
      resolveEndpoint: () => server.endpoint,
      resolveTimeoutSeconds: () => 5,
    });

    return new RestTransport(new CamusEndpointPool(server.endpoint), auth);
  }

  function sqlRequest(overrides: Partial<TransportSqlRequest>): TransportSqlRequest {
    return {
      endpoint: server.endpoint,
      database: 'test',
      sql: 'SELECT * FROM t WHERE a = @a',
      timeoutSeconds: 5,
      prepared: false,
      routingAcceptVersion: 0,
      ...overrides,
    };
  }

  it('sends an inline parameter by name', async () => {
    server.json('execute-sql-query', { status: 'ok', columns: [], rows: [] });

    await transport().executeQuery(
      sqlRequest({
        parameters: new Map([
          ['@a', encodeParameter(Number.NEGATIVE_INFINITY)],
          ['@b', encodeParameter(Number.NaN)],
        ]),
      }),
    );

    const raw = server.requestsTo('execute-sql-query')[0]!.rawBody;

    const float64 = String(ColumnType.Float64);

    expect(raw).toContain(`"@a":{"type":${float64},"floatValue":"-Infinity"}`);
    expect(raw).toContain(`"@b":{"type":${float64},"floatValue":"NaN"}`);
  });

  it('sends a prepared parameter by name', async () => {
    server.json('prepare-sql-statement', { status: 'ok', statementId: 'stmt-1', parameterNames: ['@a'] });
    server.json('execute-sql-query', { status: 'ok', columns: [], rows: [] });

    await transport().executeQuery(
      sqlRequest({
        prepared: true,
        parameters: new Map([['@a', { type: ColumnType.Float32, floatValue: Number.POSITIVE_INFINITY }]]),
      }),
    );

    const body = server.requestsTo('execute-sql-query')[0]!.body as Record<string, unknown>;

    expect(body.positionalParameters).toEqual([{ type: ColumnType.Float32, floatValue: 'Infinity' }]);
  });
});
