import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CamusClient } from '../src/client.js';
import { ColumnType } from '../src/column-type.js';
import { CamusProtocol, DEFAULT_BATCH_OPTIONS } from '../src/config.js';
import type { GrpcBatchOptions } from '../src/config.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusErrorCode } from '../src/error-codes.js';
import { CamusError } from '../src/errors.js';
import { CamusPreparedStatementPolicy } from '../src/prepared/policy.js';
import { CamusStatementRouter } from '../src/routing/router.js';
import { CamusTokenProvider } from '../src/auth/token-provider.js';
import type { AuthenticatingTransport } from '../src/transport/authenticating-transport.js';
import { announcedFrameVersion, FRAME_MAX_ITEMS, FRAME_VERSION } from '../src/transport/grpc/batch-frames.js';
import type { BatchStream, PipelineOp } from '../src/transport/grpc/batcher.js';
import {
  GrpcBatcher,
  PipelineUnsupportedError,
  PreparedStatementStaleError,
} from '../src/transport/grpc/batcher.js';
import type { GrpcTransport } from '../src/transport/grpc/grpc-transport.js';
import type {
  GrpcBatchExecuteRequest,
  GrpcBatchExecuteResponse,
  GrpcRoutingAdviceMessage,
  GrpcTxnHandle,
} from '../src/transport/grpc/messages.js';
import { GrpcBatchStatementKind } from '../src/transport/grpc/messages.js';
import { CamusTransportPool } from '../src/transport/transport-pool.js';
import { FakeCamusServer, respondJson } from './support/fake-server.js';

const Kind = GrpcBatchStatementKind;

/** A duplex stream stand-in. The server it plays is `PipelineServer`. */
class FakeStream implements BatchStream {
  readonly sent: GrpcBatchExecuteRequest[] = [];

  announcedVersion = FRAME_VERSION;

  closed = false;

  private handlers:
    { onMessage: (response: GrpcBatchExecuteResponse) => void; onClose: (error: Error) => void } | undefined;

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

  close(): void {
    this.closed = true;
  }
}

/**
 * Plays a server of frame contract version 2.
 *
 * A start mints a handle. An operation that names a start by `txnStartRef` joins its transaction.
 * A statement whose SQL contains `BAD` fails with `CADB0502`, and it ends its transaction: every
 * later operation of that transaction, the conditional commit too, answers with that failure.
 */
class PipelineServer {
  private handleSeq = 0;

  private readonly startOf = new Map<number, string>();

  private readonly failures = new Map<string, { code: string; message: string }>();

  /** Every operation the server ran, unpacked from its frame, in arrival order. */
  readonly ran: GrpcBatchExecuteRequest[] = [];

  /** The routing advice a query reply carries, when the request asked for it. */
  advice: GrpcRoutingAdviceMessage | undefined;

  readonly answer = (request: GrpcBatchExecuteRequest, stream: FakeStream): void => {
    if (request.kind === Kind.Frame) {
      for (const item of request.items ?? []) this.answer(item, stream);
      return;
    }

    this.ran.push(request);

    const requestId = request.requestId;
    const handle = request.request?.txnHandle;
    const transaction =
      request.txnStartRef !== undefined && request.txnStartRef > 0
        ? this.startOf.get(request.txnStartRef)
        : handle === undefined || handle === null
          ? undefined
          : `${handle.txnIdPt}:${String(handle.txnIdCounter)}`;

    const failed = transaction === undefined ? undefined : this.failures.get(transaction);

    switch (request.kind) {
      case Kind.Start: {
        const txnIdPt = String(1000 + ++this.handleSeq);

        this.startOf.set(requestId, `${txnIdPt}:7`);
        stream.reply({ requestId, payload: 'startReply', startReply: txnHandle(txnIdPt, 7) });
        return;
      }

      case Kind.CommitIfOk:
      case Kind.Commit:
        if (failed !== undefined) {
          stream.reply({ requestId, payload: 'error', error: failed });
          return;
        }

        stream.reply({
          requestId,
          payload: 'commitReply',
          commitReply: { causalTokenL: '5', causalTokenC: '6', causalTokenN: 1 },
        });
        return;

      case Kind.Rollback:
        stream.reply({ requestId, payload: 'rollbackReply', rollbackReply: {} });
        return;

      default:
        break;
    }

    if (failed !== undefined) {
      stream.reply({ requestId, payload: 'error', error: failed });
      return;
    }

    if (request.request?.sql?.includes('BAD') === true) {
      const failure = { code: 'CADB0502', message: 'conflict' };

      if (transaction !== undefined) this.failures.set(transaction, failure);

      stream.reply({ requestId, payload: 'error', error: failure });
      return;
    }

    if (request.kind === Kind.Query) {
      stream.reply({
        requestId,
        payload: 'schema',
        schema: { columns: [{ name: 'balance', type: ColumnType.Integer64 }] },
      });
      stream.reply({
        requestId,
        payload: 'row',
        row: { values: [{ kind: 'int64Value', int64Value: '40' }] },
      });
      stream.reply({
        requestId,
        payload: 'queryComplete',
        queryComplete: {
          total: '1',
          causalTokenL: '0',
          causalTokenC: '0',
          causalTokenN: 0,
          routing: (request.request?.routingAcceptVersion ?? 0) > 0 ? (this.advice ?? null) : null,
        },
      });
      return;
    }

    stream.reply({
      requestId,
      payload: 'nonQuery',
      nonQuery: { affectedRows: 1, causalTokenL: '0', causalTokenC: '0', causalTokenN: 0, warning: '' },
    });
  };
}

