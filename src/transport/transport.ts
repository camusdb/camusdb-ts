/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusCacheMetadata } from '../cache.js';
import type { CamusNodeStats } from '../node-stats.js';
import type { ColumnValue } from '../column-value.js';
import type { CamusProtocol } from '../config.js';
import type { CamusTransactionOptions } from '../options.js';
import type { CamusResultSet } from '../result-set.js';
import type { CamusRoutingAdvice } from '../routing/advice.js';
import type { CamusRowSource } from '../row-source.js';

/** One row of `SHOW BRANCHES` or `SHOW ANCESTORS`. */
export interface CamusBranchRow {
  readonly database?: string | undefined;
  readonly id?: string | undefined;
  readonly depth: number;
  readonly parent?: string | undefined;
  readonly forkTimestamp?: string | undefined;
}

/**
 * A SQL request handed to a transport, in terms neither protocol owns.
 *
 * It carries everything a transport needs to run one statement: the resolved endpoint, the
 * database, the SQL text, the bound parameters, and either the explicit transaction handle to join
 * or the autocommit concurrency options the server should begin this statement's own short
 * transaction with.
 */
export interface TransportSqlRequest {
  readonly endpoint: string;
  readonly database: string;
  readonly sql: string;
  readonly parameters?: ReadonlyMap<string, ColumnValue> | undefined;

  /** The explicit transaction to resume. When set, `autocommitOptions` is ignored. */
  readonly txnIdPT?: bigint | undefined;
  readonly txnIdCounter?: number | undefined;

  /**
   * Concurrency options for the short transaction the server begins for this statement. They apply
   * only when there is no explicit transaction. A read runs in a read-only snapshot with no locking
   * mode, so the query path leaves them absent, except for a write with `RETURNING` that is sent to
   * the query endpoint: that statement begins a writable transaction, as a non-query does.
   */
  readonly autocommitOptions?: CamusTransactionOptions | undefined;

  /**
   * An opaque transport routing hint. For the gRPC batching transport it is the reserved
   * `BatchExecute` stream slot a transaction's operations pin to, so the server orders them. The
   * REST transport ignores it.
   */
  readonly streamSlot?: number | undefined;

  readonly timeoutSeconds: number;

  /**
   * Run this statement as a prepared execution: the transport registers the SQL once, or reuses a
   * registration it already holds, then sends only the handle and the values in the server's
   * published binding order.
   *
   * It is a hint, not a demand. How a handle is scoped, invalidated, and replayed is the
   * transport's business, and a transport that cannot prepare this statement runs it inline
   * instead, with identical semantics.
   */
  readonly prepared: boolean;

  /**
   * The highest routing-metadata version the caller accepts on this statement's response. Zero,
   * the default, asks for none and keeps the exact pre-routing wire shape.
   */
  readonly routingAcceptVersion: number;

  /**
   * Asks the non-query endpoint for the row count only, without the rows of an `INSERT`, `UPDATE`,
   * or `DELETE` with `RETURNING`. The server still checks the `RETURNING` list and the `SELECT` privilege
   * it needs. A statement without `RETURNING` is not affected, so `execute` sets it on every
   * statement. The query endpoints refuse it, so only the non-query path sets it. When it is unset
   * or false, the request keeps the shape that a server without `RETURNING` accepts.
   */
  readonly discardReturningRows?: boolean | undefined;

  readonly signal?: AbortSignal | undefined;
}

/**
 * A row insert handed to a transport.
 *
 * The typed row-level insert names a table and a column-to-value map rather than SQL text, so it
 * cannot ride `TransportSqlRequest`. It is otherwise an ordinary statement, and goes through the
 * same transport, and therefore the same authorization, endpoint health, and error translation, as
 * everything else.
 */
