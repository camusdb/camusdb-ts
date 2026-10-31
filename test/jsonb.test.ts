import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CamusTokenProvider } from '../src/auth/token-provider.js';
import { CamusClient } from '../src/client.js';
import { ColumnType, columnTypeName, isColumnType } from '../src/column-type.js';
import { columnValueToJson } from '../src/column-value.js';
import { resolveConnectionString } from '../src/config.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusErrorCode } from '../src/error-codes.js';
import { CamusError } from '../src/errors.js';
import { parseLossless, parseWithRawCells, RawJson, stringifyLossless } from '../src/json.js';
import { CamusPreparedStatementPolicy } from '../src/prepared/policy.js';
import { CamusStatementRouter } from '../src/routing/router.js';
import { frameCost } from '../src/transport/grpc/batch-frames.js';
import { buildResultSet, decodeValue as decodeGrpc, encodeValue } from '../src/transport/grpc/codec.js';
import { GrpcBatchStatementKind } from '../src/transport/grpc/messages.js';
import { loadGrpc, serviceConstructor } from '../src/transport/grpc/proto.js';
import { decodeCell, keepJsonbText, resultSetFromWire } from '../src/transport/rest-decode.js';
import { CamusTransportPool } from '../src/transport/transport-pool.js';
import { decodeValue } from '../src/values/decode.js';
import { encodeParameter } from '../src/values/encode.js';
import { formatJsonb, formatJsonbValue } from '../src/values/jsonb.js';
import { camus } from '../src/values/typed.js';
import { FakeCamusServer, respondNdjson } from './support/fake-server.js';

describe('the jsonb column type', () => {
  it('is wire type 13', () => {
    expect(ColumnType.Jsonb).toBe(13);
    expect(isColumnType(13)).toBe(true);
    expect(columnTypeName(ColumnType.Jsonb)).toBe('Jsonb');
  });
});

describe('formatJsonb', () => {
  it('writes one space after each colon and each comma, and no other white space', () => {
    expect(formatJsonb('{ "a" :[1 ,2.50],\n"b":null }')).toBe('{"a": [1, 2.50], "b": null}');
    expect(formatJsonb('[ ]')).toBe('[]');
    expect(formatJsonb(' { } ')).toBe('{}');
  });

  it('keeps the key order and the text of each number', () => {
    expect(formatJsonb('{"b":1,"1":2,"a":1e2,"c":-0.0}')).toBe('{"b": 1, "1": 2, "a": 1e2, "c": -0.0}');
    expect(formatJsonb('123456789012345678901234567890.123456789')).toBe(
      '123456789012345678901234567890.123456789',
    );
  });

  it('writes the PostgreSQL string escapes', () => {
    expect(formatJsonb('"\\u00e9\\u003c\\/\\"\\\\\\n\\u0001"')).toBe('"é</\\"\\\\\\n\\u0001"');
    expect(formatJsonb('"😀"')).toBe('"😀"');
  });

  it('refuses text that is not one JSON value', () => {
    for (const text of ['', ' ', '{', '[1,]', '{"a"}', '01', 'tru', '1 2', '"a\u0001"']) {
      expect(() => formatJsonb(text), text).toThrow(SyntaxError);
    }
  });

  it('reads a document 512 levels deep', () => {
    const deep = `${'['.repeat(512)}${']'.repeat(512)}`;

    expect(formatJsonb(deep)).toBe(deep);
    expect(formatJsonbValue(parseLossless(deep))).toBe(deep);
  });
});

describe('formatJsonbValue', () => {
  it('writes a parsed value in the text form', () => {
    expect(formatJsonbValue({ a: [1, 2.5], b: null, c: 'x"y', d: true })).toBe(
      '{"a": [1, 2.5], "b": null, "c": "x\\"y", "d": true}',
    );
    expect(formatJsonbValue(12345678901234567890n)).toBe('12345678901234567890');
    expect(formatJsonbValue(-0)).toBe('-0');
  });
});