function txnHandle(txnIdPt: string, txnIdCounter: number): GrpcTxnHandle {
  return { txnIdPt, txnIdCounter, causalTokenN: 0, causalTokenL: '0', causalTokenC: '0' };
}

function batcherFor(
  server: PipelineServer,
  options: Partial<GrpcBatchOptions> = {},
  announcedVersion: number = FRAME_VERSION,
  stamp?: () => unknown,
): { subject: GrpcBatcher; streams: FakeStream[] } {
  const streams: FakeStream[] = [];

  const subject = new GrpcBatcher(
    { ...DEFAULT_BATCH_OPTIONS, channelPoolSize: 1, ...options },
    (id) => {
      const stream = new FakeStream(id, server.answer);
      stream.announcedVersion = announcedVersion;
      streams.push(stream);
      return stream;
    },
    stamp,
  );

  return { subject, streams };
}

/** The three messages of a transfer whose writes depend on nothing it reads. */
function transferOps(): PipelineOp[] {
  return [
    { kind: Kind.Start, request: { database: 'bank' } },
    { kind: Kind.NonQuery, request: { database: 'bank', sql: 'UPDATE a' } },
    { kind: Kind.NonQuery, request: { database: 'bank', sql: 'UPDATE b' } },
    { kind: Kind.CommitIfOk, request: { database: 'bank' } },
  ];
}

describe('the frame contract version', () => {
  it('writes version 2 and reads the version a server announces', () => {
    expect(FRAME_VERSION).toBe(2);
    expect(announcedFrameVersion('1')).toBe(1);
    expect(announcedFrameVersion('2')).toBe(2);
    expect(announcedFrameVersion(' 3 ')).toBe(3);
    expect(announcedFrameVersion('0')).toBe(0);
    expect(announcedFrameVersion('2x')).toBe(0);
    expect(announcedFrameVersion(undefined)).toBe(0);
  });

  it('declares the pipeline fields in the proto', async () => {
    const { loadGrpc } = await import('../src/transport/grpc/proto.js');
    const { definition } = await loadGrpc();

    const type = (
      name: string,
    ): { field: { name: string }[]; value?: { name: string; number: number }[] } => {
      const key = Object.keys(definition).find((entry) => entry === name || entry.endsWith(`.${name}`));
      return (
        definition[key!] as {
          type: { field: { name: string }[]; value?: { name: string; number: number }[] };
        }
      ).type;
    };

    expect(type('BatchExecuteRequest').field.map((field) => field.name)).toContain('txnStartRef');

    const kinds = (
      definition[Object.keys(definition).find((name) => name.endsWith('BatchStatementKind'))!] as {
        type: { value: { name: string; number: number }[] };
      }
    ).type.value;

    expect(kinds).toContainEqual(
      expect.objectContaining({ name: 'BATCH_STATEMENT_KIND_COMMIT_IF_OK', number: 9 }),
    );
  });
});