export interface TransportInsertRequest {
  readonly endpoint: string;
  readonly database: string;
  readonly table: string;
  readonly values?: ReadonlyMap<string, ColumnValue> | undefined;
  readonly txnIdPT?: bigint | undefined;
  readonly txnIdCounter?: number | undefined;
  readonly streamSlot?: number | undefined;
  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * The identity the server minted for a transaction, plus the opaque stream slot its later
 * operations must pin to. The slot is absent for a transport that does not pin.
 */
export interface StartTransactionResult {
  readonly txnIdPT: bigint;
  readonly txnIdCounter: number;
  readonly streamSlot?: number | undefined;
}

/** A decoded query result, plus whatever advisory metadata the response carried. */
export interface QueryTransportResult {
  readonly resultSet: CamusResultSet;
  readonly cacheMetadata?: CamusCacheMetadata | undefined;
  readonly routing?: CamusRoutingAdvice | undefined;
}

/** The affected-row count of a write statement, plus any routing advice its response carried. */
export interface NonQueryTransportResult {
  readonly affectedRows: number;
  readonly routing?: CamusRoutingAdvice | undefined;

  /**
   * The rows of an `INSERT`, `UPDATE`, or `DELETE` with `RETURNING`, one for each written row. An
   * `INSERT` returns them in insert order. An `UPDATE` (the new row) or a `DELETE` (the deleted row)
   * returns them in no defined order. It is `undefined` for a statement without `RETURNING` and for
   * a request that set `discardReturningRows`. It has columns and no rows when the statement wrote
   * no rows.
   */
  readonly returning?: CamusResultSet | undefined;
}

/** What one pipelined statement produces: a result set, or an affected-row count. */
export type PipelineStatementKind = 'query' | 'nonQuery';

/**
 * One statement of a `TransportPipelineRequest`. It joins the pipeline's transaction, so it carries
 * no handle of its own. Everything else is what a `TransportSqlRequest` carries for a statement
 * inside a transaction.
 */
export interface TransportPipelineStatement {
  readonly kind: PipelineStatementKind;
  readonly sql: string;
  readonly parameters?: ReadonlyMap<string, ColumnValue> | undefined;

  /** See `TransportSqlRequest.prepared`. */
  readonly prepared: boolean;

  /** See `TransportSqlRequest.discardReturningRows`. */
  readonly discardReturningRows?: boolean | undefined;

  /** See `TransportSqlRequest.routingAcceptVersion`. */
  readonly routingAcceptVersion: number;
}

/**
 * Several statements of one transaction, handed to a transport together and answered together.
 *
 * The steps are: the transaction's `BEGIN` first when `start` is set, then the statements in
 * order, then a commit when `commit` is set. The commit happens only if every statement succeeded.
 * A transport that can send the whole request as one exchange does so. That is gRPC, to a server
 * that reads the pipeline contract. Any other transport runs it one exchange per step with the same
 * outcome shape, so the caller never has to know.
 */
export interface TransportPipelineRequest {
  readonly endpoint: string;
  readonly database: string;

  /**
   * The options of the transaction to begin as the first step. It is `undefined` when the
   * transaction that `txnIdPT` and `txnIdCounter` name has already begun.
   */
  readonly start?: CamusTransactionOptions | undefined;

  /** The transaction every statement joins, when it has already begun. See `start`. */
  readonly txnIdPT?: bigint | undefined;
  readonly txnIdCounter?: number | undefined;

  /** See `TransportSqlRequest.streamSlot`. */
  readonly streamSlot?: number | undefined;

  readonly statements: readonly TransportPipelineStatement[];

