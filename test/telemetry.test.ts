import { AsyncLocalStorage } from 'node:async_hooks';

import { context, metrics, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { Context, ContextManager, MeterProvider, Span, TracerProvider } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CamusTokenProvider } from '../src/auth/token-provider.js';
import { CamusClient } from '../src/client.js';
import { ColumnType } from '../src/column-type.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusPreparedStatementPolicy } from '../src/prepared/policy.js';
import { withRetry } from '../src/retry.js';
import { CamusStatementRouter } from '../src/routing/router.js';
import { CamusError } from '../src/errors.js';
import { operationName, setTelemetryApi } from '../src/telemetry.js';
import { CamusTransportPool } from '../src/transport/transport-pool.js';
import { FakeCamusServer, respondJson, respondNdjson } from './support/fake-server.js';

// ─── A tracer, a meter, and a context manager that record what they see ─────

type AttributeMap = Record<string, unknown>;

interface RecordedSpan {
  name: string;
  readonly kind: number | undefined;
  readonly parent: RecordedSpan | undefined;
  readonly attributes: AttributeMap;
  readonly events: { name: string; attributes: AttributeMap }[];
  readonly exceptions: unknown[];
  status: { code: number; message?: string } | undefined;
  ended: boolean;
}

const spans: RecordedSpan[] = [];

let spanSeq = 0;

class FakeSpan {
  readonly record: RecordedSpan;

  private readonly id = (++spanSeq).toString(16).padStart(16, '0');

  constructor(record: RecordedSpan) {
    this.record = record;
  }

  spanContext() {
    return { traceId: '0'.repeat(31) + '1', spanId: this.id, traceFlags: 1 };
  }

  isRecording(): boolean {
    return true;
  }

  setAttribute(key: string, value: unknown): this {
    this.record.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: AttributeMap): this {
    Object.assign(this.record.attributes, attributes);
    return this;
  }

  addEvent(name: string, attributes: AttributeMap = {}): this {
    this.record.events.push({ name, attributes });
    return this;
  }

  addLink(): this {
    return this;
  }

  addLinks(): this {
    return this;
  }

  setStatus(status: { code: number; message?: string }): this {
    this.record.status = status;
    return this;
  }

  updateName(name: string): this {
    this.record.name = name;
    return this;
  }

  recordException(exception: unknown): void {
    this.record.exceptions.push(exception);
  }

  end(): void {
    this.record.ended = true;
  }
}

const tracerProvider = {
  getTracer: () => ({
    startSpan(name: string, options: { kind?: number } = {}, parentContext?: Context) {
      const parent = trace.getSpan(parentContext ?? context.active()) as FakeSpan | undefined;

      const record: RecordedSpan = {
        name,
        kind: options.kind,
        parent: parent?.record,
        attributes: {},
        events: [],
        exceptions: [],
        status: undefined,
        ended: false,
      };

      spans.push(record);
      return new FakeSpan(record) as unknown as Span;
    },
    startActiveSpan() {
      throw new Error('not used');
    },
  }),
} as unknown as TracerProvider;

interface Measurement {
  readonly instrument: string;
  readonly value: number;
  readonly attributes: AttributeMap;
}

const measurements: Measurement[] = [];

const observers = new Map<
  string,
  ((result: { observe(value: number, attributes?: AttributeMap): void }) => void)[]
>();

function instrument(name: string) {
  const push = (value: number, attributes: AttributeMap = {}): void => {
    measurements.push({ instrument: name, value, attributes });
  };

  return {
    add: push,
    record: push,
    addCallback(callback: (result: { observe(value: number, attributes?: AttributeMap): void }) => void) {
      observers.set(name, [...(observers.get(name) ?? []), callback]);
    },
    removeCallback() {},
  };
}

const meterProvider = {
  getMeter: () => ({
    createHistogram: instrument,
    createCounter: instrument,
    createUpDownCounter: instrument,
    createGauge: instrument,
    createObservableGauge: instrument,
    createObservableCounter: instrument,
    createObservableUpDownCounter: instrument,
    addBatchObservableCallback() {},
    removeBatchObservableCallback() {},
  }),
} as unknown as MeterProvider;

/** What `@opentelemetry/context-async-hooks` does, in a few lines. */
class AsyncLocalContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(activeContext, () => fn.apply(thisArg, args));
  }

  bind<T>(_context: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }
}

