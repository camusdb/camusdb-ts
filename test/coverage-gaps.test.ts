import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CamusClient } from '../src/client.js';
import { ColumnType } from '../src/column-type.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusError } from '../src/errors.js';
import { formatHlc } from '../src/hlc.js';
import { CamusObjectId } from '../src/object-id.js';
import { CamusPreparedStatementPolicy } from '../src/prepared/policy.js';
import { CamusResultSet, RowMapper } from '../src/result-set.js';
import { CamusStatementRouter } from '../src/routing/router.js';
import { BufferedRowSource } from '../src/row-source.js';
import { CamusTokenProvider } from '../src/auth/token-provider.js';
import { CamusTransportPool } from '../src/transport/transport-pool.js';
import { CamusVector } from '../src/vector.js';
import { encodeAs, encodeParameter } from '../src/values/encode.js';
import { camus } from '../src/values/typed.js';
import { FakeCamusServer, respondJson } from './support/fake-server.js';

describe('typed parameter helpers', () => {
  it('states every column type', () => {
    const id = '65f0c4a1b2c3d4e5f60718a9';

    expect(encodeParameter(camus.id(id))).toEqual({ type: ColumnType.Id, strValue: id });
    expect(encodeParameter(camus.int64(9007199254740993n)).longValue).toBe(9007199254740993n);
    expect(encodeParameter(camus.float64(1.5))).toEqual({ type: ColumnType.Float64, floatValue: 1.5 });
    expect(encodeParameter(camus.bool(false))).toEqual({ type: ColumnType.Bool, boolValue: false });
    expect(encodeParameter(camus.string('x'))).toEqual({ type: ColumnType.String, strValue: 'x' });
    expect(encodeParameter(camus.null())).toEqual({ type: ColumnType.Null });
  });

  it('refuses an id that is not 24 hexadecimal digits', () => {
    expect(() => camus.id('abc')).toThrow(/ObjectId/);
    expect(() => camus.id('65f0c4a1b2c3d4e5f60718az')).toThrow(/ObjectId/);
  });

  it('states a bytes column from either buffer form', () => {
    expect([...encodeParameter(camus.bytes(new Uint8Array([1, 2]))).bytesValue!]).toEqual([1, 2]);
    expect(encodeParameter(camus.bytes(new ArrayBuffer(4))).bytesValue).toHaveLength(4);
  });

  it('states a vector, matching what CamusVector reads back', () => {
    const value = encodeParameter(camus.vector([0.5, -1.5]));

    expect([...CamusVector.toFloats(value.bytesValue!)]).toEqual([0.5, -1.5]);
  });

  it('states a datetime column', () => {
    const value = encodeParameter(camus.dateTime(new Date('2024-03-15T12:34:56Z')));

    expect(value.type).toBe(ColumnType.DateTime);
  });

  it('states an array holding nulls', () => {
    const value = encodeParameter(camus.array([1, null, 3], ColumnType.Integer64));

    expect(value.arrayValues!.map((item) => item.type)).toEqual([
      ColumnType.Integer64,
      ColumnType.Null,
      ColumnType.Integer64,
    ]);
  });
});

