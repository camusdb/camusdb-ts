import { describe, expect, it } from 'vitest';

import { ColumnType } from '../src/column-type.js';
import type { GrpcBatchOptions } from '../src/config.js';
import { DEFAULT_BATCH_OPTIONS } from '../src/config.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusErrorCode } from '../src/error-codes.js';
import { CamusError } from '../src/errors.js';
import {
  announcesFrames,
  FRAME_MAX_BYTES,
  FRAME_MAX_ITEMS,
  frameCost,
} from '../src/transport/grpc/batch-frames.js';
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
import { indicatesEndpointDown, isEndpointUnreachable } from '../src/transport/grpc/endpoint-health.js';
import { translateGrpcFailure } from '../src/transport/grpc/grpc-transport.js';
import type { GrpcBatchExecuteRequest, GrpcBatchExecuteResponse } from '../src/transport/grpc/messages.js';
import { GrpcBatchStatementKind } from '../src/transport/grpc/messages.js';
import type { GrpcMetadata, GrpcStatusError } from '../src/transport/grpc/proto.js';
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

  /** Set before the batcher writes to it, to play a server that announced frames. */
  framesAnnounced = false;

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

function nonQueryReply(requestId: number, affectedRows = 1): GrpcBatchExecuteResponse {
  return {
    requestId,
    payload: 'nonQuery',
    nonQuery: { affectedRows, causalTokenL: '0', causalTokenC: '0', causalTokenN: 0, warning: '' },
  };
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
      if (request.request?.sql === 'BAD') {
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

/**
 * Pins the gRPC path's handling of an endpoint that stopped answering — the case behind the
 * connection-refused storm the .NET driver measured after a leader kill (2026-09-15, runs lk1-lk3).
 * The REST transport set such an endpoint aside; the gRPC transport translated the failure and drew
 * the same endpoint again, and learned routing kept preferring it.
 */
describe('gRPC endpoint health', () => {
  /** grpc-js reports `UNAVAILABLE` as status code 14. */
  const GRPC_UNAVAILABLE = 14;

  /** A failure as grpc-js raises it: a status code, a detail, and no trailers. */
  function status(code: number, details: string): GrpcStatusError {
    return Object.assign(new Error(`${String(code)} ${details}`), { code, details });
  }

  /** The picker had no ready connection, and the socket was refused. The call never left. */
  const connectionRefused = (): GrpcStatusError =>
    status(
      GRPC_UNAVAILABLE,
      'No connection established. Last error: connect ECONNREFUSED 10.0.0.2:16095. Resolution note: ',
    );

  /** The name did not resolve. The call never left either. */
  const nameResolutionFailed = (): GrpcStatusError =>
    status(GRPC_UNAVAILABLE, 'Name resolution failed for target dns:camus2:16095');

  /** One node reports that a peer did not answer. This node answered, so it is up. */
  const serverSaidPeerUnavailable = (): GrpcStatusError =>
    status(GRPC_UNAVAILABLE, 'The remote node did not answer within the inter-node request deadline.');

  /** The connection died under a call that was already sent. The outcome is unknown. */
  const connectionDropped = (): GrpcStatusError => status(GRPC_UNAVAILABLE, 'Connection dropped');

  /** The same, raised from the write side. */
  const writeFailed = (): GrpcStatusError =>
    status(GRPC_UNAVAILABLE, 'Write error: Connection reset by peer');

  it('classifies a failed connection as never sent', () => {
    expect(isEndpointUnreachable(connectionRefused())).toBe(true);
    expect(isEndpointUnreachable(nameResolutionFailed())).toBe(true);
    expect(isEndpointUnreachable(status(GRPC_UNAVAILABLE, 'Subchannel not ready'))).toBe(true);
  });

  it('refuses to call a lost connection "never sent"', () => {
    // The node is gone, so the pool must learn it. This call may still have reached the node, so
    // the caller must never be told the request was never sent: a commit could already be durable.
    expect(isEndpointUnreachable(connectionDropped())).toBe(false);
    expect(indicatesEndpointDown(connectionDropped())).toBe(true);

    expect(isEndpointUnreachable(writeFailed())).toBe(false);
    expect(indicatesEndpointDown(writeFailed())).toBe(true);
  });

  it('leaves a server that answered alone', () => {
    expect(isEndpointUnreachable(serverSaidPeerUnavailable())).toBe(false);
    expect(indicatesEndpointDown(serverSaidPeerUnavailable())).toBe(false);
    expect(isEndpointUnreachable(status(13, 'boom'))).toBe(false);
    expect(isEndpointUnreachable(status(4, 'slow'))).toBe(false);
    expect(indicatesEndpointDown(status(4, 'slow'))).toBe(false);
  });

  it('quarantines an unreachable endpoint and reports it as never sent', () => {
    const pool = new CamusEndpointPool('http://a:9005,http://b:9005');

    const error = translateGrpcFailure(pool, 'http://b:9005', connectionRefused());

    expect(error.code).toBe(CamusErrorCode.EndpointUnreachable);
    expect(error.message).toContain('http://b:9005');
    expect(pool.isQuarantined('http://b:9005')).toBe(true);
    expect(pool.isQuarantined('http://a:9005')).toBe(false);
    expect(pool.next()).toBe('http://a:9005');
    expect(pool.next()).toBe('http://a:9005');
  });

  it('quarantines a lost connection but keeps the unknown-outcome code', () => {
    const pool = new CamusEndpointPool('http://a:9005,http://b:9005');

    const error = translateGrpcFailure(pool, 'http://b:9005', connectionDropped());

    expect(error.code).toBe(CamusErrorCode.Generic);
    expect(error.message).toContain('http://b:9005');
    expect(pool.isQuarantined('http://b:9005')).toBe(true);
  });

  it('leaves the pool alone on a server failure and keeps the generic code', () => {
    const pool = new CamusEndpointPool('http://a:9005,http://b:9005');

    const error = translateGrpcFailure(pool, 'http://b:9005', serverSaidPeerUnavailable());

    expect(error.code).toBe(CamusErrorCode.Generic);
    expect(pool.isQuarantined('http://b:9005')).toBe(false);
  });

  it('still lets a domain code from the trailers win', () => {
    const pool = new CamusEndpointPool('http://a:9005');

    const withTrailers: GrpcStatusError = Object.assign(
      status(GRPC_UNAVAILABLE, 'No connection established. Last error: connect ECONNREFUSED'),
      { metadata: fakeMetadata({ 'camus-error-code': 'CADB0504', 'camus-error-message': 'retry' }) },
    );

    const error = translateGrpcFailure(pool, 'http://a:9005', withTrailers);

    expect(error.code).toBe('CADB0504');
    expect(error.message).toBe('retry');
    expect(pool.isQuarantined('http://a:9005')).toBe(false);
  });

  it('works without a pool, for a transport that was built without one', () => {
    const error = translateGrpcFailure(undefined, 'http://a:9005', connectionRefused());

    expect(error.code).toBe(CamusErrorCode.EndpointUnreachable);
  });

  /** Enough of a grpc-js `Metadata` for the translation to read trailers from it. */
  function fakeMetadata(values: Record<string, string>): GrpcMetadata {
    return {
      set: () => undefined,
      get: (key: string) => (values[key] === undefined ? [] : [values[key]]),
    };
  }
});

/**
 * Stream frames: one stream message that carries several operations, so the fixed cost of a
 * message is paid once per frame rather than once per operation. Ported from the .NET client.
 */
describe('the batch stream frames', () => {
  function framed(
    answer: (request: GrpcBatchExecuteRequest, stream: FakeStream) => void,
    overrides: Partial<GrpcBatchOptions> = {},
    announced = true,
  ): { subject: GrpcBatcher; streams: FakeStream[] } {
    const streams: FakeStream[] = [];

    const subject = new GrpcBatcher({ ...DEFAULT_BATCH_OPTIONS, channelPoolSize: 1, ...overrides }, (id) => {
      const stream = new FakeStream(id, answer);
      stream.framesAnnounced = announced;
      streams.push(stream);
      return stream;
    });

    return { subject, streams };
  }

  /** Answers every operation, and unpacks a frame exactly as the server does. */
  function answerAll(request: GrpcBatchExecuteRequest, stream: FakeStream): void {
    if (request.kind === GrpcBatchStatementKind.Frame) {
      for (const item of request.items ?? []) answerAll(item, stream);
      return;
    }

    stream.reply(nonQueryReply(request.requestId));
  }

  it('packs the operations that waited together into one frame', async () => {
    const { subject, streams } = framed(answerAll);

    const results = await Promise.all([
      subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined),
      subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined),
      subject.enqueueNonQuery({ sql: 'C' }, undefined, undefined),
    ]);

    expect(results.map((result) => result.affectedRows)).toEqual([1, 1, 1]);

    const sent = streams[0]!.sent;

    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe(GrpcBatchStatementKind.Frame);
    expect(sent[0]!.requestId).toBe(0);
    expect(sent[0]!.request).toBeUndefined();
    expect(sent[0]!.items?.map((item) => item.request?.sql)).toEqual(['A', 'B', 'C']);

    await subject.dispose();
  });

  it('sends a lone operation as the plain single message', async () => {
    const { subject, streams } = framed(answerAll);

    await subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined);

    const sent = streams[0]!.sent;

    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe(GrpcBatchStatementKind.NonQuery);
    expect(sent[0]!.items).toBeUndefined();

    await subject.dispose();
  });

  it('writes one message per operation to a server that announced nothing', async () => {
    const { subject, streams } = framed(answerAll, {}, false);

    await Promise.all([
      subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined),
      subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined),
    ]);

    expect(streams[0]!.sent.map((request) => request.kind)).toEqual([
      GrpcBatchStatementKind.NonQuery,
      GrpcBatchStatementKind.NonQuery,
    ]);

    await subject.dispose();
  });

  it('writes one message per operation when frames are turned off', async () => {
    const { subject, streams } = framed(answerAll, { requestFrames: false });

    await Promise.all([
      subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined),
      subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined),
    ]);

    expect(streams[0]!.sent).toHaveLength(2);
    expect(streams[0]!.sent.every((request) => request.kind === GrpcBatchStatementKind.NonQuery)).toBe(true);

    await subject.dispose();
  });

  it('starts a new frame at the item limit', async () => {
    const { subject, streams } = framed(answerAll);
    const count = FRAME_MAX_ITEMS + 10;
    const pending = [];

    for (let i = 0; i < count; i++) {
      pending.push(subject.enqueueNonQuery({ sql: `S${i}` }, undefined, undefined));
    }

    await Promise.all(pending);

    const sent = streams[0]!.sent;

    expect(sent).toHaveLength(2);
    expect(sent[0]!.items).toHaveLength(FRAME_MAX_ITEMS);
    expect(sent[1]!.items).toHaveLength(10);

    await subject.dispose();
  });

  it('starts a new frame at the byte budget', async () => {
    const { subject, streams } = framed(answerAll);
    const sql = 'x'.repeat(Math.floor(FRAME_MAX_BYTES / 2.5));

    await Promise.all([
      subject.enqueueNonQuery({ sql }, undefined, undefined),
      subject.enqueueNonQuery({ sql }, undefined, undefined),
      subject.enqueueNonQuery({ sql }, undefined, undefined),
    ]);

    const sent = streams[0]!.sent;

    expect(sent).toHaveLength(2);
    expect(sent[0]!.kind).toBe(GrpcBatchStatementKind.Frame);
    expect(sent[0]!.items).toHaveLength(2);

    // The third is alone in its run, so it travels as the plain single message.
    expect(sent[1]!.kind).toBe(GrpcBatchStatementKind.NonQuery);

    await subject.dispose();
  });

  it('sends an operation above the whole budget on its own', async () => {
    const { subject, streams } = framed(answerAll);

    await Promise.all([
      subject.enqueueNonQuery({ sql: 'x'.repeat(FRAME_MAX_BYTES * 2) }, undefined, undefined),
      subject.enqueueNonQuery({ sql: 'small' }, undefined, undefined),
    ]);

    const sent = streams[0]!.sent;

    expect(sent).toHaveLength(2);
    expect(sent.every((request) => request.kind === GrpcBatchStatementKind.NonQuery)).toBe(true);

    await subject.dispose();
  });

  it('follows a response frame, item by item', async () => {
    const { subject } = framed((request, stream) => {
      if (request.kind !== GrpcBatchStatementKind.Frame) {
        stream.reply(nonQueryReply(request.requestId));
        return;
      }

      stream.reply({
        requestId: 0,
        payload: 'frame',
        frame: { items: (request.items ?? []).map((item) => nonQueryReply(item.requestId)) },
      });
    });

    const results = await Promise.all([
      subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined),
      subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined),
    ]);

    expect(results.map((result) => result.affectedRows)).toEqual([1, 1]);

    await subject.dispose();
  });

  it('drops a frame inside a frame rather than following it', async () => {
    const { subject } = framed((request, stream) => {
      const first = request.kind === GrpcBatchStatementKind.Frame ? request.items![0]! : request;

      // A nested frame that carries its own answer, marked so the two cannot be confused. A client
      // that followed it would settle the operation with 99; one that drops it leaves the operation
      // waiting for the plain answer below.
      stream.reply({
        requestId: 0,
        payload: 'frame',
        frame: {
          items: [{ requestId: 0, payload: 'frame', frame: { items: [nonQueryReply(first.requestId, 99)] } }],
        },
      });

      setTimeout(() => stream.reply(nonQueryReply(first.requestId, 1)), 0);
    });

    const result = await subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined);

    expect(result.affectedRows).toBe(1);

    await subject.dispose();
  });

  it('faults every operation of a frame whose write failed', async () => {
    const { subject } = framed(() => {
      throw new Error('the stream broke');
    });

    const first = subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined);
    const second = subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined);

    await expect(first).rejects.toThrow('the stream broke');
    await expect(second).rejects.toThrow('the stream broke');

    await subject.dispose();
  });

  it('leaves out an operation the caller cancelled before it was written', async () => {
    const { subject, streams } = framed(answerAll);
    const controller = new AbortController();

    const cancelled = subject.enqueueQuery({ sql: 'A' }, undefined, controller.signal);
    const kept = subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined);

    controller.abort(new Error('caller stopped'));

    await expect(cancelled).rejects.toThrow('caller stopped');
    await kept;

    const sent = streams[0]!.sent;

    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe(GrpcBatchStatementKind.NonQuery);
    expect(sent[0]!.request?.sql).toBe('B');

    await subject.dispose();
  });

  it('writes a rollback the caller no longer waits for', async () => {
    const { subject, streams } = framed(() => {
      // Never answers, so only the cancellation settles the operation.
    });

    const controller = new AbortController();
    const pending = subject.enqueueRollback({ database: 'db' }, 0, controller.signal);

    controller.abort(new Error('caller stopped'));

    await expect(pending).rejects.toThrow('caller stopped');
    await Promise.resolve();

    expect(streams[0]!.sent.map((request) => request.kind)).toEqual([GrpcBatchStatementKind.Rollback]);

    await subject.dispose();
  });

  it('reads an announcement only from a version it writes', () => {
    expect(announcesFrames('1')).toBe(true);
    expect(announcesFrames('2')).toBe(true);
    expect(announcesFrames('0')).toBe(false);
    expect(announcesFrames('')).toBe(false);
    expect(announcesFrames('yes')).toBe(false);
    expect(announcesFrames('1x')).toBe(false);
    expect(announcesFrames(undefined)).toBe(false);
  });

  it('estimates a cost above the bytes an operation really carries', () => {
    const sql = 'SELECT * FROM robots WHERE id = @id';

    const cost = frameCost({
      requestId: 1,
      kind: GrpcBatchStatementKind.Query,
      request: { database: 'test', sql, parameters: { '@id': { kind: 'stringValue', stringValue: 'x' } } },
    });

    expect(cost).toBeGreaterThan(sql.length);
    expect(cost).toBeLessThan(FRAME_MAX_BYTES);
  });
});