/** The observed values of one observable instrument, collected now. */
function observe(name: string): Measurement[] {
  const observed: Measurement[] = [];

  for (const callback of observers.get(name) ?? []) {
    callback({ observe: (value, attributes = {}) => observed.push({ instrument: name, value, attributes }) });
  }

  return observed;
}

function measured(name: string): Measurement[] {
  return measurements.filter((measurement) => measurement.instrument === name);
}

// ─── The server and the clients ─────────────────────────────────────────────

let http: FakeCamusServer;
let suffix = 0;

beforeAll(async () => {
  http = await FakeCamusServer.start();

  context.setGlobalContextManager(new AsyncLocalContextManager());
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
});

afterAll(async () => {
  trace.disable();
  metrics.disable();
  context.disable();
  setTelemetryApi(undefined);

  await http.stop();
});

beforeEach(() => {
  http.reset();
  CamusEndpointPool.resetShared();
  CamusTokenProvider.resetShared();
  CamusTransportPool.resetShared();
  CamusPreparedStatementPolicy.resetShared();
  CamusStatementRouter.resetShared();
  setTelemetryApi(undefined);
  spans.length = 0;
  measurements.length = 0;
  observers.clear();
  suffix++;
});

function database(): string {
  return `otel-${String(suffix)}`;
}

function client(overrides: Record<string, unknown> = {}): CamusClient {
  return new CamusClient({
    endpoint: http.endpoint,
    database: database(),
    timeoutSeconds: 5,
    maxAutoPrepare: 0,
    ...overrides,
  });
}

function routes(): void {
  http.json('execute-sql-query', {
    status: 'ok',
    columns: [{ name: 'n', type: ColumnType.Integer64 }],
    rows: [[1]],
  });
  http.json('execute-sql-non-query', { status: 'ok', rows: 1 });
  http.json('execute-sql-ddl', { status: 'ok' });
  http.json('insert', { status: 'ok', rows: 1 });
  http.json('commit-transaction', { status: 'ok' });
  http.json('rollback-transaction', { status: 'ok' });

  http.on('start-transaction', (_request, response) => {
    respondJson(response, 200, '{"status":"ok","txnIdPT":638765432109876543,"txnIdCounter":9}');
  });
}

const port = (): number => Number(new URL(http.endpoint).port);

// ─── Spans ──────────────────────────────────────────────────────────────────

describe('the operation name', () => {
  it('is the first keyword when it is a known verb', () => {
    expect(operationName('select 1')).toBe('SELECT');
    expect(operationName('  (SELECT 1) UNION (SELECT 2)')).toBe('SELECT');
    expect(operationName('INSERT INTO t VALUES (1)')).toBe('INSERT');
    expect(operationName('EVICT CACHE x')).toBeUndefined();
    expect(operationName('')).toBeUndefined();
  });
});

