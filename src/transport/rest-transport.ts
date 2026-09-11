/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusTokenProvider } from '../auth/token-provider.js';
import type { CamusCacheMetadata } from '../cache.js';
import { makeCacheMetadata } from '../cache.js';
import type { ColumnValue, ColumnValueJson } from '../column-value.js';
import { columnValueToJson } from '../column-value.js';
import { CamusProtocol } from '../config.js';
import type { CamusEndpointPool } from '../endpoint-pool.js';
import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';
import type { CamusHlcTimestamp } from '../hlc.js';
import { asBigInt, asNumber, parseLossless } from '../json.js';
import type { CamusTransactionOptions } from '../options.js';
import { bindPositional } from '../prepared/binder.js';
import { CamusResultSet } from '../result-set.js';
import { routingAdviceFromJson } from '../routing/advice.js';
import type { CamusRowSource } from '../row-source.js';
import {
  createBranchDatabaseSql,
  mapBranchRows,
  showAncestorsSql,
  showBranchesSql,
} from './branch-statements.js';
import { readBody, sendHttp, sendJson, translateErrorBody } from './http.js';
import { NDJSON_CONTENT_TYPE, NdjsonRowSource } from './ndjson-row-source.js';
import { resultSetFromWire } from './rest-decode.js';
import type { RestPreparedStatement } from './rest-prepared-cache.js';
import { RestPreparedStatementCache } from './rest-prepared-cache.js';
import type {
  CamusBranchRow,
  CamusTransport,
  NonQueryTransportResult,
  PreparedStatementInfo,
  QueryTransportResult,
  StartTransactionResult,
  TransportInsertRequest,
  TransportSqlRequest,
} from './transport.js';
import { hasTransaction } from './transport.js';

/** The `{status, code, message}` envelope every REST route wraps its reply in. */
interface StatusEnvelope {
  status?: string;
  code?: string;
  message?: string;
}

interface NonQueryResponseBody extends StatusEnvelope {
  rows?: number;
  routing?: unknown;
}

interface StartTransactionResponseBody extends StatusEnvelope {
  txnIdPT?: number | bigint;
  txnIdCounter?: number;
}

interface PrepareResponseBody extends StatusEnvelope {
  statementId?: string;
  parameterNames?: string[];
}

/** One resolved prepared execution: the handle to name, and this call's values in binding order. */
interface PreparedBinding {
  readonly statementId: string;
  readonly values: ColumnValue[];
}

/**
 * The REST and JSON transport, and the default.
 *
 * Each call is one HTTP request to an `execute-sql-*` or admin route, with JSON in and out. It is
 * the only transport that streams rows incrementally, and the only one the backup admin API is
 * reachable over.
 */
export class RestTransport implements CamusTransport {
  readonly protocol = CamusProtocol.Rest;

  private readonly pool: CamusEndpointPool;

  private readonly auth: CamusTokenProvider;

  private readonly prepared = new RestPreparedStatementCache();

  constructor(pool: CamusEndpointPool, auth: CamusTokenProvider) {
    this.pool = pool;
    this.auth = auth;
  }

  // ─── Transactions ─────────────────────────────────────────────────────────