describe('GrpcBatcher pipelines', () => {
  it('writes a whole transaction as one frame whose operations name their start', async () => {
    const server = new PipelineServer();
    const { subject, streams } = batcherFor(server);

    const results = await Promise.all(subject.enqueuePipeline(transferOps(), 0, undefined));

    expect(streams).toHaveLength(1);
    expect(streams[0]!.sent).toHaveLength(1);

    const frame = streams[0]!.sent[0]!;

    expect(frame.kind).toBe(Kind.Frame);
    expect(frame.items!.map((item) => item.kind)).toEqual([
      Kind.Start,
      Kind.NonQuery,
      Kind.NonQuery,
      Kind.CommitIfOk,
    ]);

    const startId = frame.items![0]!.requestId;

    expect(frame.items![0]!.txnStartRef).toBeUndefined();
    expect(frame.items!.slice(1).map((item) => item.txnStartRef)).toEqual([startId, startId, startId]);

    expect((results[0] as GrpcTxnHandle).txnIdPt).toBe('1001');
    expect(results[3]).toEqual({ n: 1, l: 5n, c: 6n });

    await subject.dispose();
  });

  it('sends a later frame of a transaction by handle, and ends the transaction with it', async () => {
    const server = new PipelineServer();
    let token = 'first';
    const { subject, streams } = batcherFor(server, {}, FRAME_VERSION, () => token);

    const [handle] = (await Promise.all(
      subject.enqueuePipeline(
        [
          { kind: Kind.Start, request: { database: 'bank' } },
          { kind: Kind.Query, request: { database: 'bank', sql: 'SELECT a' } },
        ],
        0,
        undefined,
      ),
    )) as [GrpcTxnHandle, unknown];

    // A rotation, which the next autocommit operation notices, leaves the transaction on the
    // stream it began on.
    token = 'second';

    await subject.enqueueNonQuery({ database: 'bank', sql: 'UPDATE c' }, 0, undefined);

    expect(streams).toHaveLength(2);
    expect(subject.isBoundToRetiredStream(BigInt(handle.txnIdPt), handle.txnIdCounter)).toBe(true);

    const byHandle = { database: 'bank', txnHandle: txnHandle(handle.txnIdPt, handle.txnIdCounter) };

    await Promise.all(
      subject.enqueuePipeline(
        [
          { kind: Kind.NonQuery, request: { ...byHandle, sql: 'UPDATE a' } },
          { kind: Kind.CommitIfOk, request: byHandle },
        ],
        0,
        undefined,
      ),
    );

    const second = streams[0]!.sent[1]!;

    expect(second.kind).toBe(Kind.Frame);
    expect(second.items!.map((item) => item.txnStartRef)).toEqual([undefined, undefined]);

    // The conditional commit ended the transaction, so the retired stream had nothing left on it.
    expect(subject.isBoundToRetiredStream(BigInt(handle.txnIdPt), handle.txnIdCounter)).toBe(false);
    expect(streams[0]!.closed).toBe(true);

    await subject.dispose();
  });

  it('fails the conditional commit with the failure of a statement before it', async () => {
    const server = new PipelineServer();
    const { subject } = batcherFor(server);

    const ops = transferOps();
    ops[1] = { kind: Kind.NonQuery, request: { database: 'bank', sql: 'UPDATE BAD' } };

    const settled = await Promise.allSettled(subject.enqueuePipeline(ops, 0, undefined));

    expect(settled.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect((settled[3] as PromiseRejectedResult).reason).toMatchObject({ code: 'CADB0502' });

    await subject.dispose();
  });

  it('writes nothing to a server below the pipeline contract', async () => {
    const server = new PipelineServer();
    const { subject, streams } = batcherFor(server, {}, 1);

    const settled = await Promise.allSettled(subject.enqueuePipeline(transferOps(), 0, undefined));

    for (const outcome of settled) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(PipelineUnsupportedError);
    }

    expect(streams[0]!.sent).toHaveLength(0);

    await subject.dispose();
  });

  it('refuses a pipeline when request frames are off', async () => {
    const server = new PipelineServer();
    const { subject, streams } = batcherFor(server, { requestFrames: false });

    const settled = await Promise.allSettled(subject.enqueuePipeline(transferOps(), 0, undefined));

    expect((settled[0] as PromiseRejectedResult).reason).toBeInstanceOf(PipelineUnsupportedError);
    expect(streams[0]!.sent).toHaveLength(0);

    await subject.dispose();
  });

  it('refuses a pipeline that does not fit one frame, whole', async () => {
    const server = new PipelineServer();
    const { subject, streams } = batcherFor(server);

    const ops: PipelineOp[] = [{ kind: Kind.Start, request: { database: 'bank' } }];

    for (let i = 0; i < FRAME_MAX_ITEMS; i++) {
      ops.push({ kind: Kind.NonQuery, request: { database: 'bank', sql: `UPDATE ${String(i)}` } });
    }

    const settled = await Promise.allSettled(subject.enqueuePipeline(ops, 0, undefined));

    expect(settled.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect((settled[0] as PromiseRejectedResult).reason).toBeInstanceOf(PipelineUnsupportedError);
    expect(streams[0]!.sent).toHaveLength(0);

    await subject.dispose();
  });

  it('needs no contract for plain statements by handle, and keeps them in order', async () => {
    const server = new PipelineServer();
    const { subject, streams } = batcherFor(server, {}, 0);

    const byHandle = { database: 'bank', txnHandle: txnHandle('77', 1) };

    await Promise.all(
      subject.enqueuePipeline(
        [
          { kind: Kind.NonQuery, request: { ...byHandle, sql: 'UPDATE a' } },
          { kind: Kind.NonQuery, request: { ...byHandle, sql: 'UPDATE b' } },
        ],
        0,
        undefined,
      ),
    );

    // A server that announced nothing gets one plain message per operation, as before frames.
    expect(streams[0]!.sent.map((request) => request.request?.sql)).toEqual(['UPDATE a', 'UPDATE b']);

    await subject.dispose();
  });

  it('leaves a cancelled pipeline out whole', async () => {
    const server = new PipelineServer();
    const { subject, streams } = batcherFor(server);
    const controller = new AbortController();

    const promises = subject.enqueuePipeline(transferOps(), 0, controller.signal);

    // Cancelled while it waits in the inbox, before the pump writes it.
    controller.abort(new Error('stop'));

    const settled = await Promise.allSettled(promises);

    expect(settled.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(streams.flatMap((stream) => stream.sent)).toHaveLength(0);

    await subject.dispose();
  });

  it('refuses a stale prepared execution before anything is written', async () => {
    const server = new PipelineServer();
    const { subject, streams } = batcherFor(server);

    const ops = transferOps();
    ops[1] = { kind: Kind.NonQuery, request: { database: 'bank', statementId: 4 }, expectedTransportId: 99 };

    const settled = await Promise.allSettled(subject.enqueuePipeline(ops, 0, undefined));

    expect((settled[1] as PromiseRejectedResult).reason).toBeInstanceOf(PreparedStatementStaleError);
    expect(streams[0]!.sent).toHaveLength(0);

    await subject.dispose();
  });
});

// ─── The client over gRPC ───────────────────────────────────────────────────

let suffix = 0;

beforeEach(() => {
  CamusEndpointPool.resetShared();
  CamusTokenProvider.resetShared();
  CamusTransportPool.resetShared();
  CamusPreparedStatementPolicy.resetShared();
  CamusStatementRouter.resetShared();
  suffix++;
});

/** A gRPC client whose transport writes to `server` through fake streams. */
function grpcClient(
  server: PipelineServer,
  announcedVersion: number = FRAME_VERSION,
  overrides: Record<string, unknown> = {},
): { client: CamusClient; streams: FakeStream[]; endpoints: string[] } {
  const client = new CamusClient({
    endpoint: 'http://127.0.0.1:1',
    database: `pipeline-${String(suffix)}`,
    protocol: CamusProtocol.Grpc,
    timeoutSeconds: 5,
    maxAutoPrepare: 0,
    ...overrides,
  });

  const { subject, streams } = batcherFor(server, {}, announcedVersion);
  const wrapper = (client as unknown as { runtime: { transport: AuthenticatingTransport } }).runtime
    .transport;
  const transport = wrapper.inner as GrpcTransport;
  const endpoints: string[] = [];

  (transport as unknown as { batcherFor: (endpoint: string) => Promise<GrpcBatcher> }).batcherFor = (
    endpoint,
  ) => {
    endpoints.push(endpoint);
    return Promise.resolve(subject);
  };

  return { client, streams, endpoints };
}

describe('CamusPipeline over gRPC', () => {
  it('begins a deferred transaction inside its first send, and commits inside its commit', async () => {
    const server = new PipelineServer();
    const { client, streams } = grpcClient(server);

    const txn = await client.beginTransaction({ deferBegin: true });

    expect(txn.isStarted).toBe(false);

    const pipeline = txn.pipeline();
    const readA = pipeline.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = @id', {
      id: 1,
    });
    const readB = pipeline.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = @id', {
      id: 2,
    });

    await pipeline.send();

    expect(txn.isStarted).toBe(true);
    expect(txn.txnIdPT).toBe(1001n);
    expect((await readA).rows).toEqual([{ balance: 40 }]);
    expect((await readB).rowCount).toBe(1);

    const debit = pipeline.execute('UPDATE accounts SET balance = @v WHERE id = @id', { v: 30, id: 1 });
    const credit = pipeline.execute('UPDATE accounts SET balance = @v WHERE id = @id', { v: 50, id: 2 });

    await pipeline.commit();

    expect((await debit).affectedRows).toBe(1);
    expect((await credit).affectedRows).toBe(1);
    expect(pipeline.exchanges).toBe(2);
    expect(txn.isFinalized).toBe(true);

    const sent = streams[0]!.sent;

    expect(sent).toHaveLength(2);
    expect(sent[0]!.items!.map((item) => item.kind)).toEqual([Kind.Start, Kind.Query, Kind.Query]);
    expect(sent[1]!.items!.map((item) => item.kind)).toEqual([Kind.NonQuery, Kind.NonQuery, Kind.CommitIfOk]);

    // The second frame names the handle the first one minted, and the count-only writes ask for no rows.
    expect(sent[1]!.items![2]!.request?.txnHandle?.txnIdPt).toBe('1001');
    expect(sent[1]!.items![0]!.request?.discardReturningRows).toBe(true);

    // A rollback after the commit is quiet; a second commit is a mistake.
    await txn.rollback();
    await expect(txn.commit()).rejects.toThrow(/already committed/);
  });

  it('fails what follows a failed statement, and the commit, with the same failure', async () => {
    const server = new PipelineServer();
    const { client } = grpcClient(server);

    const txn = await client.beginTransaction({ deferBegin: true });
    const pipeline = txn.pipeline();

    const first = pipeline.execute('UPDATE BAD SET x = 1');
    const second = pipeline.execute('UPDATE accounts SET x = 1');

    await expect(pipeline.commit()).rejects.toMatchObject({ code: 'CADB0502' });
    await expect(first).rejects.toMatchObject({ code: 'CADB0502' });
    await expect(second).rejects.toMatchObject({ code: 'CADB0502' });

    expect(txn.isFinalized).toBe(false);
    expect(txn.isCommittedByPipeline).toBe(false);
  });

  it('learns routes from pipelined replies, so the next transaction begins on the leader', async () => {
    const server = new PipelineServer();

    server.advice = {
      version: 1,
      disposition: 1,
      preferredNodeId: 'node-b',
      reuseScope: 1,
      dependencyToken: '',
      maxAgeMs: 60_000,
      provenance: 'placementHint',
      reason: 'singleTableHash',
    };

    const { client, streams, endpoints } = grpcClient(server, FRAME_VERSION, {
      endpoint: ['http://127.0.0.1:1', 'http://127.0.0.2:1'],
      routingMode: 'learned',
      routingNodes: { 'node-a': 'http://127.0.0.1:1', 'node-b': 'http://127.0.0.2:1' },
    });

    const sql = 'SELECT balance FROM accounts WHERE id = @id';

    for (let i = 0; i < 3; i++) {
      const txn = await client.beginTransaction();
      const pipeline = txn.pipeline();

      void pipeline.query(sql, { id: i });
      await pipeline.commit();
    }

    // The first transaction asked for advice and learned the route from its pipelined reply.
    expect(streams[0]!.sent[0]!.items![1]!.request?.routingAcceptVersion).toBe(1);
    expect(client.learnedRouteCount).toBe(1);

    // So every later one began on the endpoint that the advice names. The rotation alone would
    // send the third one back to the first endpoint.
    expect(endpoints).toEqual(['http://127.0.0.1:1', 'http://127.0.0.2:1', 'http://127.0.0.2:1']);
  });

  it('runs one exchange per step against a server below the pipeline contract', async () => {
    const server = new PipelineServer();
    const { client, streams } = grpcClient(server, 1);

    const txn = await client.beginTransaction({ deferBegin: true });
    const pipeline = txn.pipeline();

    const read = pipeline.query('SELECT balance FROM accounts');
    const write = pipeline.execute('UPDATE accounts SET balance = 1');

    await pipeline.commit();

    expect((await read).rowCount).toBe(1);
    expect((await write).affectedRows).toBe(1);

    // BEGIN, two statements, and COMMIT: four exchanges, and never an item the server could misread.
    expect(pipeline.exchanges).toBe(4);
    expect(server.ran.map((request) => request.kind)).toEqual([
      Kind.Start,
      Kind.Query,
      Kind.NonQuery,
      Kind.Commit,
    ]);
    expect(streams[0]!.sent.some((request) => request.kind === Kind.CommitIfOk)).toBe(false);
    expect(txn.isFinalized).toBe(true);
  });
});

