/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { createRequire } from 'node:module';

import { CamusQueryTextMode } from './config.js';
import { CamusEndpointPool } from './endpoint-pool.js';
import { CamusError } from './errors.js';
import { CamusPreparedStatementPolicy } from './prepared/policy.js';
import { querySummary, queryTables, sanitizeQueryText } from './query-text.js';

/**
 * Traces and metrics through `@opentelemetry/api`.
 *
 * The package is an optional peer dependency, as the gRPC packages are. When it is installed, the
 * driver reports through the global tracer and meter that it names `camusdb`. When it is not
 * installed, every function here returns at once and the driver reports nothing. Install an
 * OpenTelemetry SDK and register it as usual to collect the data. The driver needs no plugin.
 *
 * The span and metric names and attributes are those of the .NET driver, and they follow the
 * OpenTelemetry database conventions. See the README for the list.
 */

/** The instrumentation scope that the driver's tracer and meter report under. */
export const CAMUS_TELEMETRY_NAME = 'camusdb';

/** The `db.system.name` of every span and measurement. */
const SYSTEM_NAME = 'camusdb';

/** The `camusdb.retry.kind` values: what the driver sent again. */
export const CamusRetryKind = {
  /** A commit or a rollback sent again after `CADB0509`. */
  Finalize: 'finalize',

  /** A unit of work of `withRetry` run again after a serializable conflict. */
  Autocommit: 'autocommit',

  /** A unit of work of `client.transaction` run again, from `BEGIN`, after a serializable conflict. */
  Transaction: 'transaction',

  /** A call sent again with a new token after the server refused the old one. */
  TokenRenewal: 'token_renewal',

  /** A `CREATE DATABASE` or a branch creation sent again after a transient failure. */
  CreateDatabase: 'create_database',
} as const;

export type CamusRetryKind = (typeof CamusRetryKind)[keyof typeof CamusRetryKind];

/** The `camusdb.login.mode` values: how a login was started. */
export const CamusLoginMode = {
  /** A statement found no token it could send and waited for the login. */
  Blocking: 'blocking',

  /** A token reached its renewal point. Statements kept it, and the login ran beside them. */
  Background: 'background',

  /** The application called the login itself. */
  Explicit: 'explicit',
} as const;

export type CamusLoginMode = (typeof CamusLoginMode)[keyof typeof CamusLoginMode];

/** The `camusdb.prepared_statement.result` values. */
export const PreparedResult = {
  Hit: 'hit',
  Registered: 'registered',
  Miss: 'miss',
  Success: 'success',
  Refused: 'refused',
  Unsupported: 'unsupported',
} as const;

// ─── The part of `@opentelemetry/api` this driver calls ─────────────────────

type AttributeValue = string | number | boolean;

type Attributes = Record<string, AttributeValue | undefined>;

interface OtelSpan {
  isRecording(): boolean;
  setAttribute(key: string, value: AttributeValue): unknown;
  updateName(name: string): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(exception: unknown): void;
  addEvent(name: string, attributes?: Attributes): unknown;
  end(): void;
}

interface OtelTracer {
  startSpan(name: string, options?: { kind?: number; attributes?: Attributes }, context?: unknown): OtelSpan;
}

interface OtelObservableResult {
  observe(value: number, attributes?: Attributes): void;
}

interface OtelObservable {
  addCallback(callback: (result: OtelObservableResult) => void): void;
}

interface OtelInstrumentOptions {
  description?: string;
  unit?: string;
  advice?: { explicitBucketBoundaries?: number[] };
}

interface OtelMeter {
  createHistogram(
    name: string,
    options?: OtelInstrumentOptions,
  ): { record(value: number, attributes?: Attributes): void };
  createCounter(
    name: string,
    options?: OtelInstrumentOptions,
  ): { add(value: number, attributes?: Attributes): void };
  createObservableGauge(name: string, options?: OtelInstrumentOptions): OtelObservable;
  createObservableUpDownCounter(name: string, options?: OtelInstrumentOptions): OtelObservable;
}

/** @internal The subset of `@opentelemetry/api` the driver uses. */
export interface OtelApi {
  readonly trace: {
    getTracer(name: string, version?: string): OtelTracer;
    setSpan(context: unknown, span: OtelSpan): unknown;
    getActiveSpan(): OtelSpan | undefined;
  };
  readonly context: {
    active(): unknown;
    with<T>(context: unknown, fn: () => T): T;
  };
  readonly metrics: {
    getMeterProvider(): unknown;
    getMeter(name: string, version?: string): OtelMeter;
  };
  readonly ROOT_CONTEXT: unknown;
  readonly SpanKind: { readonly CLIENT: number };
  readonly SpanStatusCode: { readonly ERROR: number };
}

