import { Readable } from 'node:stream';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CamusClient, CamusError, CamusErrorCode, CamusProtocol, ColumnType } from '../src/index.js';
import { GrpcStreamRowSource } from '../src/transport/grpc/grpc-stream-row-source.js';
import type { GrpcQueryStreamMessage, GrpcValue } from '../src/transport/grpc/messages.js';
import type { GrpcCallStatus, GrpcMetadata, GrpcStatusError } from '../src/transport/grpc/proto.js';
import { translateGrpcFailure } from '../src/transport/grpc/grpc-transport.js';

const ENDPOINT = 'http://test:5096';

/** Metadata as grpc-js hands it over, over a plain map. */
function metadata(entries: Record<string, string>): GrpcMetadata {
  return {
    set: () => undefined,
    get: (key) => (entries[key] === undefined ? [] : [entries[key]]),
  };
}

function statusError(code: number, details: string, trailers?: GrpcMetadata): GrpcStatusError {
  const error = Object.assign(new Error(`${String(code)} ${details}`), { code, details });
  return trailers === undefined ? error : Object.assign(error, { metadata: trailers });
}

/**
 * A server-streaming call that a test feeds by hand. It is an object-mode `Readable`, as the grpc-js
 * call is, and it reports its end the way grpc-js does: the end of the stream, an error on failure,
 * then the status.
 */
class FakeStreamCall extends Readable {
  cancels = 0;

  private settled = false;

  constructor() {
    super({ objectMode: true, read: () => undefined });
  }

  send(message: GrpcQueryStreamMessage): void {
    this.push(message);
  }

  schema(...columns: [string, ColumnType][]): void {
    this.send({ payload: 'schema', schema: { columns: columns.map(([name, type]) => ({ name, type })) } });
  }

  row(...values: GrpcValue[]): void {
    this.send({ payload: 'row', row: { values } });
  }

  succeed(trailers: Record<string, string> = {}): void {
    this.settle({ code: 0, details: 'OK', metadata: metadata(trailers) });
  }

  fail(error: GrpcStatusError): void {
    this.settle({ code: error.code ?? 2, details: error.details }, error);
  }

  cancel(): void {
    this.cancels++;
    this.fail(statusError(1, 'Cancelled on client'));
  }

  private settle(status: GrpcCallStatus, error?: GrpcStatusError): void {
    if (this.settled) return;

    this.settled = true;
    this.push(null);

    if (error !== undefined) this.emit('error', error);

    this.emit('status', status);
  }
}

function open(
  call: FakeStreamCall,
  options: {
    timeoutSeconds?: number;
    signal?: AbortSignal;
    observeTrailers?: (t: GrpcMetadata) => void;
  } = {},
): Promise<GrpcStreamRowSource> {
  return GrpcStreamRowSource.create(call, {
    timeoutSeconds: options.timeoutSeconds ?? 0,
    signal: options.signal,
    translate: (error) => translateGrpcFailure(undefined, ENDPOINT, error),
    observeTrailers: options.observeTrailers,
  });
}