// ─── The client over REST ───────────────────────────────────────────────────

let http: FakeCamusServer;

beforeAll(async () => {
  http = await FakeCamusServer.start();
});

afterAll(async () => {
  await http.stop();
});

function restClient(overrides: Record<string, unknown> = {}): CamusClient {
  return new CamusClient({
    endpoint: http.endpoint,
    database: `pipeline-rest-${String(suffix)}`,
    timeoutSeconds: 5,
    maxAutoPrepare: 0,
    ...overrides,
  });
}

function restRoutes(): void {
  http.reset();

  http.on('start-transaction', (_request, response) => {
    respondJson(response, 200, '{"status":"ok","txnIdPT":638765432109876543,"txnIdCounter":9}');
  });

  http.json('commit-transaction', { status: 'ok' });
  http.json('rollback-transaction', { status: 'ok' });
  http.json('execute-sql-query', {
    status: 'ok',
    columns: [{ name: 'n', type: ColumnType.Integer64 }],
    rows: [[7]],
  });

  http.on('execute-sql-non-query', (request, response) => {
    const sql = (request.body as { sql?: string }).sql ?? '';

    if (sql.includes('BAD')) {
      respondJson(response, 409, { status: 'error', code: 'CADB0502', message: 'conflict' });
      return;
    }

    respondJson(response, 200, { status: 'ok', rows: 1 });
  });
}

