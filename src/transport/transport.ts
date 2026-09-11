/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusCacheMetadata } from '../cache.js';
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
   * only when there is no explicit transaction, and are absent on the read-query path, which has
   * no locking mode.
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
   * The streaming path gives up the buffered path's transparent retry of a serializable conflict.
   * Rows can reach the caller before the autocommit transaction commits, so a late conflict is
   * reported while reading rather than retried.
   */
  executeQueryStream(request: TransportSqlRequest): Promise<CamusRowSource>;

  /** Runs an `INSERT`, `UPDATE`, or `DELETE` and reports the affected-row count. */
  executeNonQuery(request: TransportSqlRequest): Promise<NonQueryTransportResult>;

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