// ─── Loading ────────────────────────────────────────────────────────────────

/** `undefined` until the first try, `null` when the package is not installed. */
let loadedApi: OtelApi | null | undefined;

let packageVersion: string | undefined;

/**
 * The API, or `undefined` when the package is not installed.
 *
 * It is loaded with `require`, so the first operation is instrumented too: a dynamic `import` would
 * leave every operation before it settles without a span. The API keeps its registrations in a
 * process-wide global, so the copy that `require` loads sees the SDK that an ES module registered.
 */
function api(): OtelApi | undefined {
  if (loadedApi === undefined) {
    const require = createRequire(import.meta.url);

    try {
      loadedApi = require('@opentelemetry/api') as OtelApi;
    } catch {
      loadedApi = null;
    }

    try {
      packageVersion = (require('../package.json') as { version?: string }).version;
    } catch {
      packageVersion = undefined;
    }
  }

  return loadedApi ?? undefined;
}

/**
 * @internal Test hook: replaces the API, or with `null` plays a process without the package.
 * `undefined` loads it again on the next operation.
 */
export function setTelemetryApi(replacement: OtelApi | null | undefined): void {
  loadedApi = replacement;
  tracer = undefined;
  instruments = undefined;
}

let tracer: { readonly api: OtelApi; readonly tracer: OtelTracer } | undefined;

/** The global tracer. The API hands out a proxy, so a provider registered later still gets the spans. */
function tracerFor(otel: OtelApi): OtelTracer {
  if (tracer?.api !== otel)
    tracer = { api: otel, tracer: otel.trace.getTracer(CAMUS_TELEMETRY_NAME, packageVersion) };

  return tracer.tracer;
}

interface Instruments {
  readonly api: OtelApi;
  readonly provider: unknown;
  readonly duration: { record(value: number, attributes?: Attributes): void };
  readonly logins: { add(value: number, attributes?: Attributes): void };
  readonly retries: { add(value: number, attributes?: Attributes): void };
  readonly quarantines: { add(value: number, attributes?: Attributes): void };
  readonly lookups: { add(value: number, attributes?: Attributes): void };
  readonly registrations: { add(value: number, attributes?: Attributes): void };
  readonly evictions: { add(value: number, attributes?: Attributes): void };
}

let instruments: Instruments | undefined;

/**
 * The instruments, made on the meter of the current global provider.
 *
 * The metrics API has no proxy provider, so an instrument made before the SDK registered stays a
 * no-op for good. The instruments are made again whenever the global provider changes.
 */
function instrumentsFor(otel: OtelApi): Instruments {
  const provider = otel.metrics.getMeterProvider();

  if (instruments?.api === otel && instruments.provider === provider) return instruments;

  const meter = otel.metrics.getMeter(CAMUS_TELEMETRY_NAME, packageVersion);

  const quarantined = meter.createObservableGauge('camusdb.client.endpoint.quarantined', {
    unit: '{endpoint}',
    description: '1 while the endpoint is set aside after a transport failure, 0 while it takes traffic.',
  });

  quarantined.addCallback((result) => {
    for (const [endpoint, isQuarantined] of CamusEndpointPool.collectQuarantine()) {
      result.observe(isQuarantined ? 1 : 0, endpointAttributes(endpoint));
    }
  });

  const preparedCount = meter.createObservableUpDownCounter('camusdb.client.prepared_statement.count', {
    unit: '{statement}',
    description: 'Statements kept prepared now.',
  });

  preparedCount.addCallback((result) => {
    for (const [database, count] of CamusPreparedStatementPolicy.collectPreparedCounts()) {
      result.observe(count, { 'db.namespace': database });
    }
  });

  instruments = {
    api: otel,
    provider,
    duration: meter.createHistogram('db.client.operation.duration', {
      unit: 's',
      description: 'Duration of database client operations.',
      advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10] },
    }),
    logins: meter.createCounter('camusdb.client.auth.logins', {
      unit: '{login}',
      description: 'Logins the driver sent to obtain a bearer token, by whether a statement waited for them.',
    }),
    retries: meter.createCounter('camusdb.client.operation.retries', {
      unit: '{retry}',
      description: 'Operations the driver sent again after a failure it knows to be safe to retry.',
    }),
    quarantines: meter.createCounter('camusdb.client.endpoint.quarantines', {
      unit: '{quarantine}',
      description: 'Times an endpoint failed at the transport level and was set aside for 30 seconds.',
    }),
    lookups: meter.createCounter('camusdb.client.prepared_statement.lookups', {
      unit: '{lookup}',
      description:
        'Executions of a preparable statement, by whether the statement went as a prepared handle.',
    }),
    registrations: meter.createCounter('camusdb.client.prepared_statement.registrations', {
      unit: '{registration}',
      description: 'Requests to the server to prepare a statement.',
    }),
    evictions: meter.createCounter('camusdb.client.prepared_statement.evictions', {
      unit: '{eviction}',
      description: 'Prepared statements released to make room for a statement used more recently.',
    }),
  };

  return instruments;
}