describe('a jsonb parameter', () => {
  it('binds a plain object as jsonb, with no helper', () => {
    expect(encodeParameter({ kind: 'login', user: { id: 7 } })).toEqual({
      type: ColumnType.Jsonb,
      strValue: '{"kind":"login","user":{"id":7}}',
    });

    expect(encodeParameter(Object.assign(Object.create(null) as object, { a: 1 }))).toEqual({
      type: ColumnType.Jsonb,
      strValue: '{"a":1}',
    });
  });

  it('keeps every digit of a bigint inside a document', () => {
    expect(encodeParameter({ n: 12345678901234567890n }).strValue).toBe('{"n":12345678901234567890}');
  });

  it('still refuses an instance of a class', () => {
    class Point {
      x = 1;
    }

    expect(() => encodeParameter(new Point())).toThrow(CamusError);
  });

  it('binds JSON text through camus.jsonb as it is', () => {
    expect(encodeParameter(camus.jsonb('{"kind": "login"}'))).toEqual({
      type: ColumnType.Jsonb,
      strValue: '{"kind": "login"}',
    });
  });

  it('binds an array, a scalar, and the JSON null document through camus.jsonb', () => {
    expect(encodeParameter(camus.jsonb([1, { a: 2 }])).strValue).toBe('[1,{"a":2}]');
    expect(encodeParameter(camus.jsonb(2.5)).strValue).toBe('2.5');
    expect(encodeParameter(camus.jsonb(true)).strValue).toBe('true');
    expect(encodeParameter(camus.jsonb(null))).toEqual({ type: ColumnType.Jsonb, strValue: 'null' });
  });

  it('reads UTF-8 bytes as JSON text', () => {
    expect(encodeParameter(camus.jsonb(new TextEncoder().encode('{"é": 1}'))).strValue).toBe('{"é": 1}');
  });

  it('refuses undefined', () => {
    try {
      camus.jsonb(undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CamusError);
      expect((error as CamusError).code).toBe(CamusErrorCode.InvalidParameter);
    }
  });

  it('refuses an array of documents, because the server has no ARRAY(JSONB)', () => {
    expect(() => encodeParameter([{ a: 1 }, { a: 2 }])).toThrow(/ARRAY\(JSONB\)/);
    expect(() => encodeParameter([camus.jsonb('{}')])).toThrow(/ARRAY\(JSONB\)/);
    expect(() => camus.array([{ a: 1 }], ColumnType.Jsonb)).toThrow(/ARRAY\(JSONB\)/);
  });

  it('does not change what a string binds as', () => {
    expect(encodeParameter('{"a": 1}')).toEqual({ type: ColumnType.String, strValue: '{"a": 1}' });
  });

  it('writes the JSON text in strValue on REST', () => {
    const json = stringifyLossless(columnValueToJson(encodeParameter({ a: 1 })));

    expect(JSON.parse(json)).toEqual({ type: 13, strValue: '{"a":1}' });
  });
});

describe('decodeValue for a jsonb cell', () => {
  const cell = { type: ColumnType.Jsonb, strValue: '{"a": [1, 2.50], "n": 12345678901234567890}' };

  it('parses the document by default', () => {
    expect(decodeValue(cell)).toEqual({ a: [1, 2.5], n: 12345678901234567890n });
  });

  it('gives the text in text mode', () => {
    expect(decodeValue(cell, { int64: 'auto', jsonb: 'text' })).toBe(cell.strValue);
  });

  it('reads the JSON null document as null in parse mode, and as its text in text mode', () => {
    const nullDocument = { type: ColumnType.Jsonb, strValue: 'null' };

    expect(decodeValue(nullDocument)).toBeNull();
    expect(decodeValue(nullDocument, { int64: 'auto', jsonb: 'text' })).toBe('null');
  });
});