  /** Commit the transaction after the statements, but only if every one of them succeeded. */
  readonly commit: boolean;

  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal | undefined;
}

/** The outcome of one pipelined statement. Exactly one of the three fields is set. */
export interface PipelineStatementOutcome {
  readonly query?: QueryTransportResult | undefined;
  readonly nonQuery?: NonQueryTransportResult | undefined;
  readonly failure?: Error | undefined;
}

/**
 * What a `TransportPipelineRequest` came back with, step by step.
 *
 * A failed step is reported here and not thrown. The steps after it were still answered, by the
 * server or by the transport for it, and the caller owns one result per statement. Only a failure
 * of the whole call is thrown: a cancellation, a deadline, or a transport fault before anything was
 * sent.
 */
export interface PipelineTransportResult {
  /** The transaction the pipeline began, when `start` was set and the `BEGIN` succeeded. */
  readonly started?: StartTransactionResult | undefined;

  /** Why the `BEGIN` failed. Every statement and the commit then carry the same failure. */
  readonly startFailure?: Error | undefined;

  readonly statements: readonly PipelineStatementOutcome[];

  /** True when the pipeline asked for a commit and the transaction committed. */
  readonly committed: boolean;

  /**
   * Why the commit did not happen: the first failed step, or the commit's own failure. It is
   * `undefined` when no commit was asked for, or when the commit succeeded.
   */
  readonly commitFailure?: Error | undefined;

  /**
   * The stream messages (gRPC) or HTTP round trips this pipeline cost. It is the number that the
   * pipeline exists to lower.
   */
  readonly exchanges: number;
}

/** The first thing that went wrong in a pipeline, in step order, or `undefined`. */
export function firstPipelineFailure(result: PipelineTransportResult): Error | undefined {
  if (result.startFailure !== undefined) return result.startFailure;

  for (const outcome of result.statements) {
    if (outcome.failure !== undefined) return outcome.failure;
  }

  return result.commitFailure;
}

/** A statement the server registered: the placeholder names it declares, in binding order. */
export interface PreparedStatementInfo {
  readonly parameterNames: readonly string[];
}

/**
 * The seam between the client surface and the wire protocol.
 *
 * One implementation speaks REST and JSON, another speaks gRPC. The client layer is
 * protocol-agnostic and works entirely in CamusDB domain types whichever one is chosen.
 *
 * Every method performs exactly one round trip and turns a protocol-level failure into a
 * `CamusError` carrying the server's `CADBxxxx` code. Retry policies that do not depend on the
 * protocol — the `CADB0509` finalize loop, the transient create-database loop — stay in the client
 * layer, so each transport call is a single attempt.
 */
export interface CamusTransport {
  /** The protocol this transport implements. */
  readonly protocol: CamusProtocol;