describe('GrpcStreamRowSource', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the schema of a result with no rows', async () => {
    const call = new FakeStreamCall();
    call.schema(['id', ColumnType.Integer64], ['name', ColumnType.String]);
    call.succeed();

    const source = await open(call);

    expect(source.columnNames).toEqual(['id', 'name']);
    expect(source.columnTypes).toEqual([ColumnType.Integer64, ColumnType.String]);
    expect(source.recordsAffected).toBe(-1);
    expect(await source.next()).toBeUndefined();
    expect(call.cancels).toBe(0);
  });

  it('decodes rows by position and skips the messages after the last row', async () => {
    const call = new FakeStreamCall();
    call.schema(['id', ColumnType.Integer64], ['price', ColumnType.Numeric]);
    call.row({ int64Value: '9007199254740993' }, { int64Value: '0' });
    // A row shorter than the schema reads as null in the missing columns.
    call.row({ int64Value: '2' });
    call.send({ payload: 'cacheMetadata', cacheMetadata: { status: 'miss', bypassReason: '', name: '' } });
    call.succeed();

    const source = await open(call);

    expect(await source.next()).toEqual([
      { type: ColumnType.Integer64, longValue: 9007199254740993n },
      { type: ColumnType.Numeric, strValue: '0' },
    ]);
    expect(await source.next()).toEqual([
      { type: ColumnType.Integer64, longValue: 2n },
      { type: ColumnType.Null },
    ]);
    expect(await source.next()).toBeUndefined();
    expect(await source.next()).toBeUndefined();
  });

  it('hands over the trailers only at the end', async () => {
    const call = new FakeStreamCall();
    const observed: (string | Buffer)[][] = [];

    call.schema(['id', ColumnType.Integer64]);
    call.row({ int64Value: '1' });

    const source = await open(call, { observeTrailers: (t) => observed.push(t.get('camus-causal-token-l')) });

    expect(await source.next()).toBeDefined();
    expect(observed).toEqual([]);

    call.succeed({ 'camus-causal-token-l': '42' });

    expect(await source.next()).toBeUndefined();
    expect(observed).toEqual([['42']]);
  });

  it('raises a failure after rows as a CamusError from the read that reaches it', async () => {
    const call = new FakeStreamCall();
    call.schema(['id', ColumnType.Integer64]);
    call.row({ int64Value: '1' });

    const source = await open(call);

    call.fail(
      statusError(
        10,
        'conflict',
        metadata({ 'camus-error-code': 'CADB0302', 'camus-error-message': 'lost' }),
      ),
    );

    // The row that arrived before the failure is still read.
    expect(await source.next()).toEqual([{ type: ColumnType.Integer64, longValue: 1n }]);

    const error = await source.next().catch((e: unknown) => e);

    expect(CamusError.is(error)).toBe(true);
    expect((error as CamusError).code).toBe('CADB0302');

    // The stream is over after a failure: a further read reports the end.
    expect(await source.next()).toBeUndefined();
  });

  it('refuses a response that does not start with a schema, and cancels the call', async () => {
    const call = new FakeStreamCall();
    call.row({ int64Value: '1' });

    await expect(open(call)).rejects.toThrow(/did not start with a schema/);
    expect(call.cancels).toBe(1);
  });

  it('refuses a response that ends before its schema', async () => {
    const call = new FakeStreamCall();
    call.succeed();

    await expect(open(call)).rejects.toThrow(/ended before its schema/);
  });

  it('refuses a second schema', async () => {
    const call = new FakeStreamCall();
    call.schema(['id', ColumnType.Integer64]);
    call.schema(['id', ColumnType.Integer64]);

    const source = await open(call);

    await expect(source.next()).rejects.toThrow(/second schema/);
  });

  it('reports a failure before the schema as the error of the call', async () => {
    const call = new FakeStreamCall();
    const opening = open(call).catch((e: unknown) => e);

    call.fail(
      statusError(
        3,
        'bad sql',
        metadata({ 'camus-error-code': 'CADB0100', 'camus-error-message': 'syntax' }),
      ),
    );

    const error = await opening;

    expect((error as CamusError).code).toBe('CADB0100');
  });

  it('cancels the call when it is closed before its end', async () => {
    const call = new FakeStreamCall();
    call.schema(['id', ColumnType.Integer64]);
    call.row({ int64Value: '1' });
    call.row({ int64Value: '2' });

    const source = await open(call);

    await source.next();
    await source.close();
    await source.close();

    expect(call.cancels).toBe(1);
    expect(await source.next()).toBeUndefined();
  });

  it('does not cancel a call that already ended', async () => {
    const call = new FakeStreamCall();
    call.schema(['id', ColumnType.Integer64]);
    call.succeed();

    const source = await open(call);

    expect(await source.next()).toBeUndefined();
    await source.close();

    expect(call.cancels).toBe(0);
  });

  it('times out a server that stops answering', async () => {
    vi.useFakeTimers();

    const call = new FakeStreamCall();
    call.schema(['id', ColumnType.Integer64]);
    call.row({ int64Value: '1' });

    const source = await open(call, { timeoutSeconds: 2 });

    expect(await source.next()).toBeDefined();

    // No second row and no end: the wait for the next message runs into the timeout.
    const pending = source.next().catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(2_000);

    const error = await pending;

    expect(CamusError.is(error)).toBe(true);
    expect((error as CamusError).code).toBe(CamusErrorCode.Generic);
    expect((error as CamusError).message).toMatch(/No response arrived within 2 s/);
    expect(call.cancels).toBe(1);
  });

  it('does not count the time between reads', async () => {
    vi.useFakeTimers();

    const call = new FakeStreamCall();
    call.schema(['id', ColumnType.Integer64]);
    call.row({ int64Value: '1' });
    call.row({ int64Value: '2' });

    const source = await open(call, { timeoutSeconds: 1 });

    expect(await source.next()).toBeDefined();

    // A slow caller spends longer than the timeout between reads.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await source.next()).toEqual([{ type: ColumnType.Integer64, longValue: 2n }]);

    call.succeed();

    expect(await source.next()).toBeUndefined();
    expect(call.cancels).toBe(0);
  });

  it('reports the reason of the caller cancellation, and cancels the call', async () => {
    const call = new FakeStreamCall();
    const controller = new AbortController();

    call.schema(['id', ColumnType.Integer64]);
    call.row({ int64Value: '1' });

    const source = await open(call, { signal: controller.signal });

    const reason = new Error('stop');
    const pending = source
      .next()
      .then(() => source.next())
      .catch((e: unknown) => e);

    controller.abort(reason);

    expect(await pending).toBe(reason);
    expect(call.cancels).toBe(1);
  });

  it('refuses to open when the caller already cancelled', async () => {
    const call = new FakeStreamCall();
    const controller = new AbortController();
    const reason = new Error('stop');

    controller.abort(reason);
    call.schema(['id', ColumnType.Integer64]);

    await expect(open(call, { signal: controller.signal })).rejects.toBe(reason);
    expect(call.cancels).toBe(1);
  });
});

// ─── Against a real grpc-js server ──────────────────────────────────────────