// ─── Operations ─────────────────────────────────────────────────────────────

/** What an operation reads from the client it runs for. `ClientRuntime` has this shape. */
export interface TelemetryScope {
  readonly database: string;
  readonly config: { readonly protocol: string; readonly traceQueryText: CamusQueryTextMode };
}

/** What one operation reports about itself. */
export interface OperationInit {
  /** `SELECT`, `BEGIN`, `BATCH`, and so on. See `operationName`. */
  readonly operationName?: string | undefined;

  /** The table, when the driver knows it without a parse of the SQL text. */
  readonly collection?: string | undefined;

  /**
   * The SQL text. The driver reads the tables of a sampled span from it. The text goes on the span
   * only with `traceQueryText`.
   */
  readonly queryText?: string | undefined;

  /** The statement count of a pipeline exchange. */
  readonly batchSize?: number | undefined;
}

/** The spans this driver started, so a retry adds its event only to one of them. */
const ownSpans = new WeakSet<object>();

/**
 * One instrumented operation: its span, and its start time for the duration histogram.
 *
 * It ends once. The first `complete` or `fail` ends it, and later calls do nothing.
 */
export class CamusOperation {
  private ended = false;

  private serverAddress: string | undefined;

  private serverPort = 0;

  /** @internal Use `startOperation`. */
  constructor(
    private readonly otel: OtelApi,
    private readonly span: OtelSpan,
    private readonly startedAt: number,
    private readonly database: string,
    private readonly operationName: string | undefined,
  ) {}

  /** Records the server the operation goes to, as `server.address` and `server.port`. */
  setEndpoint(endpoint: string): void {
    const { host, port } = parseEndpoint(endpoint);

    this.serverAddress = host;
    this.serverPort = port;

    if (this.span.isRecording()) {
      this.span.setAttribute('server.address', host);
      if (port > 0) this.span.setAttribute('server.port', port);
    }
  }

  setAttribute(key: string, value: AttributeValue): void {
    if (this.span.isRecording()) this.span.setAttribute(key, value);
  }

  /**
   * Runs `fn` with this operation's span as the active span, so the HTTP or gRPC spans of the
   * transport are its children.
   */
  run<T>(fn: () => T): T {
    return this.otel.context.with(this.otel.trace.setSpan(this.otel.context.active(), this.span), fn);
  }

  /** Adds a `camusdb.retry` event to this operation's span. */
  addRetryEvent(kind: CamusRetryKind, errorType: string | undefined): void {
    this.span.addEvent('camusdb.retry', defined({ 'camusdb.retry.kind': kind, 'error.type': errorType }));
  }

  /** Ends the operation as a success. */
  complete(): void {
    this.end(undefined, false);
  }

  /** Ends the operation as a failure. */
  fail(error: unknown): void {
    this.end(error, true);
  }