describe('parseWithRawCells', () => {
  it('keeps the planned cells of each row list as text', () => {
    const body = parseWithRawCells('{"columns":[1],"rows":[[1,{"a":2.50}],[2,null]],"other":[[3,4]]}', {
      rowsKeys: ['rows'],
      columns: new Set([1]),
    }) as { rows: unknown[][]; other: unknown[][] };

    expect(body.rows[0]).toEqual([1, new RawJson('{"a":2.50}')]);
    expect(body.rows[1]).toEqual([2, new RawJson('null')]);
    expect(body.other[0]).toEqual([3, 4]);
  });

  it('keeps the planned cells of a single row as text', () => {
    expect(parseWithRawCells('[1, [2.0, 3]]', { columns: new Set([1]) })).toEqual([
      1,
      new RawJson('[2.0, 3]'),
    ]);
  });
});

describe('a jsonb column on REST', () => {
  it('keeps the text of a document, with its key order and number scale', () => {
    const text =
      '{"status":"ok","columns":[{"name":"id","type":2},{"name":"doc","type":13}],' +
      '"rows":[[1,{"b":1,"1":2,"a":2.50}],[2,null],[3,"\\u00e9"]]}';

    const body = keepJsonbText(text, parseLossless(text), 'rows') as { columns: unknown; rows: unknown };
    const result = resultSetFromWire(body.columns, body.rows);

    expect(result.cell(0, 1)).toEqual({ type: ColumnType.Jsonb, strValue: '{"b": 1, "1": 2, "a": 2.50}' });
    expect(decodeValue(result.cell(1, 1))).toBeNull();
    expect(decodeValue(result.cell(2, 1))).toBe('é');
  });

  it('gives back a body with no jsonb column as it is', () => {
    const text = '{"columns":[{"name":"n","type":2}],"rows":[[1]]}';
    const parsed = parseLossless(text);

    expect(keepJsonbText(text, parsed, 'rows')).toBe(parsed);
  });

  it('formats a parsed cell when no text was kept', () => {
    expect(decodeCell({ a: [1, 2] }, ColumnType.Jsonb)).toEqual({
      type: ColumnType.Jsonb,
      strValue: '{"a": [1, 2]}',
    });
  });

  it('reads a column marked jsonbAsText as document text, and keeps JSON null apart from SQL NULL', () => {
    const text =
      '{"status":"ok","columns":[{"name":"id","type":2},{"name":"doc","type":13,"jsonbAsText":true}],' +
      '"rows":[[1,"{\\"a\\": 2.50}"],[2,"null"],[3,"\\"abc\\""],[4,null]]}';

    const parsed = parseLossless(text);

    // Every jsonb column is in the text form, so the body needs no second parse.
    expect(keepJsonbText(text, parsed, 'rows')).toBe(parsed);

    const body = parsed as { columns: unknown; rows: unknown };
    const result = resultSetFromWire(body.columns, body.rows);

    expect(result.cell(0, 1)).toEqual({ type: ColumnType.Jsonb, strValue: '{"a": 2.50}' });
    expect(result.cell(1, 1)).toEqual({ type: ColumnType.Jsonb, strValue: 'null' });
    expect(result.cell(2, 1)).toEqual({ type: ColumnType.Jsonb, strValue: '"abc"' });
    expect(decodeValue(result.cell(3, 1))).toBeNull();
  });

  it('reads an unmarked string cell as a string document, as a server older than jsonbAsText sends it', () => {
    expect(decodeCell('{"a": 1}', ColumnType.Jsonb)).toEqual({
      type: ColumnType.Jsonb,
      strValue: '"{\\"a\\": 1}"',
    });
  });
});