  /** Begins an explicit transaction and reports the handle the server minted. */
  startTransaction(
    endpoint: string,
    database: string,
    options: CamusTransactionOptions,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<StartTransactionResult>;

  /**
   * Commits or rolls back the transaction the handle names. It is a single attempt: the caller
   * owns the `CADB0509` finalize-retry loop. `streamSlot` is the slot `startTransaction` reported;
   * gRPC pins the finalize to the same stream as the transaction's statements, and REST ignores it.
   */
  finalizeTransaction(
    commit: boolean,
    endpoint: string,
    database: string,
    txnIdPT: bigint,
    txnIdCounter: number,
    streamSlot: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void>;

  /** Runs a `SELECT` and reports its decoded rows plus any cache and routing metadata. */
  executeQuery(request: TransportSqlRequest): Promise<QueryTransportResult>;

  /**
   * Runs a `SELECT` and reports a source whose rows are pulled as the caller advances, so a large
   * result never fully materializes on this side.
   *
   * REST streams the NDJSON body row by row. gRPC multiplexes its data plane over shared streams
   * that decode a whole result before returning, so it buffers and replays through the same
   * interface: correct, and uniform for the caller, but not incremental.
   *
   * A serializable conflict is reported to the caller. No transport path retries an autocommit
   * statement on its own; the buffered path does not either. Rows can reach the caller before the
   * autocommit transaction commits, so a late conflict is reported while reading rather than from
   * the call.
   */
  executeQueryStream(request: TransportSqlRequest): Promise<CamusRowSource>;

  /**
   * Runs an `INSERT`, `UPDATE`, or `DELETE` and reports the affected-row count, plus the rows of a
   * `RETURNING` list unless the request set `discardReturningRows`.
   */
  executeNonQuery(request: TransportSqlRequest): Promise<NonQueryTransportResult>;

  /**
   * Runs several statements of one transaction and answers them together. The `BEGIN` can come
   * first and a commit can come last.
   *
   * A transport that can send the request as one exchange does so. Any other runs it one exchange
   * per step, with `runSequentialPipeline`. A failed step is reported in the result and not thrown,
   * because every step gets an outcome. Only a failure of the whole call is thrown. By design, this
   * is not "exactly one round trip" like the other methods: the result reports the exchange count.
   */
  executePipeline(request: TransportPipelineRequest): Promise<PipelineTransportResult>;

  /**
   * Inserts one row through the server's typed row-level surface — the same operation `INSERT INTO`
   * performs, written as a table plus a column-to-value map instead of SQL text.
   */
  insert(request: TransportInsertRequest): Promise<number>;

  /** Runs a DDL statement. */
  executeDdl(request: TransportSqlRequest): Promise<boolean>;

  /**
   * Registers SQL as a prepared statement and reports the placeholder names in binding order, or
   * reuses a registration this transport already holds for it.
   *
   * A caller receives no handle. A handle's lifetime is a property of the transport that minted it
   * — a gRPC handle dies with its stream, a REST handle with an idle timeout or a node restart —
   * so it stays inside, where it can be checked and renewed. What a caller gets is the statement's
   * binding order, and the knowledge that later prepared executions will be cheap.
   *
   * It is idempotent per endpoint, database, and SQL; concurrent first calls share one
   * registration.
   */
  prepare(
    endpoint: string,
    database: string,
    sql: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<PreparedStatementInfo>;

  /**
   * Releases this transport's registrations for a statement, both locally and on the server.
   *
   * It is best-effort by contract. A handle whose stream, node, or idle window is already gone was
   * freed by the server anyway, so a failure here means the work was already done. Skipping it
   * entirely is safe for the same reason: it exists so a long-lived client that cycles through
   * many distinct statements stays under the server's caps instead of meeting them.
   */
  closePrepared(endpoint: string, database: string, sql: string, signal?: AbortSignal): Promise<void>;

  /** A liveness check. Reports true when the server answers. */
  ping(endpoint: string, timeoutSeconds: number, signal?: AbortSignal): Promise<boolean>;

  /** The disk, CPU, and memory of the node at `endpoint`. */
  getNodeStats(endpoint: string, timeoutSeconds: number, signal?: AbortSignal): Promise<CamusNodeStats>;

  /** Creates a database. It is a single attempt: the caller owns the transient-retry loop. */
  createDatabase(
    endpoint: string,
    database: string,
    ifNotExists: boolean,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void>;

  /** Creates a copy-on-write branch database. A single attempt, like `createDatabase`. */
  createBranchDatabase(
    endpoint: string,
    branchName: string,
    sourceDatabaseName: string,
    ifNotExists: boolean,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void>;

  /** Drops a database. */
  dropDatabase(
    endpoint: string,
    database: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void>;

  /** Every transitive descendant of a database. */
  showBranches(
    endpoint: string,
    database: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CamusBranchRow[]>;

  /** The full ancestry chain of a database. */
  showAncestors(
    endpoint: string,
    database: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CamusBranchRow[]>;

  /** Releases every connection, stream, and channel this transport holds. */
  close(): Promise<void>;
}

/** True when a transaction handle is present on a request. */
export function hasTransaction(
  request: Pick<TransportSqlRequest, 'txnIdPT' | 'txnIdCounter'>,
): request is typeof request & { txnIdPT: bigint; txnIdCounter: number } {
  return request.txnIdPT !== undefined && request.txnIdCounter !== undefined;
}