describe('encodeAs', () => {
  it('converts a value to the type the caller stated', () => {
    expect(encodeAs('abc', ColumnType.Id)).toEqual({ type: ColumnType.Id, strValue: 'abc' });
    expect(encodeAs(1, ColumnType.Bool)).toEqual({ type: ColumnType.Bool, boolValue: true });
    expect(encodeAs(0n, ColumnType.Bool)).toEqual({ type: ColumnType.Bool, boolValue: false });
    expect(encodeAs(true, ColumnType.Integer64)).toEqual({ type: ColumnType.Integer64, longValue: 1n });
    expect(encodeAs(2n, ColumnType.Float64)).toEqual({ type: ColumnType.Float64, floatValue: 2 });
    expect(encodeAs(true, ColumnType.Float64)).toEqual({ type: ColumnType.Float64, floatValue: 1 });
    expect(encodeAs(42, ColumnType.String)).toEqual({ type: ColumnType.String, strValue: '42' });
    expect(encodeAs(null, ColumnType.String)).toEqual({ type: ColumnType.Null });
    expect(encodeAs('x', ColumnType.Null)).toEqual({ type: ColumnType.Null });
  });

  it('reads an id from an ObjectId', () => {
    const id = CamusObjectId.generate();

    expect(encodeAs(id, ColumnType.Id)).toEqual({ type: ColumnType.Id, strValue: id.toString() });
  });

  it('reads a date from a string or a millisecond count', () => {
    expect(encodeAs('2024-03-15T00:00:00Z', ColumnType.Date).type).toBe(ColumnType.Date);
    expect(encodeAs(0, ColumnType.DateTime).type).toBe(ColumnType.DateTime);
  });

  it('reads bytes from an array of byte values', () => {
    expect([...encodeAs([1, 2, 3], ColumnType.Bytes).bytesValue!]).toEqual([1, 2, 3]);
  });

  it('refuses a conversion it cannot make', () => {
    expect(() => encodeAs({}, ColumnType.String)).toThrow(CamusError);
    expect(() => encodeAs({}, ColumnType.Integer64)).toThrow(CamusError);
    expect(() => encodeAs({}, ColumnType.Float64)).toThrow(CamusError);
    expect(() => encodeAs({}, ColumnType.Bool)).toThrow(CamusError);
    expect(() => encodeAs({}, ColumnType.Bytes)).toThrow(CamusError);
    expect(() => encodeAs({}, ColumnType.Date)).toThrow(CamusError);
    expect(() => encodeAs('nonsense', ColumnType.Date)).toThrow(CamusError);
    expect(() => encodeAs(1.5, ColumnType.Integer64)).toThrow(CamusError);
    expect(() => encodeAs('x', ColumnType.Uuid)).toThrow(CamusError);
    expect(() => encodeAs('x', ColumnType.Array)).toThrow(CamusError);
    expect(() => encodeAs('x', 99 as ColumnType)).toThrow(CamusError);
  });

  it('passes a stated value through unchanged', () => {
    expect(encodeAs(camus.float32(1), ColumnType.String)).toEqual({
      type: ColumnType.Float32,
      floatValue: 1,
    });
  });
});

describe('BufferedRowSource', () => {
  it('reports each row, then nothing', async () => {
    const resultSet = new CamusResultSet(
      ['n'],
      [ColumnType.Integer64],
      [
        { type: ColumnType.Integer64, longValue: 1n },
        { type: ColumnType.Integer64, longValue: 2n },
      ],
      2,
    );

    const source = new BufferedRowSource(resultSet);

    expect(source.columnNames).toEqual(['n']);
    expect(source.columnTypes).toEqual([ColumnType.Integer64]);
    expect(source.recordsAffected).toBe(-1);

    expect((await source.next())![0]!.longValue).toBe(1n);
    expect((await source.next())![0]!.longValue).toBe(2n);
    expect(await source.next()).toBeUndefined();

    await source.close();
  });

  it('carries an affected-row count for a write statement', async () => {
    const source = new BufferedRowSource(CamusResultSet.EMPTY, 5);

    expect(source.recordsAffected).toBe(5);
    expect(await source.next()).toBeUndefined();

    await source[Symbol.asyncDispose]();
  });
});

describe('RowMapper', () => {
  it('names a column the server left blank', () => {
    const mapper = new RowMapper(['', ''], { int64: 'auto' });

    expect(mapper.columnKeys).toEqual(['', '_2']);
  });

  it('reads a row with fewer cells than columns', () => {
    const mapper = new RowMapper(['a', 'b'], { int64: 'auto' });

    expect(mapper.map([{ type: ColumnType.String, strValue: 'x' }])).toEqual({ a: 'x', b: null });
  });

  it('steps a deduped key past a column that already claims it', () => {
    const mapper = new RowMapper(['id', 'id_2', 'id'], { int64: 'auto' });

    expect(mapper.columnKeys).toEqual(['id', 'id_2', 'id_3']);
  });

  it('keeps a column named __proto__ as a property of its own', () => {
    const mapper = new RowMapper(['__proto__'], { int64: 'auto' });
    const row = mapper.map<Record<string, unknown>>([{ type: ColumnType.String, strValue: 'x' }]);

    expect(Object.hasOwn(row, '__proto__')).toBe(true);
    expect(row['__proto__']).toBe('x');
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });
});

describe('CamusResultSet', () => {
  it('reports a cell that is out of range as null', () => {
    expect(CamusResultSet.EMPTY.cell(5, 5).type).toBe(ColumnType.Null);
    expect(CamusResultSet.EMPTY.rawRow(0)).toEqual([]);
  });
});

describe('formatHlc', () => {
  it('writes an instant the way the server does', () => {
    expect(formatHlc({ l: 17n, c: 3 })).toBe('17:3');
  });
});

