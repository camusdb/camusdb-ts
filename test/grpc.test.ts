import { describe, expect, it } from 'vitest';

import { ColumnType } from '../src/column-type.js';
import { DEFAULT_BATCH_OPTIONS } from '../src/config.js';
import { CamusError } from '../src/errors.js';
import { GrpcBatcher, PreparedStatementStaleError } from '../src/transport/grpc/batcher.js';
import type { BatchStream } from '../src/transport/grpc/batcher.js';
import {
  buildResultSet,
  decodeCacheMetadata,
  decodeRoutingAdvice,
  decodeValue,
  encodeValue,
  fromWire,
  toWire,
} from '../src/transport/grpc/codec.js';
import type { GrpcBatchExecuteRequest, GrpcBatchExecuteResponse } from '../src/transport/grpc/messages.js';
import { GrpcBatchStatementKind } from '../src/transport/grpc/messages.js';
import { loadGrpc, serviceConstructor } from '../src/transport/grpc/proto.js';
import { dateToTicks } from '../src/values/ticks.js';
import { uuidToHalves } from '../src/values/uuid.js';

describe('the value codec', () => {
  it('round-trips every column type', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const { high, low } = uuidToHalves(uuid);
    const ticks = dateToTicks(new Date('2024-03-15T12:00:00Z'));

    const cases = [
      { type: ColumnType.Null },
      { type: ColumnType.Id, strValue: 'abc' },
      { type: ColumnType.Integer64, longValue: 9223372036854775807n },
      { type: ColumnType.String, strValue: 'text' },
      { type: ColumnType.Bool, boolValue: true },
      { type: ColumnType.Float64, floatValue: 1.5 },
      { type: ColumnType.Float32, floatValue: 0.5 },
      { type: ColumnType.Bytes, bytesValue: new Uint8Array([1, 2, 3]) },
      { type: ColumnType.Date, longValue: ticks },
      { type: ColumnType.DateTime, longValue: ticks },
      { type: ColumnType.Uuid, uuidHigh: high, longValue: low },
    ];

    for (const value of cases) {
      const decoded = decodeValue(encodeValue(value));

      expect(decoded.type).toBe(value.type);

      if (value.longValue !== undefined && value.type !== ColumnType.Uuid) {
        expect(decoded.longValue).toBe(value.longValue);
      }

      if (value.strValue !== undefined) expect(decoded.strValue).toBe(value.strValue);
      if (value.boolValue !== undefined) expect(decoded.boolValue).toBe(value.boolValue);
      if (value.floatValue !== undefined) expect(decoded.floatValue).toBeCloseTo(value.floatValue, 5);
      if (value.bytesValue !== undefined) expect([...decoded.bytesValue!]).toEqual([...value.bytesValue]);

      if (value.type === ColumnType.Uuid) {
        expect(decoded.uuidHigh).toBe(high);
        expect(decoded.longValue).toBe(low);
      }
    }
  });

  it('round-trips an array with its element type', () => {
    const decoded = decodeValue(
      encodeValue({
        type: ColumnType.Array,
        arrayElementType: ColumnType.Integer64,
        arrayValues: [{ type: ColumnType.Integer64, longValue: 1n }, { type: ColumnType.Null }],
      }),
    );

    expect(decoded.arrayElementType).toBe(ColumnType.Integer64);
    expect(decoded.arrayValues).toHaveLength(2);
    expect(decoded.arrayValues![0]!.longValue).toBe(1n);
    expect(decoded.arrayValues![1]!.type).toBe(ColumnType.Null);
  });

  it('encodes a uuid given only as a canonical string', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const decoded = decodeValue(encodeValue({ type: ColumnType.Uuid, strValue: uuid }));

    expect(decoded.uuidHigh).toBe(uuidToHalves(uuid).high);
  });

  it('refuses a column type it cannot encode', () => {
    expect(() => encodeValue({ type: 99 as ColumnType })).toThrow(CamusError);
  });

  it('refuses a uuid whose byte count is wrong', () => {
    expect(() => decodeValue({ kind: 'uuidValue', uuidValue: Buffer.alloc(8) })).toThrow(CamusError);
  });

  it('keeps a 64-bit value exact across the wire string form', () => {
    expect(fromWire(toWire(-9223372036854775808n))).toBe(-9223372036854775808n);
    expect(fromWire('not a number')).toBe(0n);
    expect(fromWire(undefined)).toBe(0n);
    expect(fromWire(5)).toBe(5n);
  });

  it('builds a result set from a schema and its rows', () => {
    const result = buildResultSet(
      {
        columns: [
          { name: 'n', type: ColumnType.Integer64 },
          { name: 's', type: ColumnType.String },
        ],
      },
      [
        {
          values: [
            { kind: 'int64Value', int64Value: '1' },
            { kind: 'stringValue', stringValue: 'a' },
          ],
        },
        { values: [{ kind: 'int64Value', int64Value: '2' }] },
      ],
    );

    expect(result.rowCount).toBe(2);
    expect(result.columnNames).toEqual(['n', 's']);
    expect(result.cell(0, 1).strValue).toBe('a');

    // A row that supplied fewer values leaves the rest null.
    expect(result.cell(1, 1).type).toBe(ColumnType.Null);
  });

  it('reads a cache verdict and routing advice', () => {
    expect(
      decodeCacheMetadata({
        status: 'hit',
        bypassReason: '',
        name: 'robots',
        cachedAtHlc: { l: '17', c: 3 },
        ageMs: '120',
      }),
    ).toMatchObject({ isHit: true, name: 'robots', ageMs: 120, cachedAtHlc: { l: 17n, c: 3 } });

    expect(decodeCacheMetadata(undefined)).toBeUndefined();

    expect(
      decodeRoutingAdvice({
        version: 1,
        disposition: 1,
        preferredNodeId: 'camus-a:7070',
        reuseScope: 1,
        dependencyToken: 'abc',
        maxAgeMs: 1000,
        provenance: 'placementHint',
        reason: 'singleTableHash',
      }),
    ).toMatchObject({ disposition: 'prefer', parametersIndependentScope: true });

    expect(decodeRoutingAdvice(null)).toBeUndefined();
  });
});