  async startTransaction(
    endpoint: string,
    database: string,
    options: CamusTransactionOptions,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<StartTransactionResult> {
    const body = await this.post<StartTransactionResponseBody>(
      endpoint,
      ['start-transaction'],
      {
        databaseName: database,
        ...concurrencyFields(options),
      },
      timeoutSeconds,
      signal,
    );

    if (body.status !== 'ok') {
      throw new CamusError(body.code ?? CamusErrorCode.Generic, body.message ?? 'Empty result returned');
    }

    return {
      txnIdPT: asBigInt(body.txnIdPT),
      txnIdCounter: asNumber(body.txnIdCounter),
    };
  }

  async finalizeTransaction(
    commit: boolean,
    endpoint: string,
    database: string,
    txnIdPT: bigint,
    txnIdCounter: number,
    _streamSlot: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    // REST does not pin a transaction to a stream, so the slot means nothing here.
    const path = commit ? 'commit-transaction' : 'rollback-transaction';

    const body = await this.post<StatusEnvelope>(
      endpoint,
      [path],
      { databaseName: database, txnIdPT, txnIdCounter },
      timeoutSeconds,
      signal,
    );

    if (body.status !== 'ok') {
      throw new CamusError(
        body.code ?? CamusErrorCode.Generic,
        body.message ?? (commit ? 'Commit failed' : 'Rollback failed'),
      );
    }
  }

  // ─── Statements ───────────────────────────────────────────────────────────

  executeQuery(request: TransportSqlRequest): Promise<QueryTransportResult> {
    return this.withPrepared(request, (binding) => this.executeQueryCore(request, binding));
  }

  private async executeQueryCore(
    request: TransportSqlRequest,
    binding: PreparedBinding | undefined,
  ): Promise<QueryTransportResult> {
    const { response } = await sendHttp(this.pool, {
      endpoint: request.endpoint,
      path: ['execute-sql-query'],
      method: 'POST',
      body: buildQueryBody(request, binding),
      token: await this.token(request.signal),
      timeoutSeconds: request.timeoutSeconds,
      signal: request.signal,
    });

    const text = await readBody(response);

    if (!response.ok) throw translateErrorBody(response.status, text);

    let body: unknown;

    try {
      body = parseLossless(text);
    } catch (error) {
      throw new CamusError(CamusErrorCode.Generic, 'Empty result returned', { cause: error });
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new CamusError(CamusErrorCode.Generic, 'Empty result returned');
    }

    const record = body as Record<string, unknown>;

    return {
      resultSet: resultSetFromWire(record.columns, record.rows),
      cacheMetadata: cacheMetadataFromJson(record),
      routing: routingAdviceFromJson(record),
    };
  }

  executeQueryStream(request: TransportSqlRequest): Promise<CamusRowSource> {
    return this.withPrepared(request, (binding) => this.executeQueryStreamCore(request, binding));
  }

  private async executeQueryStreamCore(
    request: TransportSqlRequest,
    binding: PreparedBinding | undefined,
  ): Promise<CamusRowSource> {
    const { response } = await sendHttp(this.pool, {
      endpoint: request.endpoint,
      path: ['execute-sql-query-stream'],
      method: 'POST',
      body: buildQueryBody(request, binding),
      token: await this.token(request.signal),
      accept: NDJSON_CONTENT_TYPE,
      timeoutSeconds: request.timeoutSeconds,
      signal: request.signal,
    });

    // A failure to set the statement up — bad SQL, an unknown database — arrives as a non-2xx
    // before the first line. A conflict that surfaces after rows start flowing is reported by the
    // NDJSON trailer instead, and raised from the read that reaches it.
    if (!response.ok) throw translateErrorBody(response.status, await readBody(response));

    if (response.body === null) {
      throw new CamusError(CamusErrorCode.Generic, 'The streaming query response carried no body.');
    }

    return NdjsonRowSource.create(response.body);
  }

  executeNonQuery(request: TransportSqlRequest): Promise<NonQueryTransportResult> {
    return this.withPrepared(request, (binding) => this.executeNonQueryCore(request, binding));
  }

  private async executeNonQueryCore(
    request: TransportSqlRequest,
    binding: PreparedBinding | undefined,
  ): Promise<NonQueryTransportResult> {
    const body = await this.post<NonQueryResponseBody>(
      request.endpoint,
      ['execute-sql-non-query'],
      buildNonQueryBody(request, binding),
      request.timeoutSeconds,
      request.signal,
    );

    return {
      affectedRows: asNumber(body.rows),
      routing: routingAdviceFromJson(body),
    };
  }

  async insert(request: TransportInsertRequest): Promise<number> {
    const body: Record<string, unknown> = {
      databaseName: request.database,
      tableName: request.table,
      values: parametersToJson(request.values),
    };

    if (hasTransaction(request)) {
      body.txnIdPT = request.txnIdPT;
      body.txnIdCounter = request.txnIdCounter;
    }

    const reply = await this.post<NonQueryResponseBody>(
      request.endpoint,
      ['insert'],
      body,
      request.timeoutSeconds,
      request.signal,
    );

    return asNumber(reply.rows);
  }

  async executeDdl(request: TransportSqlRequest): Promise<boolean> {
    const body: Record<string, unknown> = {
      databaseName: request.database,
      sql: request.sql,
    };

    if (hasTransaction(request)) {
      body.txnIdPT = request.txnIdPT;
      body.txnIdCounter = request.txnIdCounter;
    } else if (request.autocommitOptions !== undefined) {
      Object.assign(body, concurrencyFields(request.autocommitOptions));
    }

    const reply = await this.post<StatusEnvelope>(
      request.endpoint,
      ['execute-sql-ddl'],
      body,
      request.timeoutSeconds,
      request.signal,
    );

    return reply.status === 'ok';
  }

  async ping(endpoint: string, timeoutSeconds: number, signal?: AbortSignal): Promise<boolean> {
    const body = await sendJson<StatusEnvelope>(this.pool, {
      endpoint,
      path: ['ping'],
      method: 'GET',
      token: await this.token(signal),
      timeoutSeconds,
      signal,
    });

    return body.status === 'ok';
  }

  // ─── Database administration ──────────────────────────────────────────────

  async createDatabase(
    endpoint: string,
    database: string,
    ifNotExists: boolean,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = await this.post<StatusEnvelope>(
      endpoint,
      ['create-db'],
      { databaseName: database, ifNotExists },
      timeoutSeconds,
      signal,
    );

    if (body.status !== 'ok') {
      throw new CamusError(body.code ?? CamusErrorCode.Generic, body.message ?? 'Create database failed');
    }
  }

  /**
   * Creates a copy-on-write branch.
   *
   * Branching has no REST route of its own: the server implements it only as SQL, so the statement
   * is composed and sent down the ordinary DDL route — which is what the gRPC transport does too.
   */
  async createBranchDatabase(
    endpoint: string,
    branchName: string,
    sourceDatabaseName: string,
    ifNotExists: boolean,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.adminDdl(
      endpoint,
      createBranchDatabaseSql(branchName, sourceDatabaseName, ifNotExists),
      timeoutSeconds,
      signal,
    );
  }

  async dropDatabase(
    endpoint: string,
    database: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = await this.post<StatusEnvelope>(
      endpoint,
      ['drop-db'],
      { databaseName: database },
      timeoutSeconds,
      signal,
    );

    if (body.status !== 'ok') {
      throw new CamusError(body.code ?? CamusErrorCode.Generic, body.message ?? 'Drop database failed');
    }
  }

  /** See `createBranchDatabase`: a branch listing is a SQL statement, not a route. */
  async showBranches(
    endpoint: string,
    database: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CamusBranchRow[]> {
    return mapBranchRows(
      await this.adminQuery(endpoint, database, showBranchesSql(database), timeoutSeconds, signal),
    );
  }

  /** See `createBranchDatabase`. */
  async showAncestors(
    endpoint: string,
    database: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CamusBranchRow[]> {
    return mapBranchRows(
      await this.adminQuery(endpoint, database, showAncestorsSql(database), timeoutSeconds, signal),
    );
  }

  /** Runs a composed administration statement on the DDL route. */
  private async adminDdl(
    endpoint: string,
    sql: string,
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.executeDdl({
      endpoint,
      database: '',
      sql,
      timeoutSeconds,
      prepared: false,
      routingAcceptVersion: 0,
      signal,
    });
  }

  /** Runs a composed administration query on the ordinary query route. */
  private async adminQuery(
    endpoint: string,
    database: string,
    sql: string,
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
  ): Promise<CamusResultSet> {
    const result = await this.executeQueryCore(
      {
        endpoint,
        database,
        sql,
        timeoutSeconds,
        prepared: false,
        routingAcceptVersion: 0,
        signal,
      },
      undefined,
    );

    return result.resultSet;
  }

  // ─── Prepared statements ──────────────────────────────────────────────────

  async prepare(
    endpoint: string,
    database: string,
    sql: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<PreparedStatementInfo> {
    const statement = await this.prepared.getOrAdd({ endpoint, database, sql }, () =>
      this.register(endpoint, database, sql, timeoutSeconds, signal),
    );

    return { parameterNames: statement.parameterNames };
  }

  private async register(
    endpoint: string,
    database: string,
    sql: string,
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
  ): Promise<RestPreparedStatement> {
    const body = await this.post<PrepareResponseBody>(
      endpoint,
      ['prepare-sql-statement'],
      { databaseName: database, sql },
      timeoutSeconds,
      signal,
    );

    if (body.status !== 'ok' || body.statementId === undefined || body.statementId.length === 0) {
      throw new CamusError(body.code ?? CamusErrorCode.Generic, body.message ?? 'Prepare statement failed');
    }

    return { statementId: body.statementId, parameterNames: body.parameterNames ?? [] };
  }

  async closePrepared(_endpoint: string, database: string, sql: string, signal?: AbortSignal): Promise<void> {
    // A statement is closed on every node it was registered on, not only the one the caller is
    // sending to, so the endpoint argument is not the one used here.
    for (const { endpoint: registeredOn, statement } of await this.prepared.take(database, sql)) {
      try {
        await this.post<StatusEnvelope>(
          registeredOn,
          ['close-sql-statement'],
          { statementId: statement.statementId },
          10,
          signal,
        );
      } catch {
        // Best effort: a node that is gone, or a handle it already reclaimed, needs nothing here.
      }
    }
  }

  /**
   * Runs one statement, as a prepared execution when the request asked for it.
   *
   * Two failures are absorbed rather than reported, because preparing is an optimization and must
   * never be the reason a working statement fails.
   *
   * A registration that fails at all — no server support for the route, a statement kind that may
   * not be prepared, a full server-side cap — falls back to running the statement inline, which is
   * what it would have done anyway.
   *
   * An execution refused with `CADB0520` means the handle is gone: it idled out, the node
   * restarted, or the request landed on another node. That is routine by contract, so the
   * registration is dropped and the statement is prepared and replayed exactly once. One replay,
   * not a loop: a second unknown-statement failure means something is wrong beyond a stale handle
   * — a load balancer sending every request to a different node, say — and spinning there would
   * turn a slow path into an endless one.
   */
  private async withPrepared<T>(
    request: TransportSqlRequest,
    send: (binding: PreparedBinding | undefined) => Promise<T>,
  ): Promise<T> {
    if (!request.prepared) return send(undefined);

    const key = { endpoint: request.endpoint, database: request.database, sql: request.sql };

    for (let attempt = 0; ; attempt++) {
      let statement: RestPreparedStatement;
      let values: ColumnValue[];

      try {
        statement = await this.prepared.getOrAdd(key, () =>
          this.register(
            request.endpoint,
            request.database,
            request.sql,
            request.timeoutSeconds,
            request.signal,
          ),
        );

        values = bindPositional(statement.parameterNames, request.parameters);
      } catch (error) {
        if (!CamusError.is(error)) throw error;

        // Either the server would not register the statement, or the caller has not bound every
        // placeholder it declares. Both run inline: the first because preparing is an
        // optimization, the second so an unbound parameter is reported by the engine exactly as it
        // would be for a statement that was never prepared.
        return send(undefined);
      }

      try {
        return await send({ statementId: statement.statementId, values });
      } catch (error) {
        if (attempt > 0 || !CamusError.is(error) || error.code !== CamusErrorCode.UnknownPreparedStatement) {
          throw error;
        }

        this.prepared.invalidate(key, statement);
      }
    }
  }

  async close(): Promise<void> {
    // The REST transport holds no socket of its own; the global fetch agent owns the connections.
  }

  private async post<T>(
    endpoint: string,
    path: readonly string[],
    body: unknown,
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    return sendJson<T>(this.pool, {
      endpoint,
      path,
      method: 'POST',
      body,
      token: await this.token(signal),
      timeoutSeconds,
      signal,
    });
  }

  /**
   * The bearer token to present, if this client has one.
   *
   * Every route goes through here, so none can accidentally be built unauthenticated. With no
   * credentials configured there is no token and no `Authorization` header at all, which is what a
   * server with authentication off expects.
   */
  private token(signal: AbortSignal | undefined): Promise<string | undefined> {
    return this.auth.getToken(signal);
  }
}

function buildQueryBody(
  request: TransportSqlRequest,
  binding: PreparedBinding | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> =
    binding === undefined
      ? {
          databaseName: request.database,
          sql: request.sql,
          parameters: parametersToJson(request.parameters),
        }
      : {
          statementId: binding.statementId,
          positionalParameters: binding.values.map(columnValueToJson),
        };

  if (hasTransaction(request)) {
    body.txnIdPT = request.txnIdPT;
    body.txnIdCounter = request.txnIdCounter;
  }

  if (request.routingAcceptVersion > 0) body.routingAcceptVersion = request.routingAcceptVersion;

  return body;
}

function buildNonQueryBody(
  request: TransportSqlRequest,
  binding: PreparedBinding | undefined,
): Record<string, unknown> {
  const body = buildQueryBody(request, binding);

  if (!hasTransaction(request) && request.autocommitOptions !== undefined) {
    Object.assign(body, concurrencyFields(request.autocommitOptions));
  }

  return body;
}

/** The `isolationLevel`, `transactionMode`, and `locking` fields, omitting every unset knob. */
function concurrencyFields(options: CamusTransactionOptions): Record<string, string> {
  const fields: Record<string, string> = {};

  if (options.isolationLevel !== undefined) fields.isolationLevel = options.isolationLevel;
  if (options.mode !== undefined) fields.transactionMode = options.mode;
  if (options.locking !== undefined) fields.locking = options.locking;

  return fields;
}

function parametersToJson(
  parameters: ReadonlyMap<string, ColumnValue> | undefined,
): Record<string, ColumnValueJson> | undefined {
  if (parameters === undefined || parameters.size === 0) return undefined;

  const json: Record<string, ColumnValueJson> = {};

  for (const [name, value] of parameters) json[name] = columnValueToJson(value);

  return json;
}

function cacheMetadataFromJson(body: Record<string, unknown>): CamusCacheMetadata | undefined {
  const status = readString(body.cacheStatus);
  const name = readString(body.cacheName);

  if (status === undefined && name === undefined) return undefined;

  let cachedAtHlc: CamusHlcTimestamp | undefined;
  const hlc = body.cachedAtHlc;

  if (typeof hlc === 'object' && hlc !== null) {
    const record = hlc as Record<string, unknown>;
    cachedAtHlc = { l: asBigInt(record.l), c: asNumber(record.c) };
  }

  return makeCacheMetadata({
    rawStatus: status,
    bypassReason: readString(body.cacheBypassReason),
    name,
    cachedAtHlc,
    ageMs: body.ageMs === undefined || body.ageMs === null ? undefined : asNumber(body.ageMs),
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Re-exported so a caller that only imports this module can still build an empty result. */
export const EMPTY_RESULT_SET = CamusResultSet.EMPTY;