describe('a deferred transaction', () => {
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
    CamusTransportPool.resetShared();
    CamusPreparedStatementPolicy.resetShared();
    CamusStatementRouter.resetShared();
  });

  function routedClient(): CamusClient {
    return new CamusClient({
      endpoint: [server.endpoint, 'http://127.0.0.1:9'],
      database: 'test',
      timeoutSeconds: 5,
      routingMode: 'learned',
      routingNodes: { 'camus-a:7070': server.endpoint },
      maxAutoPrepare: 0,
    });
  }

  it('sends nothing until its first statement', async () => {
    server.json('start-transaction', { status: 'ok', txnIdPT: 1, txnIdCounter: 2 });
    server.json('execute-sql-non-query', { status: 'ok', rows: 1 });
    server.json('commit-transaction', { status: 'ok' });

    const subject = routedClient();
    const transaction = await subject.beginTransaction();

    expect(transaction.isStarted).toBe(false);
    expect(transaction.txnIdPT).toBe(0n);
    expect(transaction.transactionId).toBe('0:0');
    expect(transaction.endpoint).toBeUndefined();
    expect(server.callCount('start-transaction')).toBe(0);

    await subject.execute('UPDATE robots SET year = 1', undefined, { transaction });

    expect(transaction.isStarted).toBe(true);
    expect(transaction.txnIdPT).toBe(1n);
    expect(server.callCount('start-transaction')).toBe(1);

    await transaction.commit();
  });

  it('begins at once when the caller names an affinity', async () => {
    server.json('start-transaction', { status: 'ok', txnIdPT: 1, txnIdCounter: 2 });
    server.json('rollback-transaction', { status: 'ok' });

    const transaction = await routedClient().beginTransaction({ affinity: 'SELECT * FROM robots' });

    expect(transaction.isStarted).toBe(true);
    expect(server.callCount('start-transaction')).toBe(1);

    await transaction.rollback();
  });

  it('is begun by its own commit when it ran no statement', async () => {
    server.json('start-transaction', { status: 'ok', txnIdPT: 1, txnIdCounter: 2 });
    server.json('commit-transaction', { status: 'ok' });

    const transaction = await routedClient().beginTransaction();

    await transaction.commit();

    expect(server.callCount('start-transaction')).toBe(1);
    expect(server.callCount('commit-transaction')).toBe(1);
  });

  it('lets a rollback finish quietly after a failed begin', async () => {
    server.json('start-transaction', { status: 'failed', code: 'CADB0001', message: 'no such database' });

    const subject = routedClient();
    const transaction = await subject.beginTransaction();

    await expect(
      subject.execute('UPDATE robots SET year = 1', undefined, { transaction }),
    ).rejects.toMatchObject({ code: 'CADB0001' });

    await expect(transaction.rollback()).resolves.toBeUndefined();
  });

  it('sends one begin for statements that race to be the first', async () => {
    server.on('start-transaction', (_request, response) => {
      setTimeout(() => {
        respondJson(response, 200, { status: 'ok', txnIdPT: 1, txnIdCounter: 2 });
      }, 10);
    });

    server.json('execute-sql-non-query', { status: 'ok', rows: 1 });
    server.json('commit-transaction', { status: 'ok' });

    const subject = routedClient();
    const transaction = await subject.beginTransaction();

    await Promise.all([
      subject.execute('UPDATE a SET x = 1', undefined, { transaction }),
      subject.execute('UPDATE b SET x = 1', undefined, { transaction }),
      subject.execute('UPDATE c SET x = 1', undefined, { transaction }),
    ]);

    expect(server.callCount('start-transaction')).toBe(1);
    expect(server.callCount('execute-sql-non-query')).toBe(3);

    await transaction.commit();
  });

  it('gives up on an unresolved finalize that never resolves', async () => {
    server.json('start-transaction', { status: 'ok', txnIdPT: 1, txnIdCounter: 2 });
    server.json('commit-transaction', { status: 'failed', code: 'CADB0509', message: 'unresolved' }, 500);

    const transaction = await routedClient().beginTransaction();

    const controller = new AbortController();

    // The back-off would run for minutes, so the caller's own cancellation ends it instead.
    setTimeout(() => controller.abort(new Error('caller stopped')), 120);

    await expect(transaction.commit(controller.signal)).rejects.toThrow();
    expect(server.callCount('commit-transaction')).toBeGreaterThan(1);
  });
});
