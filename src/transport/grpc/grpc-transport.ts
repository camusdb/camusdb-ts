/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusLoginClient, CamusLoginResult } from '../../auth/login-client.js';
import type { CamusTokenProvider } from '../../auth/token-provider.js';
import type { ColumnValue } from '../../column-value.js';
import type { GrpcBatchOptions } from '../../config.js';
import { CamusProtocol } from '../../config.js';
import { CamusError } from '../../errors.js';
import { CamusErrorCode } from '../../error-codes.js';
import type { CamusEndpointPool } from '../../endpoint-pool.js';
import type { CamusTransactionOptions } from '../../options.js';
import { setOwn } from '../../own-record.js';
import { CamusIsolationLevel, CamusLocking, CamusTransactionMode } from '../../options.js';
import { bindPositional } from '../../prepared/binder.js';
import type { CamusResultSet } from '../../result-set.js';
import type { CamusRowSource } from '../../row-source.js';
import { BufferedRowSource } from '../../row-source.js';
import { sanitizeErrorText } from '../error-text.js';
import {
  createBranchDatabaseSql,
  createDatabaseSql,
  dropDatabaseSql,
  mapBranchRows,
  showAncestorsSql,
  showBranchesSql,
} from '../branch-statements.js';
import type {
  CamusBranchRow,
  CamusTransport,
  NonQueryTransportResult,
  PreparedStatementInfo,
  QueryTransportResult,
  StartTransactionResult,
  TransportInsertRequest,
  TransportSqlRequest,
} from '../transport.js';
import { hasTransaction } from '../transport.js';
import { announcesFrames, FRAME_ACCEPT_HEADER, FRAME_HEADER, FRAME_VERSION } from './batch-frames.js';
import type { BatchCausalToken, BatchStream, PreparedSlotEntry } from './batcher.js';
import { EMPTY_CAUSAL_TOKEN, GrpcBatcher, PreparedStatementStaleError } from './batcher.js';
import { buildResultSet, encodeValue, fromWire, toWire } from './codec.js';
import { indicatesEndpointDown, isEndpointUnreachable } from './endpoint-health.js';
import type {
  GrpcBatchExecuteRequest,
  GrpcBatchExecuteResponse,
  GrpcDdlReply,
  GrpcInsertRowRequest,
  GrpcLoginReply,
  GrpcNonQueryReply,
  GrpcPingReply,
  GrpcSqlRequest,
  GrpcTxnHandle,
  GrpcValue,
} from './messages.js';
import { GrpcIsolationLevel, GrpcLockingMode, GrpcTransactionMode } from './messages.js';
import type {
  GrpcDuplexCall,
  GrpcMetadata,
  GrpcRuntime,
  GrpcServiceClient,
  GrpcStatusError,
} from './proto.js';
import { loadGrpc, serviceConstructor } from './proto.js';

/** How long a channel stays open, and how long an idle one is kept. */
const KEEPALIVE_TIME_MS = 30_000;
const KEEPALIVE_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

interface ChannelEntry {
  readonly sql: GrpcServiceClient;
  readonly auth: GrpcServiceClient;
  readonly rows: GrpcServiceClient;
  batcher: GrpcBatcher | undefined;
}

/**
 * The gRPC transport.
 *
 * Its data plane does not make one call per statement. Statements ride a small pool of long-lived
 * `BatchExecute` duplex streams per endpoint, so many statements — and many concurrent
 * transactions — share one HTTP/2 connection and one set of streams. DDL, ping, the typed row
 * insert, and the credential exchange stay unary, because each is a single call whose reply has
 * nowhere to interleave.
 *
 * The transport also carries the session's causal token. Every reply reports a hybrid-logical-clock
 * instant, the transport keeps the greatest one it has seen, and every request carries it back. That
 * is what makes a read see this session's own earlier writes even when it lands on a different node.
 */
export class GrpcTransport implements CamusTransport, CamusLoginClient {
  readonly protocol = CamusProtocol.Grpc;