describe('a jsonb value on gRPC', () => {
  it('travels in jsonValue', () => {
    expect(encodeValue({ type: ColumnType.Jsonb, strValue: '{"a":1}' })).toEqual({ jsonValue: '{"a":1}' });
    expect(decodeGrpc({ kind: 'jsonValue', jsonValue: '{"a": 1}' })).toEqual({
      type: ColumnType.Jsonb,
      strValue: '{"a": 1}',
    });
    expect(decodeGrpc({ jsonValue: 'null' })).toEqual({ type: ColumnType.Jsonb, strValue: 'null' });
  });

  it('builds a result set with jsonb cells', () => {
    const result = buildResultSet({ columns: [{ name: 'doc', type: ColumnType.Jsonb }] }, [
      { values: [{ kind: 'jsonValue', jsonValue: '{"a": [1, 2.50]}' }] },
      { values: [{ kind: 'nullValue', nullValue: 0 }] },
    ]);

    expect(result.columns[0]!.typeName).toBe('Jsonb');
    expect(decodeValue(result.cell(0, 0))).toEqual({ a: [1, 2.5] });
    expect(decodeValue(result.cell(1, 0))).toBeNull();
  });

  it('counts the text in the frame cost', () => {
    const cost = (text: string): number =>
      frameCost({
        requestId: 1,
        kind: GrpcBatchStatementKind.Query,
        request: { database: 'd', sql: 's', parameters: { '@p': { kind: 'jsonValue', jsonValue: text } } },
      });

    expect(cost('{"a": 12345}') - cost('1')).toBe('{"a": 12345}'.length - 1);
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
      parameters: { '@p': encodeValue({ type: ColumnType.Jsonb, strValue: '{"a": [1, 2.50]}' }) },
    });

    const decoded = method.requestDeserialize(bytes).parameters['@p'] as Parameters<typeof decodeGrpc>[0];

    expect(decoded.kind).toBe('jsonValue');
    expect(decodeGrpc(decoded)).toEqual({ type: ColumnType.Jsonb, strValue: '{"a": [1, 2.50]}' });
  });
});

describe('the jsonb decode mode', () => {
  it('reads Jsonb=text from a connection string', () => {
    expect(resolveConnectionString('Endpoint=http://h:1;Database=d').decode.jsonb).toBe('parse');
    expect(resolveConnectionString('Endpoint=http://h:1;Database=d;Jsonb=text').decode.jsonb).toBe('text');
  });
});