interface Served {
  readonly endpoint: string;
  readonly requests: Record<string, unknown>[];
  readonly server: grpc.Server;
}

const PROTO = fileURLToPath(new URL('../proto/camus_sql.proto', import.meta.url));

/** Serves `CamusSql.ExecuteQuery` on a loopback port with the handler a test gives. */
async function serve(
  handler: grpc.handleServerStreamingCall<Record<string, unknown>, unknown>,
): Promise<Served> {
  const definition = grpc.loadPackageDefinition(
    protoLoader.loadSync(PROTO, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
    }),
  ) as unknown as Record<string, { service: grpc.ServiceDefinition }>;

  const requests: Record<string, unknown>[] = [];
  const server = new grpc.Server();

  server.addService(definition.CamusSql!.service, {
    executeQuery: (call: grpc.ServerWritableStream<Record<string, unknown>, unknown>) => {
      requests.push(call.request);
      handler(call);
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, bound) =>
      error === null ? resolve(bound) : reject(error),
    );
  });

  return { endpoint: `http://127.0.0.1:${String(port)}`, requests, server };
}

describe('queryStream over gRPC', () => {
  let served: Served | undefined;
  let client: CamusClient | undefined;

  afterEach(async () => {
    await client?.close();
    served?.server.forceShutdown();
    client = undefined;
    served = undefined;
  });

  it('streams the rows of the ExecuteQuery RPC and keeps the causal token of the trailers', async () => {
    const ROWS = 300;

    served = await serve((call) => {
      call.write({ schema: { columns: [{ name: 'n', type: ColumnType.Integer64 }] } });

      for (let i = 0; i < ROWS; i++) call.write({ row: { values: [{ int64Value: String(i) }] } });

      const trailers = new grpc.Metadata();
      trailers.set('camus-causal-token-n', '1');
      trailers.set('camus-causal-token-l', '1000');
      trailers.set('camus-causal-token-c', '7');

      call.end(trailers);
    });

    client = new CamusClient({ endpoint: served.endpoint, database: 'test', protocol: CamusProtocol.Grpc });

    await using stream = await client.queryStream<{ n: bigint | number }>('SELECT n FROM t WHERE n > @min', {
      min: 5,
    });

    expect(stream.columns.map((column) => column.name)).toEqual(['n']);

    let count = 0;

    for await (const row of stream) {
      expect(BigInt(row.n)).toBe(BigInt(count));
      count++;
    }

    expect(count).toBe(ROWS);

    // The statement went inline, with its parameters, on the RPC of its own.
    const request = served.requests[0]!;

    expect(request.sql).toBe('SELECT n FROM t WHERE n > @min');
    expect(request.database).toBe('test');
    expect(Number(request.statementId)).toBe(0);
    expect(Object.keys(request.parameters as object)).toEqual(['@min']);

    // The next statement carries the token that the trailers of the first one reported.
    await (await client.queryStream('SELECT n FROM t')).close();

    const next = served.requests[1]!;

    expect(next.causalTokenN).toBe(1);
    expect(next.causalTokenL).toBe('1000');
    expect(next.causalTokenC).toBe('7');
  });

  it('raises a failure that the server reports after the rows', async () => {
    served = await serve((call) => {
      call.write({ schema: { columns: [{ name: 'n', type: ColumnType.Integer64 }] } });
      call.write({ row: { values: [{ int64Value: '1' }] } });

      const trailers = new grpc.Metadata();
      trailers.set('camus-error-code', 'CADB0302');
      trailers.set('camus-error-message', 'serialization conflict');

      call.emit('error', { code: grpc.status.ABORTED, details: 'conflict', metadata: trailers });
    });

    client = new CamusClient({ endpoint: served.endpoint, database: 'test', protocol: CamusProtocol.Grpc });

    const stream = await client.queryStream('SELECT n FROM t');
    const rows: unknown[] = [];

    const error = await (async () => {
      for await (const row of stream) rows.push(row);
    })().catch((e: unknown) => e);

    expect(rows).toHaveLength(1);
    expect((error as CamusError).code).toBe('CADB0302');
  });

  it('cancels the call on the server when the stream is left early', async () => {
    let cancelled: () => void = () => undefined;
    const serverSawCancel = new Promise<void>((resolve) => (cancelled = resolve));

    served = await serve((call) => {
      call.on('cancelled', () => cancelled());
      call.write({ schema: { columns: [{ name: 'n', type: ColumnType.Integer64 }] } });

      // Writes until the client goes away. Flow control holds the writes back while nobody reads.
      let i = 0;
      const pump = (): void => {
        while (!call.cancelled && call.write({ row: { values: [{ int64Value: String(i++) }] } }));
        if (!call.cancelled) call.once('drain', pump);
      };

      pump();
    });

    client = new CamusClient({ endpoint: served.endpoint, database: 'test', protocol: CamusProtocol.Grpc });

    const stream = await client.queryStream<{ n: bigint | number }>('SELECT n FROM t');

    for await (const row of stream) {
      if (BigInt(row.n) >= 10n) break;
    }

    await serverSawCancel;
  });
});