  private readonly auth: CamusTokenProvider;

  private readonly batchOptions: GrpcBatchOptions;

  /**
   * The deployment's endpoint rotation, so a failure to reach a node sets it aside for every
   * caller that shares this transport. The REST transport always did this; gRPC did not.
   */
  private readonly pool: CamusEndpointPool | undefined;

  private readonly channels = new Map<string, ChannelEntry>();

  private runtime: GrpcRuntime | undefined;

  private causalToken: BatchCausalToken = EMPTY_CAUSAL_TOKEN;

  private closed = false;

  constructor(pool: CamusEndpointPool | undefined, auth: CamusTokenProvider, batchOptions: GrpcBatchOptions) {
    this.pool = pool;
    this.auth = auth;
    this.batchOptions = batchOptions;
  }

  // ─── Transactions ─────────────────────────────────────────────────────────

  async startTransaction(
    endpoint: string,
    database: string,
    options: CamusTransactionOptions,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<StartTransactionResult> {
    await this.auth.getToken(signal);

    const batcher = await this.batcherFor(endpoint);
    const slot = batcher.reserveSlot();

    // A start reuses the SQL request's database and concurrency fields; its `sql` is ignored.
    const request: GrpcSqlRequest = { database, ...concurrencyFields(options) };

    return this.withDeadline(timeoutSeconds, signal, async (callSignal) => {
      const handle = await batcher.enqueueStart(request, slot, callSignal);

      this.observeToken({
        n: handle.causalTokenN,
        l: fromWire(handle.causalTokenL),
        c: fromWire(handle.causalTokenC),
      });

      return {
        txnIdPT: fromWire(handle.txnIdPt),
        txnIdCounter: handle.txnIdCounter,
        streamSlot: slot,
      };
    });
  }

  async finalizeTransaction(
    commit: boolean,
    endpoint: string,
    database: string,
    txnIdPT: bigint,
    txnIdCounter: number,
    streamSlot: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.auth.getToken(signal);

    const batcher = await this.batcherFor(endpoint);
    const slot = streamSlot ?? batcher.reserveSlot();

    const request: GrpcSqlRequest = { database, txnHandle: this.buildHandle(txnIdPT, txnIdCounter) };

    await this.withDeadline(timeoutSeconds, signal, async (callSignal) => {
      if (commit) {
        this.observeToken(await batcher.enqueueCommit(request, slot, callSignal));
        return;
      }

      await batcher.enqueueRollback(request, slot, callSignal);
    });
  }

  // ─── Statements ───────────────────────────────────────────────────────────

  async executeQuery(request: TransportSqlRequest): Promise<QueryTransportResult> {
    await this.auth.getToken(request.signal);

    return this.withDeadline(request.timeoutSeconds, request.signal, async (callSignal) => {
      const batcher = await this.batcherFor(request.endpoint);

      const result = await this.executeBatched(batcher, request, callSignal, (wire, slot, transportId) =>
        batcher.enqueueQuery(wire, slot, callSignal, transportId),
      );

      this.observeToken(result.token);

      return {
        resultSet: buildResultSet(result.schema, result.rows),
        cacheMetadata: result.cacheMetadata,
        routing: result.routing,
      };
    });
  }

  /**
   * The gRPC data plane multiplexes over shared streams that decode a whole result before
   * returning, so this buffers and replays through the same interface. The caller's API is uniform
   * across transports even though only REST is truly incremental; the streaming endpoint this
   * feature targets is REST-only.
   */
  async executeQueryStream(request: TransportSqlRequest): Promise<CamusRowSource> {
    const result = await this.executeQuery(request);
    return new BufferedRowSource(result.resultSet);
  }

  async executeNonQuery(request: TransportSqlRequest): Promise<NonQueryTransportResult> {
    await this.auth.getToken(request.signal);

    return this.withDeadline(request.timeoutSeconds, request.signal, async (callSignal) => {
      const batcher = await this.batcherFor(request.endpoint);

      const result = await this.executeBatched(batcher, request, callSignal, (wire, slot, transportId) =>
        batcher.enqueueNonQuery(wire, slot, callSignal, transportId),
      );

      this.observeToken(result.token);

      return { affectedRows: result.affectedRows, routing: result.routing };
    });
  }

  // ─── Prepared statements ──────────────────────────────────────────────────

  async prepare(
    endpoint: string,
    database: string,
    sql: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<PreparedStatementInfo> {
    await this.auth.getToken(signal);

    const batcher = await this.batcherFor(endpoint);

    return this.withDeadline(timeoutSeconds, signal, async (callSignal) => {
      const entry = await batcher.ensurePrepared(batcher.reserveSlot(), database, sql, callSignal);
      return { parameterNames: entry.parameterNames };
    });
  }

  async closePrepared(endpoint: string, database: string, sql: string, signal?: AbortSignal): Promise<void> {
    // Only a batcher that already exists can hold a registration, and asking for one here would
    // open the whole stream pool just to release nothing.
    const batcher = this.channels.get(endpoint)?.batcher;
    if (batcher === undefined) return;

    for (const { slotIndex, entry } of await batcher.takePrepared(database, sql)) {
      await batcher.closePrepared(slotIndex, entry, signal);
    }
  }

  /**
   * Runs one statement over the batcher, as a prepared execution when the request asked for it.
   *
   * A registration that fails at all falls back to running the statement inline. An execution that
   * names a handle the server or the stream no longer has is retried exactly once, after the
   * registration is dropped and made again.
   */
  private async executeBatched<T>(
    batcher: GrpcBatcher,
    request: TransportSqlRequest,
    signal: AbortSignal | undefined,
    send: (wire: GrpcSqlRequest, slot: number | undefined, transportId: number | undefined) => Promise<T>,
  ): Promise<T> {
    if (!request.prepared) {
      return send(this.buildSqlRequest(request), request.streamSlot, undefined);
    }

    // A transaction that finishes on a stream that was rotated out cannot use the slot's
    // registration, which lives on the stream that replaced it. See `isBoundToRetiredStream`.
    if (hasTransaction(request) && batcher.isBoundToRetiredStream(request.txnIdPT, request.txnIdCounter)) {
      return send(this.buildSqlRequest(request), request.streamSlot, undefined);
    }

    const slot = request.streamSlot ?? batcher.reserveSlot();

    for (let attempt = 0; ; attempt++) {
      let entry: PreparedSlotEntry;
      let wire: GrpcSqlRequest;

      try {
        entry = await batcher.ensurePrepared(slot, request.database, request.sql, signal);
        wire = this.buildPreparedSqlRequest(request, entry);
      } catch (error) {
        if (!CamusError.is(error)) throw error;

        return send(this.buildSqlRequest(request), slot, undefined);
      }

      try {
        return await send(wire, slot, entry.transportId);
      } catch (error) {
        if (!isStaleRegistration(error)) throw error;

        batcher.invalidatePrepared(slot, request.database, request.sql, entry);

        if (attempt === 0) continue;

        // Stale twice running: the stream this operation is bound for keeps differing from the one
        // the registration is on, because a rotation landed between the check and the write. The
        // refusal is raised before anything is written, so nothing ran, and to run inline is safe.
        // Preparing is an optimization. It must never be the reason a statement fails.
        if (error instanceof PreparedStatementStaleError) {
          return send(this.buildSqlRequest(request), slot, undefined);
        }

        throw error;
      }
    }
  }

  // ─── Unary calls ──────────────────────────────────────────────────────────

  async executeDdl(request: TransportSqlRequest): Promise<boolean> {
    const reply = await this.unary<GrpcDdlReply>(
      request.endpoint,
      'sql',
      'executeDdl',
      this.buildSqlRequest(request),
      request.timeoutSeconds,
      request.signal,
    );

    this.observeToken({
      n: reply.causalTokenN,
      l: fromWire(reply.causalTokenL),
      c: fromWire(reply.causalTokenC),
    });

    // A DDL reply with no error means success; a failure arrives as a gRPC status instead.
    return true;
  }

  async insert(request: TransportInsertRequest): Promise<number> {
    const wire: GrpcInsertRowRequest = {
      database: request.database,
      table: request.table,
      values: encodeParameters(request.values),
    };

    if (hasTransaction(request)) {
      wire.txnHandle = this.buildHandle(request.txnIdPT, request.txnIdCounter);
    } else {
      wire.causalTokenN = this.causalToken.n;
      wire.causalTokenL = toWire(this.causalToken.l);
      wire.causalTokenC = toWire(this.causalToken.c);
    }

    const reply = await this.unary<GrpcNonQueryReply>(
      request.endpoint,
      'rows',
      'insertRow',
      wire,
      request.timeoutSeconds,
      request.signal,
    );

    this.observeToken({
      n: reply.causalTokenN,
      l: fromWire(reply.causalTokenL),
      c: fromWire(reply.causalTokenC),
    });

    return reply.affectedRows;
  }

  async ping(endpoint: string, timeoutSeconds: number, signal?: AbortSignal): Promise<boolean> {
    const reply = await this.unary<GrpcPingReply>(endpoint, 'sql', 'ping', {}, timeoutSeconds, signal);
    return reply !== null && reply !== undefined;
  }

  // ─── Database administration, composed as SQL ─────────────────────────────

  createDatabase(
    endpoint: string,
    database: string,
    ifNotExists: boolean,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.adminDdl(endpoint, createDatabaseSql(database, ifNotExists), timeoutSeconds, signal);
  }

  createBranchDatabase(
    endpoint: string,
    branchName: string,
    sourceDatabaseName: string,
    ifNotExists: boolean,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.adminDdl(
      endpoint,
      createBranchDatabaseSql(branchName, sourceDatabaseName, ifNotExists),
      timeoutSeconds,
      signal,
    );
  }

  dropDatabase(
    endpoint: string,
    database: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.adminDdl(endpoint, dropDatabaseSql(database), timeoutSeconds, signal);
  }

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

  private adminDdl(
    endpoint: string,
    sql: string,
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return this.executeDdl({
      endpoint,
      database: '',
      sql,
      timeoutSeconds,
      prepared: false,
      routingAcceptVersion: 0,
      signal,
    }).then(() => undefined);
  }

  private async adminQuery(
    endpoint: string,
    database: string,
    sql: string,
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
  ): Promise<CamusResultSet> {
    const result = await this.executeQuery({
      endpoint,
      database,
      sql,
      timeoutSeconds,
      prepared: false,
      routingAcceptVersion: 0,
      signal,
    });

    return result.resultSet;
  }

  // ─── Credential exchange ──────────────────────────────────────────────────

  async login(
    endpoint: string,
    user: string,
    password: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CamusLoginResult> {
    const reply = await this.unary<GrpcLoginReply>(
      endpoint,
      'auth',
      'login',
      { user, password },
      timeoutSeconds,
      signal,
      // The login is the one call that must not present a token: the client has none yet.
      null,
    );

    return { token: reply.token, expiresInMs: readExpiryMs(reply) };
  }

  async logout(endpoint: string, token: string, timeoutSeconds: number, signal?: AbortSignal): Promise<void> {
    await this.unary(endpoint, 'auth', 'logout', {}, timeoutSeconds, signal, token);
  }

  // ─── Channels and calls ───────────────────────────────────────────────────

  private async entryFor(endpoint: string): Promise<ChannelEntry> {
    const existing = this.channels.get(endpoint);
    if (existing !== undefined) return existing;

    const { runtime, definition } = await loadGrpc();

    this.runtime = runtime;

    // A concurrent caller may have finished the load first.
    const raced = this.channels.get(endpoint);
    if (raced !== undefined) return raced;

    const { address, credentials } = channelTarget(runtime, endpoint);

    const options = {
      'grpc.keepalive_time_ms': KEEPALIVE_TIME_MS,
      'grpc.keepalive_timeout_ms': KEEPALIVE_TIMEOUT_MS,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
      'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
    };

    const entry: ChannelEntry = {
      sql: new (serviceConstructor(definition, 'CamusSql'))(address, credentials, options),
      auth: new (serviceConstructor(definition, 'CamusAuth'))(address, credentials, options),
      rows: new (serviceConstructor(definition, 'CamusRows'))(address, credentials, options),
      batcher: undefined,
    };

    this.channels.set(endpoint, entry);
    return entry;
  }

  /**
   * The batcher for an endpoint, opening its stream pool on first use.
   *
   * It is built lazily because the pool opens every stream at once: a client that only logs in,
   * pings, or runs DDL never needs them, and — since a stream carries the token it was opened with
   * — opening them before the first login would open them unauthenticated.
   */
  private async batcherFor(endpoint: string): Promise<GrpcBatcher> {
    const entry = await this.entryFor(endpoint);

    // The factory reads the current token on every call rather than closing over one, so a stream
    // that is rebuilt after a fault carries the new token. The stamp is that same token, handed
    // over separately, so the batcher can tell that a live stream was opened under a token that
    // has since been replaced, and rotate it.
    entry.batcher ??= new GrpcBatcher(
      this.batchOptions,
      (id) => this.createBatchStream(id, entry.sql, endpoint),
      () => this.auth.currentToken,
    );

    return entry.batcher;
  }

  /**
   * Opens one `BatchExecute` duplex call.
   *
   * The batcher rebuilds a faulted stream on its own, so the token is read here, at open time,
   * rather than captured once. A stream re-opened after a token refresh carries the new token.
   *
   * Frames are negotiated per stream. The opening metadata says which contract version this client
   * reads, and the server's response headers say whether it reads one in turn. The announcement is
   * watched off the operation path: every operation is its own message until it arrives, and for
   * good against a server that makes none.
   */
  private createBatchStream(id: number, client: GrpcServiceClient, endpoint: string): BatchStream {
    // Captured, because `listen` below is a method on the returned object and `this` is not the
    // transport inside it.
    const pool = this.pool;

    const method = client.batchExecute as (
      metadata?: GrpcMetadata,
    ) => GrpcDuplexCall<GrpcBatchExecuteRequest, GrpcBatchExecuteResponse>;

    const metadata = this.buildMetadata(this.auth.currentToken);

    // Sent only when frames are enabled, so a stream that opted out is a stream without frames in
    // both directions. A server built before frames ignores the header.
    if (this.batchOptions.requestFrames) {
      metadata.set(FRAME_ACCEPT_HEADER, String(FRAME_VERSION));
    }

    const call = method.call(client, metadata);

    let closed = false;
    let announced = false;

    call.on('metadata', (headers: GrpcMetadata) => {
      if (announcesFrames(headerValue(headers, FRAME_HEADER))) announced = true;
    });

    return {
      id,

      get framesAnnounced() {
        return announced;
      },

      send(request) {
        call.write(request);
      },

      listen({ onMessage, onClose }) {
        const finish = (error: Error): void => {
          if (closed) return;
          closed = true;
          onClose(error);
        };

        call.on('data', onMessage);
        call.on('error', (error: GrpcStatusError) => finish(translateGrpcFailure(pool, endpoint, error)));
        call.on('end', () =>
          finish(
            new CamusError(CamusErrorCode.Generic, `Endpoint ${endpoint}: the gRPC batch stream closed.`),
          ),
        );
      },

      close() {
        closed = true;

        try {
          call.end();
        } catch {
          // The stream is already broken.
        }
      },
    };
  }

  private async unary<T>(
    endpoint: string,
    service: 'sql' | 'auth' | 'rows',
    method: string,
    request: unknown,
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
    token?: string | null,
  ): Promise<T> {
    const entry = await this.entryFor(endpoint);
    const client = entry[service];

    // `null` means this call must present no token; `undefined` means take the client's own.
    const bearer = token === null ? undefined : (token ?? (await this.auth.getToken(signal)));
    const metadata = this.buildMetadata(bearer);

    const options: Record<string, unknown> = {};

    if (timeoutSeconds > 0) {
      options.deadline = new Date(Date.now() + timeoutSeconds * 1000);
    }

    return new Promise<T>((resolve, reject) => {
      const call = (
        client[method] as (
          request: unknown,
          metadata: GrpcMetadata,
          options: unknown,
          callback: (error: GrpcStatusError | null, reply: T) => void,
        ) => { cancel: () => void }
      ).call(client, request, metadata, options, (error, reply) => {
        signal?.removeEventListener('abort', onAbort);

        if (error !== null && error !== undefined) {
          reject(this.translate(endpoint, error));
          return;
        }

        resolve(reply);
      });

      function onAbort(): void {
        call.cancel();
      }

      if (signal !== undefined) {
        if (signal.aborted) {
          call.cancel();
          reject(signal.reason as Error);
          return;
        }

        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Translates a gRPC failure on `endpoint`, and sets the endpoint aside first when the failure
   * says the node stopped answering.
   */
  private translate(endpoint: string, error: GrpcStatusError): CamusError {
    return translateGrpcFailure(this.pool, endpoint, error);
  }

  /**
   * The call metadata, carrying the bearer token when this client has one.
   *
   * It is always a real `Metadata` instance, even when there is nothing to put in it. A call that
   * passes four arguments — request, metadata, options, callback — is refused outright by grpc-js
   * unless the second one is a `Metadata`, so an unauthenticated client cannot simply leave it out.
   */
  private buildMetadata(token: string | undefined): GrpcMetadata {
    if (this.runtime === undefined) {
      throw new CamusError(CamusErrorCode.Generic, 'The gRPC runtime is not loaded yet.');
    }

    const metadata = new this.runtime.Metadata();

    if (token !== undefined && token.length > 0) metadata.set('authorization', `Bearer ${token}`);

    return metadata;
  }

  // ─── Wire building ────────────────────────────────────────────────────────

  private buildSqlRequest(request: TransportSqlRequest): GrpcSqlRequest {
    return this.applyExecutionContext(
      {
        database: request.database,
        sql: request.sql,
        parameters: encodeParameters(request.parameters),
      },
      request,
    );
  }

  private buildPreparedSqlRequest(request: TransportSqlRequest, entry: PreparedSlotEntry): GrpcSqlRequest {
    return this.applyExecutionContext(
      {
        statementId: entry.statementId,
        positionalParameters: bindPositional(entry.parameterNames, request.parameters).map(encodeValue),
      },
      request,
    );
  }

  private applyExecutionContext(wire: GrpcSqlRequest, request: TransportSqlRequest): GrpcSqlRequest {
    if (hasTransaction(request)) {
      wire.txnHandle = this.buildHandle(request.txnIdPT, request.txnIdCounter);
    } else {
      if (request.autocommitOptions !== undefined) {
        Object.assign(wire, concurrencyFields(request.autocommitOptions));
      }

      wire.causalTokenN = this.causalToken.n;
      wire.causalTokenL = toWire(this.causalToken.l);
      wire.causalTokenC = toWire(this.causalToken.c);
    }

    // Forwarded for a prepared and an inline request alike: negotiation is a property of the
    // statement's execution, not of how its text travelled. Zero asks for nothing.
    wire.routingAcceptVersion = request.routingAcceptVersion;

    return wire;
  }

  /**
   * A transaction handle carrying this session's latest observed token, so the statements of a
   * resumed transaction keep their causal ordering. All three clock components must travel: the
   * node dimension participates in equality and is the tie-breaker, so a token without it is a
   * lossy copy.
   */
  private buildHandle(txnIdPT: bigint, txnIdCounter: number): GrpcTxnHandle {
    return {
      txnIdPt: toWire(txnIdPT),
      txnIdCounter,
      causalTokenN: this.causalToken.n,
      causalTokenL: toWire(this.causalToken.l),
      causalTokenC: toWire(this.causalToken.c),
    };
  }

  /**
   * Merges a reply's token, keeping the clock maximum — physical component first, then the logical
   * counter, then the node id — so the token this session threads advances whatever order replies
   * arrive in. The node id is the tie-breaker `buildHandle` documents, so it decides a merge that
   * the first two components leave equal.
   */
  private observeToken(token: BatchCausalToken): void {
    if (token.l === 0n && token.c === 0n) return;

    const current = this.causalToken;

    if (token.l < current.l) return;

    if (token.l === current.l) {
      if (token.c < current.c) return;
      if (token.c === current.c && token.n <= current.n) return;
    }

    this.causalToken = token;
  }

  /**
   * Runs one operation under a deadline linked to the caller's own cancellation, so a wedged
   * stream cannot hang a caller forever.
   */
  private async withDeadline<T>(
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    if (timeoutSeconds <= 0) return operation(signal);

    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort(
        new CamusError(CamusErrorCode.Generic, `The request timed out after ${String(timeoutSeconds)}s.`),
      );
    }, timeoutSeconds * 1000);

    timer.unref?.();

    const onAbort = (): void => controller.abort(signal!.reason);

    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;

    for (const entry of this.channels.values()) {
      if (entry.batcher !== undefined) await entry.batcher.dispose();

      entry.sql.close?.();
      entry.auth.close?.();
      entry.rows.close?.();
    }

    this.channels.clear();
  }
}

function isStaleRegistration(error: unknown): boolean {
  return (
    error instanceof PreparedStatementStaleError ||
    (CamusError.is(error) && error.code === CamusErrorCode.UnknownPreparedStatement)
  );
}

function encodeParameters(
  parameters: ReadonlyMap<string, ColumnValue> | undefined,
): Record<string, GrpcValue> {
  const encoded: Record<string, GrpcValue> = {};

  if (parameters !== undefined) {
    for (const [name, value] of parameters) setOwn(encoded, name, encodeValue(value));
  }

  return encoded;
}

function concurrencyFields(
  options: CamusTransactionOptions,
): Pick<GrpcSqlRequest, 'isolationLevel' | 'transactionMode' | 'locking'> {
  return {
    isolationLevel:
      options.isolationLevel === CamusIsolationLevel.ReadCommitted
        ? GrpcIsolationLevel.ReadCommitted
        : options.isolationLevel === CamusIsolationLevel.Serializable
          ? GrpcIsolationLevel.Serializable
          : GrpcIsolationLevel.Unspecified,

    transactionMode:
      options.mode === CamusTransactionMode.ReadWrite
        ? GrpcTransactionMode.ReadWrite
        : options.mode === CamusTransactionMode.ReadOnly
          ? GrpcTransactionMode.ReadOnly
          : GrpcTransactionMode.Unspecified,

    locking:
      options.locking === CamusLocking.Pessimistic
        ? GrpcLockingMode.Pessimistic
        : options.locking === CamusLocking.Optimistic
          ? GrpcLockingMode.Optimistic
          : GrpcLockingMode.Unspecified,
  };
}

/**
 * Splits an endpoint URL into the `host:port` gRPC dials and the channel credentials its scheme
 * implies. An `https://` endpoint gets TLS; anything else is plaintext.
 */
function channelTarget(runtime: GrpcRuntime, endpoint: string): { address: string; credentials: unknown } {
  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    // A bare `host:port` is a valid gRPC target even though it is not a URL.
    return { address: endpoint, credentials: runtime.credentials.createInsecure() };
  }

  const secure = url.protocol === 'https:' || url.protocol === 'grpcs:';
  const port = url.port.length > 0 ? url.port : secure ? '443' : '80';

  return {
    address: `${url.hostname}:${port}`,
    credentials: secure ? runtime.credentials.createSsl() : runtime.credentials.createInsecure(),
  };
}

/**
 * Turns a gRPC failure on one endpoint into a `CamusError`, and reports what it says about the
 * endpoint to the pool.
 *
 * Two decisions come out of one failure, and they do not have the same answer:
 *
 * 1. The pool learns from every shape that says the node stopped answering, a connection that died
 *    under a call in flight included.
 * 2. Only the shape that says the request never left the client changes the code the caller sees.
 *    A call whose outcome is unknown keeps the generic code, so a commit is never written off.
 *
 * Exported for the tests, which pin both decisions against a real pool.
 */
export function translateGrpcFailure(
  pool: CamusEndpointPool | undefined,
  endpoint: string,
  error: GrpcStatusError,
): CamusError {
  // A domain code from the server is the server's own answer. The node is up, and the code stands.
  const domainCode = readMetadata(error, 'camus-error-code');

  if (domainCode !== undefined && domainCode.length > 0) return translateStatus(error);

  if (pool !== undefined && endpoint.length > 0 && indicatesEndpointDown(error)) {
    pool.markUnreachable(endpoint);
  }

  if (isEndpointUnreachable(error)) {
    const reason = sanitizeErrorText(error.details ?? error.message);

    return new CamusError(
      CamusErrorCode.EndpointUnreachable,
      `Endpoint ${endpoint} could not be reached: ${reason}`,
      { cause: error },
    );
  }

  const translated = translateStatus(error);

  // Name the endpoint on the generic transport code too. Neither the code nor the message carried
  // it before, so a burst of unknown-outcome failures did not say where it went.
  if (translated.code !== CamusErrorCode.Generic) return translated;

  return new CamusError(translated.code, `Endpoint ${endpoint}: ${translated.message}`, { cause: error });
}

/**
 * Turns a gRPC status into a `CamusError`.
 *
 * The server's `CADBxxxx` code rides the trailing metadata, and that is what the client layer keys
 * its retry and refresh decisions off. A rejection raised before the handler runs — the
 * authentication gate at stream open — can arrive with no trailers at all, so the domain code is
 * recovered from the status itself, and the token-refresh path still triggers.
 */
function translateStatus(error: GrpcStatusError): CamusError {
  const code = readMetadata(error, 'camus-error-code');
  const message = readMetadata(error, 'camus-error-message');

  if (code !== undefined && code.length > 0) {
    return new CamusError(code, sanitizeErrorText(message ?? ''), { cause: error });
  }

  // Sanitized for the same reason a REST body is: this text is written by the far end and is
  // logged by the caller.
  const detail = sanitizeErrorText(error.details ?? error.message);

  switch (error.code) {
    case GRPC_STATUS_UNAUTHENTICATED:
      return new CamusError(CamusErrorCode.AuthenticationFailed, detail, { cause: error });
    case GRPC_STATUS_PERMISSION_DENIED:
      return new CamusError(CamusErrorCode.InsufficientPrivilege, detail, { cause: error });
    default:
      return new CamusError(CamusErrorCode.Generic, detail, { cause: error });
  }
}

const GRPC_STATUS_UNAUTHENTICATED = 16;
const GRPC_STATUS_PERMISSION_DENIED = 7;

function readMetadata(error: GrpcStatusError, key: string): string | undefined {
  return headerValue(error.metadata, key);
}

/** The first value of one header, as a string. gRPC returns a list, and may return bytes. */
function headerValue(metadata: GrpcMetadata | undefined, key: string): string | undefined {
  const first = metadata?.get(key)[0];

  if (first === undefined) return undefined;

  return typeof first === 'string' ? first : first.toString('utf8');
}

function readExpiryMs(reply: GrpcLoginReply): number | undefined {
  const seconds = fromWire(reply.expiresInSeconds);
  if (seconds > 0n) return Number(seconds) * 1000;

  const expiresAt = fromWire(reply.expiresAtUnixMs);

  if (expiresAt > 0n) {
    const remaining = Number(expiresAt) - Date.now();
    if (remaining > 0) return remaining;
  }

  return undefined;
}