/** A duplex stream stand-in that answers from a script, so the batcher runs without a server. */
class FakeStream implements BatchStream {
  readonly sent: GrpcBatchExecuteRequest[] = [];

  private handlers:
    { onMessage: (response: GrpcBatchExecuteResponse) => void; onClose: (error: Error) => void } | undefined;

  closed = false;

  constructor(
    readonly id: number,
    private readonly answer: (request: GrpcBatchExecuteRequest, stream: FakeStream) => void,
  ) {}

  send(request: GrpcBatchExecuteRequest): void {
    this.sent.push(request);
    this.answer(request, this);
  }

  listen(handlers: {
    onMessage: (response: GrpcBatchExecuteResponse) => void;
    onClose: (error: Error) => void;
  }): void {
    this.handlers = handlers;
  }

  reply(response: GrpcBatchExecuteResponse): void {
    this.handlers?.onMessage(response);
  }

  fail(error: Error): void {
    this.handlers?.onClose(error);
  }

  close(): void {
    this.closed = true;
  }
}

describe('GrpcBatcher', () => {
  function batcher(
    answer: (request: GrpcBatchExecuteRequest, stream: FakeStream) => void,
    channelPoolSize = 1,
  ): { subject: GrpcBatcher; streams: FakeStream[] } {
    const streams: FakeStream[] = [];

    const subject = new GrpcBatcher({ ...DEFAULT_BATCH_OPTIONS, channelPoolSize }, (id) => {
      const stream = new FakeStream(id, answer);
      streams.push(stream);
      return stream;
    });

    return { subject, streams };
  }

  it('correlates a reply with its own request', async () => {
    const { subject } = batcher((request, stream) => {
      // Answer out of order, so only the request id can pair a reply with its caller.
      setTimeout(
        () => {
          stream.reply({ requestId: request.requestId, payload: 'schema', schema: { columns: [] } });
          stream.reply({
            requestId: request.requestId,
            payload: 'row',
            row: { values: [{ kind: 'int64Value', int64Value: String(request.requestId) }] },
          });
          stream.reply({
            requestId: request.requestId,
            payload: 'queryComplete',
            queryComplete: { total: '1', causalTokenL: '2', causalTokenC: '3', causalTokenN: 4 },
          });
        },
        request.requestId % 2 === 0 ? 0 : 5,
      );
    });

    const results = await Promise.all([
      subject.enqueueQuery({ sql: 'A' }, undefined, undefined),
      subject.enqueueQuery({ sql: 'B' }, undefined, undefined),
      subject.enqueueQuery({ sql: 'C' }, undefined, undefined),
    ]);

    const values = results.map((result) => result.rows[0]?.values[0]?.int64Value);

    expect(new Set(values).size).toBe(3);
    expect(results[0].token).toEqual({ n: 4, l: 2n, c: 3n });

    await subject.dispose();
  });

  it('reports an in-band error for one operation only', async () => {
    const { subject } = batcher((request, stream) => {
      if (request.request.sql === 'BAD') {
        stream.reply({
          requestId: request.requestId,
          payload: 'error',
          error: { code: 'CADB0502', message: 'conflict' },
        });
        return;
      }

      stream.reply({
        requestId: request.requestId,
        payload: 'nonQuery',
        nonQuery: {
          affectedRows: 1,
          causalTokenL: '0',
          causalTokenC: '0',
          causalTokenN: 0,
          warning: '',
        },
      });
    });

    const [bad, good] = await Promise.allSettled([
      subject.enqueueNonQuery({ sql: 'BAD' }, undefined, undefined),
      subject.enqueueNonQuery({ sql: 'GOOD' }, undefined, undefined),
    ]);

    expect(bad.status).toBe('rejected');
    expect((bad as PromiseRejectedResult).reason).toMatchObject({ code: 'CADB0502' });
    expect(good.status).toBe('fulfilled');

    await subject.dispose();
  });

  it('pins a transaction to one stream', async () => {
    const { subject, streams } = batcher((request, stream) => {
      stream.reply({
        requestId: request.requestId,
        payload: 'startReply',
        startReply: {
          txnIdPt: '638765432109876543',
          txnIdCounter: 9,
          causalTokenN: 0,
          causalTokenL: '0',
          causalTokenC: '0',
        },
      });
    }, 3);

    const slot = subject.reserveSlot();
    const handle = await subject.enqueueStart({ database: 'test' }, slot, undefined);

    expect(handle.txnIdPt).toBe('638765432109876543');
    expect(streams).toHaveLength(1);

    await subject.dispose();
  });

  it('fails the operations that were in flight on a stream that closed', async () => {
    const { subject, streams } = batcher(() => {
      // Never answers, so the close is the only outcome.
    });

    const pending = subject.enqueueQuery({ sql: 'A' }, undefined, undefined);

    await Promise.resolve();

    streams[0]!.fail(new Error('stream closed'));

    await expect(pending).rejects.toThrow('stream closed');

    await subject.dispose();
  });

  it('rebuilds a stream for the next operation after a close', async () => {
    const { subject, streams } = batcher((request, stream) => {
      stream.reply({
        requestId: request.requestId,
        payload: 'nonQuery',
        nonQuery: { affectedRows: 1, causalTokenL: '0', causalTokenC: '0', causalTokenN: 0, warning: '' },
      });
    });

    await subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined);

    streams[0]!.fail(new Error('stream closed'));

    await subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined);

    expect(streams).toHaveLength(2);
    expect(streams[1]!.id).toBe(2);

    await subject.dispose();
  });

  it('registers a prepared statement once per stream', async () => {
    let prepares = 0;

    const { subject } = batcher((request, stream) => {
      if (request.kind === GrpcBatchStatementKind.Prepare) {
        prepares++;
        stream.reply({
          requestId: request.requestId,
          payload: 'prepareReply',
          prepareReply: { statementId: prepares, parameterNames: ['@a'] },
        });
        return;
      }

      stream.reply({ requestId: request.requestId, payload: 'closeReply', closeReply: {} });
    });

    const first = await subject.ensurePrepared(0, 'test', 'SELECT 1', undefined);
    const second = await subject.ensurePrepared(0, 'test', 'SELECT 1', undefined);

    expect(prepares).toBe(1);
    expect(second).toEqual(first);
    expect(first.parameterNames).toEqual(['@a']);

    await subject.dispose();
  });

  it('shares one registration between concurrent first calls', async () => {
    let prepares = 0;

    const { subject } = batcher((request, stream) => {
      prepares++;

      setTimeout(() => {
        stream.reply({
          requestId: request.requestId,
          payload: 'prepareReply',
          prepareReply: { statementId: prepares, parameterNames: [] },
        });
      }, 5);
    });

    await Promise.all([
      subject.ensurePrepared(0, 'test', 'SELECT 1', undefined),
      subject.ensurePrepared(0, 'test', 'SELECT 1', undefined),
      subject.ensurePrepared(0, 'test', 'SELECT 1', undefined),
    ]);

    expect(prepares).toBe(1);

    await subject.dispose();
  });

  it('registers again after the stream that held the handle was rebuilt', async () => {
    let prepares = 0;

    const { subject, streams } = batcher((request, stream) => {
      if (request.kind === GrpcBatchStatementKind.Prepare) {
        prepares++;
        stream.reply({
          requestId: request.requestId,
          payload: 'prepareReply',
          prepareReply: { statementId: prepares, parameterNames: [] },
        });
      }
    });

    await subject.ensurePrepared(0, 'test', 'SELECT 1', undefined);

    streams[0]!.fail(new Error('stream closed'));

    const second = await subject.ensurePrepared(0, 'test', 'SELECT 1', undefined);

    expect(prepares).toBe(2);
    expect(second.statementId).toBe(2);

    await subject.dispose();
  });

  it('refuses to write a handle to a stream that did not mint it', async () => {
    const { subject, streams } = batcher((request, stream) => {
      if (request.kind === GrpcBatchStatementKind.Prepare) {
        stream.reply({
          requestId: request.requestId,
          payload: 'prepareReply',
          prepareReply: { statementId: 1, parameterNames: [] },
        });
      }
    });

    const entry = await subject.ensurePrepared(0, 'test', 'SELECT 1', undefined);

    streams[0]!.fail(new Error('stream closed'));

    await expect(
      subject.enqueueQuery({ statementId: entry.statementId }, 0, undefined, entry.transportId),
    ).rejects.toBeInstanceOf(PreparedStatementStaleError);

    await subject.dispose();
  });

  it('drops a stale registration at once, so the retry re-registers', async () => {
    let prepares = 0;

    const { subject } = batcher((request, stream) => {
      if (request.kind === GrpcBatchStatementKind.Prepare) {
        prepares++;
        stream.reply({
          requestId: request.requestId,
          payload: 'prepareReply',
          prepareReply: { statementId: prepares, parameterNames: [] },
        });
      }
    });

    const stale = await subject.ensurePrepared(0, 'test', 'SELECT 1', undefined);

    subject.invalidatePrepared(0, 'test', 'SELECT 1', stale);

    const fresh = await subject.ensurePrepared(0, 'test', 'SELECT 1', undefined);

    expect(prepares).toBe(2);
    expect(fresh.statementId).toBe(2);

    await subject.dispose();
  });

  it('ends an operation the caller cancelled', async () => {
    const { subject } = batcher(() => {
      // Never answers.
    });

    const controller = new AbortController();
    const pending = subject.enqueueQuery({ sql: 'A' }, undefined, controller.signal);

    controller.abort(new Error('caller stopped'));

    await expect(pending).rejects.toThrow('caller stopped');

    await subject.dispose();
  });

  it('rotates over the stream pool', () => {
    const { subject } = batcher(() => undefined, 3);

    expect([
      subject.reserveSlot(),
      subject.reserveSlot(),
      subject.reserveSlot(),
      subject.reserveSlot(),
    ]).toEqual([0, 1, 2, 0]);

    void subject.dispose();
  });

  it('fails everything still in flight when it is closed', async () => {
    const { subject } = batcher(() => {
      // Never answers.
    });

    const pending = subject.enqueueQuery({ sql: 'A' }, undefined, undefined);

    await Promise.resolve();
    await subject.dispose();

    await expect(pending).rejects.toThrow(CamusError);
    await expect(subject.enqueueQuery({ sql: 'B' }, undefined, undefined)).rejects.toThrow(CamusError);
  });
});

describe('the proto definitions', () => {
  it('loads every service the driver calls', async () => {
    const { definition } = await loadGrpc();

    for (const service of ['CamusSql', 'CamusAuth', 'CamusRows']) {
      expect(() => serviceConstructor(definition, service)).not.toThrow();
    }

    expect(() => serviceConstructor(definition, 'NoSuchService')).toThrow(CamusError);
  });

  it('declares every method the driver calls', async () => {
    const { definition, runtime } = await loadGrpc();

    const sql = new (serviceConstructor(definition, 'CamusSql'))(
      '127.0.0.1:1',
      runtime.credentials.createInsecure(),
    );

    for (const method of ['executeQuery', 'executeNonQuery', 'executeDdl', 'batchExecute', 'ping']) {
      expect(typeof sql[method]).toBe('function');
    }

    sql.close?.();
  });
});