describe('spans', () => {
  it('records a client span for a query, with the database convention attributes', async () => {
    routes();

    await client().query('SELECT n FROM t WHERE id = @id', { id: 1 });

    expect(spans).toHaveLength(1);

    const span = spans[0]!;

    expect(span.name).toBe('SELECT t');
    expect(span.kind).toBe(2);
    expect(span.ended).toBe(true);
    expect(span.attributes).toEqual({
      'db.system.name': 'camusdb',
      'db.namespace': database(),
      'db.operation.name': 'SELECT',
      'db.collection.name': 't',
      'db.query.summary': 'SELECT t',
      'camusdb.transport': 'rest',
      'server.address': '127.0.0.1',
      'server.port': port(),
    });
  });

  it('records the SQL text only when traceQueryText is on', async () => {
    routes();

    await client({ traceQueryText: true }).execute('UPDATE t SET n = 1');

    expect(spans[0]!.attributes['db.query.text']).toBe('UPDATE t SET n = 1');
    expect(spans[0]!.name).toBe('UPDATE t');
  });

  it('records the SQL text without its literal values with traceQueryText sanitized', async () => {
    routes();

    await client({ traceQueryText: 'sanitized' }).query(
      'SELECT `o`.`id` FROM `orders` AS `o` JOIN customers c ON c.id = `o`.`customer_id` ' +
        "WHERE `o`.`email` = 'player@example.com' AND `o`.`total` > 10.5 AND `o`.`region` = @region",
      { region: 'PH' },
    );

    const span = spans[0]!;

    expect(span.name).toBe('SELECT orders customers');
    expect(span.attributes['db.query.text']).toBe(
      'SELECT `o`.`id` FROM `orders` AS `o` JOIN customers c ON c.id = `o`.`customer_id` ' +
        'WHERE `o`.`email` = ? AND `o`.`total` > ? AND `o`.`region` = @region',
    );

    // Two tables: a summary, but no single collection.
    expect(span.attributes['db.query.summary']).toBe('SELECT orders customers');
    expect(span.attributes['db.collection.name']).toBeUndefined();
  });

  it('keeps the database as the target of a statement that names no table', async () => {
    routes();

    await client({ traceQueryText: 'sanitized' }).query('SELECT 1');

    const span = spans[0]!;

    expect(span.name).toBe(`SELECT ${database()}`);
    expect(span.attributes['db.query.summary']).toBeUndefined();
    expect(span.attributes['db.collection.name']).toBeUndefined();
    expect(span.attributes['db.query.text']).toBe('SELECT ?');
  });

  it.each([
    ['TraceQueryText=false', undefined],
    ['TraceQueryText=true', "SELECT n FROM t WHERE name = 'x'"],
    ['TraceQueryText=Sanitized', 'SELECT n FROM t WHERE name = ?'],
    ['TraceQueryText=sanitized', 'SELECT n FROM t WHERE name = ?'],
    ['TraceQueryText=yes', undefined],
    ['', undefined],
  ])('reads %j from a connection string', async (option, expected) => {
    routes();

    const subject = new CamusClient(
      `Endpoint=${http.endpoint};Database=${database()};MaxAutoPrepare=0;${option}`,
    );

    await subject.query("SELECT n FROM t WHERE name = 'x'");

    expect(spans[0]!.attributes['db.query.text']).toBe(expected);
  });

  it('reads TraceQueryText from a connection string', async () => {
    routes();

    const subject = new CamusClient(
      `Endpoint=${http.endpoint};Database=${database()};MaxAutoPrepare=0;TraceQueryText=true`,
    );

    await subject.query('SELECT 1');

    expect(spans[0]!.attributes['db.query.text']).toBe('SELECT 1');
  });

  it('records the error type and the status code of a failed statement', async () => {
    http.json('execute-sql-query', { status: 'error', code: 'CADB0502', message: 'conflict' }, 409);

    await expect(client().query('SELECT 1')).rejects.toThrow(CamusError);

    const span = spans[0]!;

    expect(span.attributes).toMatchObject({
      'error.type': 'CADB0502',
      'db.response.status_code': 'CADB0502',
    });
    expect(span.status).toMatchObject({ code: 2 });
    expect(span.exceptions).toHaveLength(1);
    expect(span.ended).toBe(true);
  });

  it('makes the driver span a child of the active span', async () => {
    routes();

    const parent = tracerProvider.getTracer('app').startSpan('handler');

    await context.with(trace.setSpan(context.active(), parent), () => client().query('SELECT 1'));

    const driver = spans.find((span) => span.name.startsWith('SELECT'))!;

    expect(driver.parent?.name).toBe('handler');
  });

  it('names a typed insert after its table', async () => {
    routes();

    await client().insert('robots', { id: 1 });

    expect(spans[0]!.name).toBe('INSERT robots');
    expect(spans[0]!.attributes).toMatchObject({
      'db.collection.name': 'robots',
      'db.operation.name': 'INSERT',
    });
  });

  it('records one span per statement, and BEGIN and COMMIT spans for a transaction', async () => {
    routes();

    const subject = client();

    await subject.transaction(async (transaction) => {
      await subject.execute('UPDATE t SET n = 1', undefined, { transaction });
    });

    expect(spans.map((span) => span.attributes['db.operation.name'])).toEqual(['BEGIN', 'UPDATE', 'COMMIT']);
  });

  it('makes the work inside an operation a child of its span', async () => {
    routes();

    const subject = client();
    const transaction = await subject.beginTransaction({ deferBegin: true });

    // The deferred BEGIN is sent from inside the UPDATE, so its span is a child of the UPDATE span.
    await subject.execute('UPDATE t SET n = 1', undefined, { transaction });

    const begin = spans.find((span) => span.attributes['db.operation.name'] === 'BEGIN')!;

    expect(begin.parent?.attributes['db.operation.name']).toBe('UPDATE');
  });

  it('records one COMMIT span over every finalize retry, with one event per retry', async () => {
    routes();

    http.on('commit-transaction', (_request, response, call) => {
      if (call === 1)
        respondJson(response, 200, { status: 'error', code: 'CADB0509', message: 'unresolved' });
      else respondJson(response, 200, { status: 'ok' });
    });

    const transaction = await client().beginTransaction();

    await transaction.commit();

    const commits = spans.filter((span) => span.attributes['db.operation.name'] === 'COMMIT');

    expect(commits).toHaveLength(1);
    expect(commits[0]!.events).toEqual([
      { name: 'camusdb.retry', attributes: { 'camusdb.retry.kind': 'finalize', 'error.type': 'CADB0509' } },
    ]);
    expect(measured('camusdb.client.operation.retries')).toEqual([
      {
        instrument: 'camusdb.client.operation.retries',
        value: 1,
        attributes: {
          'camusdb.retry.kind': 'finalize',
          'error.type': 'CADB0509',
          'db.namespace': database(),
          'db.operation.name': 'COMMIT',
        },
      },
    ]);
  });

  it('records one BATCH span for a pipeline exchange', async () => {
    routes();

    const transaction = await client().beginTransaction({ deferBegin: true });
    const pipeline = transaction.pipeline();

    void pipeline.execute('UPDATE t SET n = 1');
    void pipeline.execute('UPDATE t SET n = 2');

    await pipeline.commit();

    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe(`BATCH ${database()}`);
    expect(spans[0]!.attributes).toMatchObject({
      'db.operation.name': 'BATCH',
      'db.operation.batch.size': 2,
      'camusdb.pipeline.commit': true,
    });
  });

  it('ends the span of a stream at its last row, and not when the call returns', async () => {
    http.on('execute-sql-query-stream', (_request, response) => {
      respondNdjson(response, [
        { columns: [{ name: 'n', type: ColumnType.Integer64 }] },
        [1],
        [2],
        { status: 'ok' },
      ]);
    });

    const stream = await client().queryStream('SELECT n FROM t');

    expect(spans[0]!.ended).toBe(false);

    const rows = await stream.toArray();

    expect(rows).toHaveLength(2);
    expect(spans[0]!.ended).toBe(true);
    expect(spans[0]!.status).toBeUndefined();
  });

  it('reports nothing, and still works, without the package', async () => {
    routes();
    setTelemetryApi(null);

    await client().query('SELECT 1');

    expect(spans).toHaveLength(0);
    expect(measurements).toHaveLength(0);
  });
});