describe('jsonb over REST, end to end', () => {
  let server: FakeCamusServer;

  beforeAll(async () => {
    server = await FakeCamusServer.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  let suffix = 0;

  beforeEach(() => {
    server.reset();
    CamusEndpointPool.resetShared();
    CamusTokenProvider.resetShared();
    CamusTransportPool.resetShared();
    CamusPreparedStatementPolicy.resetShared();
    CamusStatementRouter.resetShared();
    suffix++;
  });

  function client(connectionSuffix = ''): CamusClient {
    return new CamusClient(
      `Endpoint=${server.endpoint};Database=jsonb-${String(suffix)};Timeout=5${connectionSuffix}`,
    );
  }

  const columns = [
    { name: 'id', type: ColumnType.Integer64 },
    { name: 'payload', type: ColumnType.Jsonb },
  ];

  const queryReply =
    '{"status":"ok","columns":[{"name":"id","type":2},{"name":"payload","type":13}],' +
    '"rows":[[1,{"kind":"login","price":2.50}],[2,null]]}';

  it('reads a document as a parsed value by default', async () => {
    server.json('execute-sql-query', queryReply);

    const result = await client().query('SELECT id, payload FROM events');

    expect(result.columns[1]!.typeName).toBe('Jsonb');
    expect(result.rows).toEqual([
      { id: 1, payload: { kind: 'login', price: 2.5 } },
      { id: 2, payload: null },
    ]);
  });

  it('reads the exact text with jsonb: text', async () => {
    server.json('execute-sql-query', queryReply);

    const result = await client().query('SELECT id, payload FROM events', undefined, { jsonb: 'text' });

    expect(result.rows[0]).toEqual({ id: 1, payload: '{"kind": "login", "price": 2.50}' });
  });

  it('reads the exact text with Jsonb=text in the connection string', async () => {
    server.json(
      'execute-sql-query',
      '{"status":"ok","columns":[{"name":"payload","type":13}],"rows":[[{"kind":"login","price":2.50}]]}',
    );

    await expect(client(';Jsonb=text').scalar('SELECT payload FROM events')).resolves.toBe(
      '{"kind": "login", "price": 2.50}',
    );
  });

  it('keeps the text of a document that RETURNING gives', async () => {
    server.json(
      'execute-sql-non-query',
      '{"status":"ok","rows":1,"columns":[{"name":"payload","type":13}],"returningRows":[[{"v":1.10}]]}',
    );

    await expect(
      client().scalar(
        'INSERT INTO events (payload) VALUES (@p) RETURNING payload',
        { p: { v: 1.1 } },
        {
          jsonb: 'text',
        },
      ),
    ).resolves.toBe('{"v": 1.10}');

    const sent = server.requestsTo('execute-sql-non-query').at(-1)!.body as { parameters?: unknown };
    expect(JSON.stringify(sent)).toContain('"type":13');
  });

  it('asks for the text form, and reads JSON null apart from SQL NULL when the server gives it', async () => {
    server.json(
      'execute-sql-query',
      '{"status":"ok","columns":[{"name":"id","type":2},{"name":"payload","type":13,"jsonbAsText":true}],' +
        '"rows":[[1,"{\\"price\\": 2.50}"],[2,"null"],[3,null]]}',
    );

    const result = await client().query('SELECT id, payload FROM events', undefined, { jsonb: 'text' });

    expect(result.rows).toEqual([
      { id: 1, payload: '{"price": 2.50}' },
      { id: 2, payload: 'null' },
      { id: 3, payload: null },
    ]);

    const sent = server.requestsTo('execute-sql-query').at(-1)!.body as { jsonbAsText?: unknown };
    expect(sent.jsonbAsText).toBe(true);
  });

  it('reads RETURNING rows and streamed rows in the text form', async () => {
    server.json(
      'execute-sql-non-query',
      '{"status":"ok","rows":1,"columns":[{"name":"payload","type":13,"jsonbAsText":true}],"returningRows":[["null"]]}',
    );

    await expect(
      client().scalar('INSERT INTO events (payload) VALUES (@p) RETURNING payload', { p: camus.jsonb(null) }, { jsonb: 'text' }),
    ).resolves.toBe('null');

    expect((server.requestsTo('execute-sql-non-query').at(-1)!.body as { jsonbAsText?: unknown }).jsonbAsText).toBe(true);

    server.on('execute-sql-query-stream', (_request, response) => {
      respondNdjson(response, [
        { columns: [{ name: 'payload', type: ColumnType.Jsonb, jsonbAsText: true }] },
        '["null"]',
        '[null]',
        '["{\\"a\\": [1.0]}"]',
        { status: 'ok' },
      ]);
    });

    const rows: unknown[] = [];
    const stream = await client().queryStream('SELECT payload FROM events', undefined, { jsonb: 'text' });
    for await (const row of stream) rows.push(row);

    expect(rows).toEqual([{ payload: 'null' }, { payload: null }, { payload: '{"a": [1.0]}' }]);
    expect((server.requestsTo('execute-sql-query-stream').at(-1)!.body as { jsonbAsText?: unknown }).jsonbAsText).toBe(true);
  });

  it('keeps the text of a document in a streamed row', async () => {
    server.on('execute-sql-query-stream', (_request, response) => {
      respondNdjson(response, [{ columns }, '[1,{"z":1,"a":[1.0]}]', { status: 'ok' }]);
    });

    const rows: unknown[] = [];

    const stream = await client().queryStream('SELECT id, payload FROM events', undefined, { jsonb: 'text' });

    for await (const row of stream) {
      rows.push(row);
    }

    expect(rows).toEqual([{ id: 1, payload: '{"z": 1, "a": [1.0]}' }]);
  });
});