  private end(error: unknown, failed: boolean): void {
    if (this.ended) return;

    this.ended = true;

    // The conventions use the database status code as the error type when there is one.
    const statusCode = failed && CamusError.is(error) ? error.code : undefined;
    const errorType = failed ? (statusCode ?? errorTypeName(error)) : undefined;

    if (failed) {
      if (this.span.isRecording()) {
        this.span.setAttribute('error.type', errorType!);
        if (statusCode !== undefined) this.span.setAttribute('db.response.status_code', statusCode);
        this.span.recordException(error instanceof Error ? error : String(error));
      }

      this.span.setStatus({
        code: this.otel.SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    this.span.end();

    instrumentsFor(this.otel).duration.record(
      (performance.now() - this.startedAt) / 1000,
      defined({
        'db.system.name': SYSTEM_NAME,
        'db.namespace': this.database,
        'db.operation.name': this.operationName,
        'server.address': this.serverAddress,
        'server.port': this.serverPort > 0 ? this.serverPort : undefined,
        'error.type': errorType,
        'db.response.status_code': statusCode,
      }),
    );
  }
}

/**
 * Starts an operation, or reports `undefined` when `@opentelemetry/api` is not installed.
 *
 * The span is a child of the active span. Its name is `{operation} {target}`, where the target is
 * the table when it is known, and the database if not. For a sampled span, `setTarget` replaces the
 * name with the `db.query.summary` when the SQL text names a table.
 */
export function startOperation(scope: TelemetryScope, init: OperationInit): CamusOperation | undefined {
  const otel = api();
  if (otel === undefined) return undefined;

  const database = scope.database;
  const target = init.collection ?? database;
  const name = init.operationName === undefined ? target : `${init.operationName} ${target}`;

  const span = tracerFor(otel).startSpan(name, { kind: otel.SpanKind.CLIENT }, otel.context.active());

  ownSpans.add(span);

  if (span.isRecording()) {
    span.setAttribute('db.system.name', SYSTEM_NAME);
    span.setAttribute('db.namespace', database);
    if (init.operationName !== undefined) span.setAttribute('db.operation.name', init.operationName);
    setTarget(span, init);
    if (init.batchSize !== undefined && init.batchSize > 0) {
      span.setAttribute('db.operation.batch.size', init.batchSize);
    }
    if (init.queryText !== undefined) {
      if (scope.config.traceQueryText === CamusQueryTextMode.Raw) {
        span.setAttribute('db.query.text', init.queryText);
      } else if (scope.config.traceQueryText === CamusQueryTextMode.Sanitized) {
        span.setAttribute('db.query.text', sanitizeQueryText(init.queryText));
      }
    }
    span.setAttribute('camusdb.transport', scope.config.protocol);
  }

  return new CamusOperation(otel, span, performance.now(), database, init.operationName);
}

/**
 * Sets the table attributes of a sampled span from the tables its SQL text names:
 * `db.collection.name` when it names one, and `db.query.summary`, which also becomes the span name,
 * when it names any. A typed insert passes its table as `collection`. The text is read only for a
 * sampled span, so an unsampled one costs nothing.
 */
function setTarget(span: OtelSpan, init: OperationInit): void {
  const tables =
    init.collection !== undefined
      ? [init.collection]
      : init.queryText !== undefined
        ? queryTables(init.queryText)
        : [];

  if (tables.length === 1) span.setAttribute('db.collection.name', tables[0]!);

  const summary = querySummary(init.operationName, tables);

  if (summary !== undefined) {
    span.setAttribute('db.query.summary', summary);
    span.updateName(summary);
  }
}

/**
 * Runs one operation under a span, and ends the span with the operation's outcome.
 *
 * Without `@opentelemetry/api`, it only calls `run`.
 */
export async function traced<T>(
  scope: TelemetryScope,
  init: OperationInit,
  run: (operation: CamusOperation | undefined) => Promise<T>,
): Promise<T> {
  const operation = startOperation(scope, init);

  if (operation === undefined) return run(undefined);

  try {
    const result = await operation.run(() => run(operation));

    operation.complete();
    return result;
  } catch (error) {
    operation.fail(error);
    throw error;
  }
}

/**
 * The statement verbs that become `db.operation.name`. A first keyword that is not in this list
 * gives no operation name, so the metric keeps a small set of values.
 */
const KNOWN_OPERATIONS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'EXPLAIN',
  'SHOW',
  'REFRESH',
  'COMMENT',
  'GRANT',
  'REVOKE',
  'SET',
  'CALL',
]);

/**
 * The operation name of a statement: its first keyword in upper case when that keyword is a known
 * verb, and `undefined` if not. Leading white space and opening parentheses are skipped.
 */
export function operationName(sql: string): string | undefined {
  const match = /^[\s(]*([A-Za-z]+)/.exec(sql);
  const keyword = match?.[1]?.toUpperCase();

  return keyword !== undefined && KNOWN_OPERATIONS.has(keyword) ? keyword : undefined;
}

// ─── Driver metrics ─────────────────────────────────────────────────────────

/**
 * Counts one retry, and adds a `camusdb.retry` event to the driver span of the operation, or to the
 * active span when it is one of the driver's.
 */
export function recordRetry(
  kind: CamusRetryKind,
  error: unknown,
  details: { database?: string; operationName?: string; operation?: CamusOperation | undefined } = {},
): void {
  const otel = api();
  if (otel === undefined) return;

  const errorType = CamusError.is(error) ? error.code : errorTypeName(error);

  if (details.operation !== undefined) {
    details.operation.addRetryEvent(kind, errorType);
  } else {
    const active = otel.trace.getActiveSpan();

    if (active !== undefined && ownSpans.has(active)) {
      active.addEvent('camusdb.retry', defined({ 'camusdb.retry.kind': kind, 'error.type': errorType }));
    }
  }

  instrumentsFor(otel).retries.add(
    1,
    defined({
      'camusdb.retry.kind': kind,
      'error.type': errorType,
      'db.namespace': details.database,
      'db.operation.name': details.operationName,
    }),
  );
}

/**
 * Counts one login. A blocking login also adds a `camusdb.login` event to the active span when it is
 * one of the driver's, because that span carries the time of the login.
 */
export function recordLogin(mode: CamusLoginMode, error?: unknown): void {
  const otel = api();
  if (otel === undefined) return;

  const errorType =
    error === undefined ? undefined : CamusError.is(error) ? error.code : errorTypeName(error);

  if (mode === CamusLoginMode.Blocking) {
    const active = otel.trace.getActiveSpan();

    if (active !== undefined && ownSpans.has(active)) {
      active.addEvent('camusdb.login', defined({ 'camusdb.login.mode': mode, 'error.type': errorType }));
    }
  }

  instrumentsFor(otel).logins.add(1, defined({ 'camusdb.login.mode': mode, 'error.type': errorType }));
}

/**
 * Runs `fn` outside the active trace, for work that belongs to no operation: its spans do not show
 * as part of the operation that started it. Without `@opentelemetry/api`, it only calls `fn`.
 */
export function runDetached<T>(fn: () => T): T {
  const otel = api();
  if (otel === undefined) return fn();

  return otel.context.with(otel.ROOT_CONTEXT, fn);
}

/** Counts one endpoint set aside after a transport failure. */
export function recordQuarantine(endpoint: string): void {
  const otel = api();
  if (otel === undefined) return;

  instrumentsFor(otel).quarantines.add(1, endpointAttributes(endpoint));
}

/** Counts one execution of a preparable statement: `hit`, `registered`, or `miss`. */
export function recordPreparedLookup(database: string, result: string): void {
  const otel = api();
  if (otel === undefined) return;

  instrumentsFor(otel).lookups.add(1, {
    'db.namespace': database,
    'camusdb.prepared_statement.result': result,
  });
}

/** Counts one request to prepare a statement: `success`, `refused`, or `unsupported`. */
export function recordPreparedRegistration(database: string, result: string, error?: unknown): void {
  const otel = api();
  if (otel === undefined) return;

  instrumentsFor(otel).registrations.add(
    1,
    defined({
      'db.namespace': database,
      'camusdb.prepared_statement.result': result,
      'error.type':
        error === undefined ? undefined : CamusError.is(error) ? error.code : errorTypeName(error),
    }),
  );
}

/** Counts one prepared statement released to make room for one used more recently. */
export function recordPreparedEviction(database: string): void {
  const otel = api();
  if (otel === undefined) return;

  instrumentsFor(otel).evictions.add(1, { 'db.namespace': database });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The parsed host and port of each endpoint. Endpoints come from configuration, so the map stays small. */
const parsedEndpoints = new Map<string, { host: string; port: number }>();

function parseEndpoint(endpoint: string): { host: string; port: number } {
  let parsed = parsedEndpoints.get(endpoint);

  if (parsed === undefined) {
    try {
      const url = new URL(endpoint);
      const port = url.port.length > 0 ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

      parsed = { host: url.hostname, port };
    } catch {
      parsed = { host: endpoint, port: 0 };
    }

    if (parsedEndpoints.size < 1024) parsedEndpoints.set(endpoint, parsed);
  }

  return parsed;
}

function endpointAttributes(endpoint: string): Attributes {
  const { host, port } = parseEndpoint(endpoint);

  return port > 0 ? { 'server.address': host, 'server.port': port } : { 'server.address': host };
}

/** The attributes without the keys whose value is unknown. The SDK warns about an `undefined` value. */
function defined(attributes: Attributes): Attributes {
  const result: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) result[key] = value;
  }

  return result;
}

function errorTypeName(error: unknown): string {
  if (error instanceof Error) return error.name.length > 0 ? error.name : 'Error';

  return '_OTHER';
}