// ─── Metrics ────────────────────────────────────────────────────────────────

describe('metrics', () => {
  it('records the operation duration with the convention tags, and never the SQL text', async () => {
    routes();

    await client({ traceQueryText: true }).query('SELECT 1');

    const durations = measured('db.client.operation.duration');

    expect(durations).toHaveLength(1);
    expect(durations[0]!.value).toBeGreaterThanOrEqual(0);
    expect(durations[0]!.attributes).toEqual({
      'db.system.name': 'camusdb',
      'db.namespace': database(),
      'db.operation.name': 'SELECT',
      'server.address': '127.0.0.1',
      'server.port': port(),
    });
  });

  it('counts a token renewal as a retry', async () => {
    routes();

    http.on('login', (_request, response, call) => {
      respondJson(response, 200, { status: 'ok', token: `token-${String(call)}`, expiresInSeconds: 900 });
    });

    http.on('execute-sql-query', (_request, response, call) => {
      if (call === 1) {
        respondJson(response, 401, { status: 'error', code: 'CADB0516', message: 'expired' });
        return;
      }

      respondJson(response, 200, { status: 'ok', columns: [], rows: [] });
    });

    await client({ user: 'app', password: 'secret' }).query('SELECT 1');

    const retries = measured('camusdb.client.operation.retries');

    expect(retries.map((retry) => retry.attributes['camusdb.retry.kind'])).toEqual(['token_renewal']);
    expect(
      spans[0]!.events
        .filter((event) => event.name === 'camusdb.retry')
        .map((event) => event.attributes['camusdb.retry.kind']),
    ).toEqual(['token_renewal']);
  });

  it('counts each login by its mode, and adds a blocking login to the statement span', async () => {
    routes();

    let now = 0;

    http.on('login', (_request, response, call) => {
      respondJson(response, 200, { status: 'ok', token: `token-${String(call)}`, expiresInSeconds: 100 });
    });

    const subject = client({ user: 'app', password: 'secret' });

    await subject.query('SELECT 1');

    expect(spans[0]!.events).toEqual([
      { name: 'camusdb.login', attributes: { 'camusdb.login.mode': 'blocking' } },
    ]);

    // Past 80% of the lifetime the statement does not wait: the login runs in the background, on
    // no statement's span.
    const auth = (subject as unknown as { runtime: { auth: CamusTokenProvider } }).runtime.auth;
    auth.clock = () => now;
    now = Date.now() + 85_000;

    await subject.query('SELECT 1');

    while (auth.loginInFlight) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(spans[1]!.events).toEqual([]);
    expect(measured('camusdb.client.auth.logins').map((login) => login.attributes)).toEqual([
      { 'camusdb.login.mode': 'blocking' },
      { 'camusdb.login.mode': 'background' },
    ]);
    expect(http.callCount('login')).toBe(2);
  });

  it('counts the retries of withRetry and of client.transaction apart', async () => {
    routes();

    let attempts = 0;

    await withRetry(() => {
      attempts++;
      return attempts < 2 ? Promise.reject(new CamusError('CADB0502', 'conflict')) : Promise.resolve();
    });

    let runs = 0;

    await client().transaction(() => {
      runs++;
      return runs < 2 ? Promise.reject(new CamusError('CADB0502', 'conflict')) : Promise.resolve();
    });

    expect(
      measured('camusdb.client.operation.retries').map((retry) => retry.attributes['camusdb.retry.kind']),
    ).toEqual(['autocommit', 'transaction']);
  });

  it('counts a transient create-database failure as a retry', async () => {
    http.on('create-db', (_request, response, call) => {
      if (call === 1) respondJson(response, 200, { status: 'error', code: 'CADB0502', message: 'busy' });
      else respondJson(response, 200, { status: 'ok' });
    });

    await client().createDatabase();

    expect(measured('camusdb.client.operation.retries')[0]!.attributes).toMatchObject({
      'camusdb.retry.kind': 'create_database',
      'error.type': 'CADB0502',
    });
  });

  it('counts an endpoint quarantine, and reports it on the gauge', async () => {
    const unreachable = 'http://127.0.0.1:9';
    const subject = new CamusClient({
      endpoint: [unreachable, http.endpoint],
      database: database(),
      timeoutSeconds: 5,
    });

    await expect(subject.ping()).rejects.toThrow();

    expect(measured('camusdb.client.endpoint.quarantines')).toEqual([
      {
        instrument: 'camusdb.client.endpoint.quarantines',
        value: 1,
        attributes: { 'server.address': '127.0.0.1', 'server.port': 9 },
      },
    ]);

    const gauge = observe('camusdb.client.endpoint.quarantined');

    expect(gauge).toContainEqual({
      instrument: 'camusdb.client.endpoint.quarantined',
      value: 1,
      attributes: { 'server.address': '127.0.0.1', 'server.port': 9 },
    });
    expect(gauge).toContainEqual(
      expect.objectContaining({ value: 0, attributes: expect.objectContaining({ 'server.port': port() }) }),
    );
  });

  it('counts prepared-statement lookups, registrations, and the statements kept prepared', async () => {
    routes();

    http.json('prepare-sql-statement', { status: 'ok', statementId: 'stmt-1', parameterNames: [] });

    const subject = client({ maxAutoPrepare: 8, autoPrepareMinUsages: 1 });

    await subject.query('SELECT n FROM t');
    await subject.query('SELECT n FROM t');

    expect(
      measured('camusdb.client.prepared_statement.lookups').map(
        (m) => m.attributes['camusdb.prepared_statement.result'],
      ),
    ).toEqual(['registered', 'hit']);
    expect(measured('camusdb.client.prepared_statement.registrations')[0]!.attributes).toEqual({
      'db.namespace': database(),
      'camusdb.prepared_statement.result': 'success',
    });
    expect(observe('camusdb.client.prepared_statement.count')).toContainEqual({
      instrument: 'camusdb.client.prepared_statement.count',
      value: 1,
      attributes: { 'db.namespace': database() },
    });
  });

  it('counts an eviction from the prepared-statement cache', async () => {
    routes();

    http.json('prepare-sql-statement', { status: 'ok', statementId: 'stmt-1', parameterNames: [] });
    http.json('close-sql-statement', { status: 'ok' });

    const subject = client({ maxAutoPrepare: 1, autoPrepareMinUsages: 1 });

    await subject.query('SELECT 1');
    await subject.query('SELECT 2');

    expect(measured('camusdb.client.prepared_statement.evictions')).toEqual([
      {
        instrument: 'camusdb.client.prepared_statement.evictions',
        value: 1,
        attributes: { 'db.namespace': database() },
      },
    ]);
  });
});