describe('CamusPipeline over REST', () => {
  it('runs one request per step, with the same results', async () => {
    restRoutes();

    const client = restClient();
    const txn = await client.beginTransaction({ deferBegin: true });
    const pipeline = txn.pipeline();

    const read = pipeline.query<{ n: number }>('SELECT n FROM t');
    const write = pipeline.execute('UPDATE t SET n = 1');

    expect(pipeline.size).toBe(2);

    await pipeline.commit();

    expect((await read).rows).toEqual([{ n: 7 }]);
    expect((await write).affectedRows).toBe(1);
    expect(pipeline.exchanges).toBe(4);
    expect(http.callCount('start-transaction')).toBe(1);
    expect(http.callCount('commit-transaction')).toBe(1);

    expect(http.requestsTo('execute-sql-non-query')[0]!.rawBody).toContain('"txnIdPT":638765432109876543');
    expect(http.requestsTo('execute-sql-non-query')[0]!.body).toMatchObject({ discardReturningRows: true });
  });

  it('sends no statement after a failed one, and does not commit', async () => {
    restRoutes();

    const client = restClient();
    const txn = await client.beginTransaction({ deferBegin: true });
    const pipeline = txn.pipeline();

    const bad = pipeline.execute('UPDATE BAD SET n = 1');
    const after = pipeline.execute('UPDATE t SET n = 2');

    await expect(pipeline.commit()).rejects.toMatchObject({ code: 'CADB0502' });
    await expect(bad).rejects.toMatchObject({ code: 'CADB0502' });
    await expect(after).rejects.toMatchObject({ code: 'CADB0502' });

    expect(http.callCount('execute-sql-non-query')).toBe(1);
    expect(http.callCount('commit-transaction')).toBe(0);
  });

  it('reports a failed begin on every statement, and then rolls back quietly', async () => {
    restRoutes();

    http.json('start-transaction', { status: 'error', code: 'CADB0001', message: 'no begin' }, 500);

    const client = restClient();
    const txn = await client.beginTransaction({ deferBegin: true });
    const pipeline = txn.pipeline();

    const write = pipeline.execute('UPDATE t SET n = 1');

    await expect(pipeline.send()).rejects.toThrow('no begin');
    await expect(write).rejects.toThrow('no begin');

    // The failed claim is the transaction's start, so a statement after it fails the same way.
    await expect(client.execute('UPDATE t SET n = 2', undefined, { transaction: txn })).rejects.toThrow(
      'no begin',
    );

    await txn.rollback();

    expect(http.callCount('rollback-transaction')).toBe(0);
    expect(http.callCount('execute-sql-non-query')).toBe(0);
  });

  it('sends no second BEGIN for a transaction that has begun, and lets a statement run between sends', async () => {
    restRoutes();

    const client = restClient();
    const txn = await client.beginTransaction();

    expect(txn.isStarted).toBe(true);

    const pipeline = txn.pipeline();

    pipeline.execute('UPDATE t SET n = 1').catch(() => undefined);
    await pipeline.send();

    await client.execute('UPDATE t SET n = 2', undefined, { transaction: txn });

    pipeline.execute('UPDATE t SET n = 3').catch(() => undefined);
    await pipeline.commit();

    expect(http.callCount('start-transaction')).toBe(1);
    expect(http.callCount('commit-transaction')).toBe(1);
    expect(
      http.requestsTo('execute-sql-non-query').map((request) => (request.body as { sql: string }).sql),
    ).toEqual(['UPDATE t SET n = 1', 'UPDATE t SET n = 2', 'UPDATE t SET n = 3']);
  });

  it('refuses at queue time what cannot run inside the transaction', async () => {
    restRoutes();

    const client = restClient();
    const txn = await client.beginTransaction({ deferBegin: true });
    const pipeline = txn.pipeline();

    expect(() => pipeline.execute('CREATE TABLE t (id OID PRIMARY KEY)')).toThrow(CamusError);
    expect(() => pipeline.execute('TRUNCATE TABLE t')).toThrow(
      expect.objectContaining({ code: CamusErrorCode.StatementNotAllowedInTransaction }),
    );

    // The pipeline is still usable.
    expect(pipeline.size).toBe(0);

    pipeline.execute('UPDATE t SET n = 1').catch(() => undefined);
    await pipeline.commit();

    expect(http.callCount('commit-transaction')).toBe(1);
  });

  it('is not committed a second time by the transaction helper', async () => {
    restRoutes();

    const client = restClient();

    await client.transaction(async (txn) => {
      const pipeline = txn.pipeline();

      pipeline.execute('UPDATE t SET n = 1').catch(() => undefined);
      await pipeline.commit();
    });

    expect(http.callCount('commit-transaction')).toBe(1);
    expect(http.callCount('rollback-transaction')).toBe(0);
  });

  it('reports no unhandled rejection for a queued promise that nobody awaits', async () => {
    restRoutes();

    const client = restClient();
    const txn = await client.beginTransaction({ deferBegin: true });
    const pipeline = txn.pipeline();

    // Neither promise is awaited. Vitest fails the run on an unhandled rejection.
    void pipeline.execute('UPDATE BAD SET n = 1');
    void pipeline.execute('UPDATE t SET n = 2');

    await expect(pipeline.commit()).rejects.toMatchObject({ code: 'CADB0502' });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('reads a write with RETURNING as rows and its count', async () => {
    restRoutes();

    http.json('execute-sql-non-query', {
      status: 'ok',
      rows: 1,
      columns: [{ name: 'id', type: ColumnType.Integer64 }],
      returningRows: [[11]],
    });

    const client = restClient();
    const txn = await client.beginTransaction({ deferBegin: true });
    const pipeline = txn.pipeline();

    const inserted = pipeline.query<{ id: number }>('INSERT INTO t (n) VALUES (1) RETURNING id');

    await pipeline.commit();

    const result = await inserted;

    expect(result.rows).toEqual([{ id: 11 }]);
    expect(result.affectedRows).toBe(1);
    expect(http.requestsTo('execute-sql-non-query')[0]!.body).not.toHaveProperty('discardReturningRows');
  });
});