/**
 * Stream rotation: a stream presents its bearer token once, when it opens, and then outlives it.
 * When the provider renews the token, the slot opens a fresh stream and retires the old one, which
 * keeps serving the transactions that began on it. Ported from the .NET client.
 */
describe('the batch stream rotation', () => {
  let handleSeq = 0;

  /** Answers a start, a commit, a rollback, and anything else, and unpacks a frame. */
  function answerLifecycle(request: GrpcBatchExecuteRequest, stream: FakeStream): void {
    if (request.kind === GrpcBatchStatementKind.Frame) {
      for (const item of request.items ?? []) answerLifecycle(item, stream);
      return;
    }

    const requestId = request.requestId;

    switch (request.kind) {
      case GrpcBatchStatementKind.Start:
        stream.reply({
          requestId,
          payload: 'startReply',
          startReply: {
            txnIdPt: String(++handleSeq),
            txnIdCounter: 1,
            causalTokenN: 0,
            causalTokenL: '0',
            causalTokenC: '0',
          },
        });
        return;

      case GrpcBatchStatementKind.Commit:
        stream.reply({
          requestId,
          payload: 'commitReply',
          commitReply: { causalTokenL: '0', causalTokenC: '0', causalTokenN: 0 },
        });
        return;

      case GrpcBatchStatementKind.Rollback:
        stream.reply({ requestId, payload: 'rollbackReply', rollbackReply: {} });
        return;

      default:
        stream.reply(nonQueryReply(requestId));
    }
  }

  function rotating(
    stamp: () => unknown,
    overrides: Partial<GrpcBatchOptions> = {},
  ): { subject: GrpcBatcher; streams: FakeStream[] } {
    const streams: FakeStream[] = [];

    const subject = new GrpcBatcher(
      { ...DEFAULT_BATCH_OPTIONS, channelPoolSize: 1, ...overrides },
      (id) => {
        const stream = new FakeStream(id, answerLifecycle);
        streams.push(stream);
        return stream;
      },
      stamp,
    );

    return { subject, streams };
  }

  it('opens a fresh stream once the credential it opened under was replaced', async () => {
    let token: string | undefined = 'first';
    const { subject, streams } = rotating(() => token);

    await subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined);
    expect(streams).toHaveLength(1);

    token = 'second';

    await subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined);

    expect(streams).toHaveLength(2);
    expect(streams[0]!.closed).toBe(true);
    expect(streams[1]!.sent).toHaveLength(1);

    await subject.dispose();
  });

  it('keeps the stream while the credential is unchanged', async () => {
    const { subject, streams } = rotating(() => 'first');

    await subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined);
    await subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined);

    expect(streams).toHaveLength(1);
    expect(streams[0]!.sent).toHaveLength(2);

    await subject.dispose();
  });

  it('keeps the stream when no credential is minted yet', async () => {
    let token: string | undefined = 'first';
    const { subject, streams } = rotating(() => token);

    await subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined);

    // The token was invalidated and its replacement is not minted yet. That is no reason to trade
    // a working stream for one opened with no credential at all.
    token = undefined;

    await subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined);

    expect(streams).toHaveLength(1);

    await subject.dispose();
  });

  it('never rotates a batcher that was given no credential stamp', async () => {
    const streams: FakeStream[] = [];

    const subject = new GrpcBatcher({ ...DEFAULT_BATCH_OPTIONS, channelPoolSize: 1 }, (id) => {
      const stream = new FakeStream(id, answerLifecycle);
      streams.push(stream);
      return stream;
    });

    await subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined);
    await subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined);

    expect(streams).toHaveLength(1);

    await subject.dispose();
  });

  it('pins a transaction to the stream it began on, across a rotation', async () => {
    let token: string | undefined = 'first';
    const { subject, streams } = rotating(() => token);

    const slot = subject.reserveSlot();
    const handle = await subject.enqueueStart({ database: 'db' }, slot, undefined);

    token = 'second';

    // An autocommit operation is what notices the new credential and rotates the slot.
    await subject.enqueueNonQuery({ sql: 'outside' }, slot, undefined);

    expect(streams).toHaveLength(2);

    await subject.enqueueNonQuery({ sql: 'inside', txnHandle: handle }, slot, undefined);

    const onFirst = streams[0]!.sent.map((request) => request.request?.sql);
    const onSecond = streams[1]!.sent.map((request) => request.request?.sql);

    expect(onFirst).toContain('inside');
    expect(onSecond).toEqual(['outside']);

    await subject.dispose();
  });

  it('closes a retired stream once its last transaction ends', async () => {
    let token: string | undefined = 'first';
    const { subject, streams } = rotating(() => token);

    const slot = subject.reserveSlot();
    const handle = await subject.enqueueStart({ database: 'db' }, slot, undefined);

    token = 'second';
    await subject.enqueueNonQuery({ sql: 'outside' }, slot, undefined);

    // It is retired, and it still carries one open transaction, so it stays open.
    expect(streams[0]!.closed).toBe(false);
    expect(subject.isBoundToRetiredStream(BigInt(handle.txnIdPt), handle.txnIdCounter)).toBe(true);

    await subject.enqueueCommit({ database: 'db', txnHandle: handle }, slot, undefined);

    expect(streams[0]!.closed).toBe(true);
    expect(subject.isBoundToRetiredStream(BigInt(handle.txnIdPt), handle.txnIdCounter)).toBe(false);

    await subject.dispose();
  });

  it('closes a retired stream at once when nothing rides on it', async () => {
    let token: string | undefined = 'first';
    const { subject, streams } = rotating(() => token);

    await subject.enqueueNonQuery({ sql: 'A' }, undefined, undefined);

    token = 'second';
    await subject.enqueueNonQuery({ sql: 'B' }, undefined, undefined);

    expect(streams[0]!.closed).toBe(true);

    await subject.dispose();
  });

  it('closes a retired stream whose transaction was abandoned', async () => {
    let token: string | undefined = 'first';
    const { subject, streams } = rotating(() => token, { streamDrainTimeoutMs: 10 });

    const slot = subject.reserveSlot();
    const handle = await subject.enqueueStart({ database: 'db' }, slot, undefined);

    token = 'second';
    await subject.enqueueNonQuery({ sql: 'outside' }, slot, undefined);

    expect(streams[0]!.closed).toBe(false);

    // Nobody commits it. The drain timeout is what makes the server roll it back and release its
    // locks, because closing the stream is the only thing that reaches an abandoned transaction.
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(streams[0]!.closed).toBe(true);
    expect(subject.isBoundToRetiredStream(BigInt(handle.txnIdPt), handle.txnIdCounter)).toBe(false);

    await subject.dispose();
  });

  it('fails an operation that was in flight on a stream the drain timeout closed', async () => {
    let token: string | undefined = 'first';

    const streams: FakeStream[] = [];

    const subject = new GrpcBatcher(
      { ...DEFAULT_BATCH_OPTIONS, channelPoolSize: 1, streamDrainTimeoutMs: 10 },
      (id) => {
        const stream = new FakeStream(id, (request, target) => {
          // A start is answered; nothing else ever is.
          if (request.kind === GrpcBatchStatementKind.Start) answerLifecycle(request, target);
        });

        streams.push(stream);
        return stream;
      },
      () => token,
    );

    const slot = subject.reserveSlot();
    const handle = await subject.enqueueStart({ database: 'db' }, slot, undefined);

    token = 'second';

    // An autocommit operation rotates the slot. It is never answered, and disposal ends it.
    const outside = subject.enqueueNonQuery({ sql: 'outside' }, slot, undefined);
    outside.catch(() => undefined);

    await Promise.resolve();

    // This one belongs to the transaction, so it goes to the retired stream and waits there. The
    // drain timeout closes that stream under it, and a closed stream fails what it still carries.
    const pending = subject.enqueueNonQuery({ sql: 'inside', txnHandle: handle }, slot, undefined);

    await expect(pending).rejects.toThrow(CamusError);

    await subject.dispose();
  });

  it('reports a transaction on a live stream as unbound', async () => {
    const { subject } = rotating(() => 'first');

    const slot = subject.reserveSlot();
    const handle = await subject.enqueueStart({ database: 'db' }, slot, undefined);

    expect(subject.isBoundToRetiredStream(BigInt(handle.txnIdPt), handle.txnIdCounter)).toBe(false);
    expect(subject.isBoundToRetiredStream(9999n, 1)).toBe(false);

    await subject.dispose();
  });
});
