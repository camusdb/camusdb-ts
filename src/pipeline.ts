/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { ExecuteResult, QueryResult } from './client.js';
import type { ColumnValue } from './column-value.js';
import { CamusError } from './errors.js';
import { CamusErrorCode } from './error-codes.js';
import { shouldPrepare } from './prepared/auto-prepare.js';
import { CamusResultSet, RowMapper } from './result-set.js';
import { ROUTING_ACCEPT_VERSION } from './routing/advice.js';
import { CamusRouteOpKind } from './routing/route-cache.js';
import type { ClientRuntime } from './runtime.js';
import { callStatement, isDdlStatement, isDmlStatement, runsInOwnTransaction } from './statements.js';
import type { CamusOperation } from './telemetry.js';
import { traced } from './telemetry.js';
import type { CamusTransaction, StartClaim } from './transaction.js';
import type {
  PipelineStatementKind,
  PipelineStatementOutcome,
  TransportPipelineStatement,
} from './transport/transport.js';
import { firstPipelineFailure } from './transport/transport.js';
import type { Int64Mode } from './values/decode.js';
import type { Parameters } from './values/encode.js';
import { encodeParameters } from './values/encode.js';

/** What one queued read may override for itself. */
export interface PipelineQueryOptions {
  /** How an `int64` column reaches the caller, for this statement alone. */
  readonly int64?: Int64Mode | undefined;
}

/**
 * Several statements of one `CamusTransaction`, sent together as one exchange and answered
 * together.
 *
 * A transaction that awaits each statement pays one round trip per statement: six for a bank
 * transfer (`BEGIN`, two reads, two writes, `COMMIT`). At high concurrency those round trips, and
 * not the statements, set its latency. A pipeline queues the statements whose inputs are known,
 * sends them as one stream message, and settles each statement's promise from its own answer.
 *
 * ```ts
 * const txn = await client.beginTransaction({ deferBegin: true });
 * const pipeline = txn.pipeline();
 *
 * // Exchange 1: [BEGIN, SELECT a, SELECT b]
 * const readA = pipeline.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = @id', { id: a });
 * const readB = pipeline.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = @id', { id: b });
 * await pipeline.send();
 *
 * const from = (await readA).rows[0]!.balance;
 * const to = (await readB).rows[0]!.balance;
 *
 * // Exchange 2: [UPDATE a, UPDATE b, COMMIT]. The commit happens only if both updates succeed.
 * pipeline.execute('UPDATE accounts SET balance = @v WHERE id = @id', { v: from - amount, id: a });
 * pipeline.execute('UPDATE accounts SET balance = @v WHERE id = @id', { v: to + amount, id: b });
 * await pipeline.commit();
 * ```
 *
 * **Shape.** Queue with `query` and `execute`. Each returns the promise for that statement's result.
 * Then call `send` to run what is queued, or `commit` to run it and commit the transaction in the
 * same exchange. That commit happens only when every statement of the transaction succeeded. A
 * transaction begun with `deferBegin`, or with learned routing on, sends its `BEGIN` inside the
 * first exchange too.
 *
 * **Failure.** Every queued promise settles with its own result or its own `CamusError`, as a lone
 * statement does. The statements after a failed one in the same exchange still get an answer. The
 * transaction has ended, so they fail too. The send itself rejects with the first failure, so a
 * caller that awaits only the send still learns of it. A queued promise that nobody awaits is never
 * reported as an unhandled rejection. After a failed `commit`, the server has rolled the
 * transaction back, and `rollback` is a harmless call. To retry, run the whole transaction again
 * from `BEGIN`.
 *
 * **Order and reuse.** The queued statements run in queue order, after every statement of the
 * transaction sent before them. So a pipeline can be sent more than once on one transaction, and an
 * ordinary statement can run between two sends. One send at a time per pipeline. `exchanges`
 * reports the round trips used. It is one per send over gRPC to a server that reads the pipeline
 * contract. Over REST, with `requestFrames` off, or against an older server, it is one per
 * statement, with the same results.
 */
export class CamusPipeline {
  private readonly transactionValue: CamusTransaction;

  private readonly runtime: ClientRuntime;

  private readonly queued: QueuedStatement[] = [];

  private exchangesValue = 0;

  private sending = false;

  /** @internal Use `CamusTransaction.pipeline`. */
  constructor(transaction: CamusTransaction, runtime: ClientRuntime) {
    this.transactionValue = transaction;
    this.runtime = runtime;
  }

  /** The transaction that every queued statement runs in. */
  get transaction(): CamusTransaction {
    return this.transactionValue;
  }

  /** How many statements are queued and not sent yet. */
  get size(): number {
    return this.queued.length;
  }

  /**
   * The round trips this pipeline has cost so far. A send that travelled as one stream message
   * costs one. A send that did not costs one for each step: the `BEGIN`, each statement, and the
   * commit.
   */
  get exchanges(): number {
    return this.exchangesValue;
  }

  /**
   * Queues a statement that returns rows, and reports the promise for them. That is a `SELECT`, or
   * an `INSERT`, `UPDATE`, or `DELETE` with a `RETURNING` list. A write reports its written-row
   * count in `affectedRows`. A `CALL` is also accepted: it has no rows, and it reports in
   * `affectedRows` the number of rows that the procedure's SQL changed. The promise settles when the pipeline is sent and the statement is
   * answered.
   *
   * @throws {CamusError} at once, for a statement that cannot run inside the transaction (DDL and
   * `TRUNCATE`), and while a send is in progress.
   */
  query<T = Record<string, unknown>>(
    sql: string,
    parameters?: Parameters,
    options: PipelineQueryOptions = {},
  ): Promise<QueryResult<T>> {
    const statement = this.add(sql, parameters, true, options.int64);

    return statement.promise as Promise<QueryResult<T>>;
  }

  /**
   * Queues a write, and reports the promise for its affected-row count. For a write with
   * `RETURNING`, the server sends the count only. The promise settles when the pipeline is sent
   * and the statement is answered.
   *
   * @throws {CamusError} at once, for a statement that cannot run inside the transaction (DDL and
   * `TRUNCATE`), and while a send is in progress.
   */
  execute(sql: string, parameters?: Parameters): Promise<ExecuteResult> {
    const statement = this.add(sql, parameters, false, undefined);

    return statement.promise as Promise<ExecuteResult>;
  }

  /**
   * Queues `CALL procedure(@a, @b, ...)` for a procedure that a C# extension on the server defines,
   * and reports the promise for the number of rows that the procedure's SQL changed. The arguments
   * follow the order of the parameter object's keys, as in `CamusClient.call`.
   *
   * @throws {TypeError} at once, when `procedure` is not a plain identifier.
   * @throws {CamusError} at once, while a send is in progress.
   */
  call(procedure: string, parameters?: Parameters): Promise<ExecuteResult> {
    return this.execute(callStatement(procedure, parameters), parameters);
  }

  /**
   * Sends the queued statements as one exchange, and waits for every answer. It rejects with the
   * first failure, if any. Each statement's own promise carries its own outcome.
   */
  send(signal?: AbortSignal): Promise<void> {
    return this.flush(false, signal);
  }

  /**
   * Sends the queued statements and the transaction's commit as one exchange.
   *
   * The commit happens only when every statement of the transaction succeeded, in this send and
   * before it. If not, the server rolls the transaction back, and this rejects with the first
   * failure. After a success the transaction is committed, and `CamusTransaction.commit` must not
   * be called again.
   */
  commit(signal?: AbortSignal): Promise<void> {
    return this.flush(true, signal);
  }

  private add(
    sql: string,
    parameters: Parameters | undefined,
    asReader: boolean,
    int64: Int64Mode | undefined,
  ): QueuedStatement {
    if (this.sending) {
      throw new CamusError(
        CamusErrorCode.Generic,
        'A send is in progress on this pipeline. Queue the statement after it completes.',
      );
    }

    if (runsInOwnTransaction(sql)) {
      throw new CamusError(
        CamusErrorCode.StatementNotAllowedInTransaction,
        'This statement runs in its own transaction and cannot be pipelined.',
      );
    }

    if (isDdlStatement(sql)) {
      throw new CamusError(
        CamusErrorCode.Generic,
        'A DDL statement cannot be pipelined, because it does not run inside the transaction.',
      );
    }

    const dml = isDmlStatement(sql);

    const statement = new QueuedStatement(
      sql,
      encodeParameters(parameters),
      asReader,
      asReader && !dml ? 'query' : 'nonQuery',
      asReader && !dml ? CamusRouteOpKind.Query : CamusRouteOpKind.NonQuery,
      int64 ?? this.runtime.config.decode.int64,
    );

    this.queued.push(statement);

    return statement;
  }

  private async flush(commit: boolean, signal: AbortSignal | undefined): Promise<void> {
    if (this.sending) {
      throw new CamusError(CamusErrorCode.Generic, 'A send is already in progress on this pipeline.');
    }

    if (this.queued.length === 0 && !commit) return;

    const batch = this.queued.splice(0);

    this.sending = true;

    try {
      // One span for the exchange. Its statements get no spans of their own: they travel together,
      // and the server answers them together.
      await traced(this.runtime, { operationName: 'BATCH', batchSize: batch.length }, (operation) => {
        operation?.setAttribute('camusdb.pipeline.commit', commit);

        return this.exchange(batch, commit, signal, operation);
      });
    } finally {
      this.sending = false;
    }
  }

  private async exchange(
    batch: QueuedStatement[],
    commit: boolean,
    signal: AbortSignal | undefined,
    operation: CamusOperation | undefined,
  ): Promise<void> {
    const transaction = this.transactionValue;
    const runtime = this.runtime;

    let claim: StartClaim | undefined;

    try {
      if (transaction.isFinalized) {
        throw new CamusError(
          CamusErrorCode.Generic,
          'This transaction was already committed or rolled back.',
        );
      }

      // The `BEGIN` rides this exchange when nothing has begun the transaction yet. When a
      // statement is beginning it at this moment, wait for that instead: one `BEGIN` per
      // transaction.
      if (!transaction.isStarted) {
        const start = transaction.claimStart();

        claim = start.claim;

        if (start.pending !== undefined) await start.pending;
      }

      const endpoint = transaction.endpoint ?? this.chooseEndpoint(batch);
      const database = runtime.database;

      operation?.setEndpoint(endpoint);
      const router = runtime.router;

      // Each statement's route entry is read before the exchange, pinned or not, for the reason a
      // lone statement reads it: the reply's advice refreshes the route only if the entry has not
      // moved since, so a late reply never overwrites what a faster one learned.
      const observed: number[] = [];
      const statements: TransportPipelineStatement[] = [];

      for (const statement of batch) {
        statements.push({
          kind: statement.kind,
          sql: statement.sql,
          parameters: statement.parameters,
          prepared: await shouldPrepare(runtime, statement.sql, endpoint, { signal }),
          routingAcceptVersion: router !== undefined ? ROUTING_ACCEPT_VERSION : 0,
          ...(statement.kind === 'nonQuery' && !statement.asReader ? { discardReturningRows: true } : {}),
        });

        observed.push(router?.selectEndpoint(database, statement.sql, statement.routeKind).revision ?? 0);
      }

      const result = await runtime.transport.executePipeline({
        endpoint,
        database,
        start: claim !== undefined ? transaction.options : undefined,
        ...(claim === undefined
          ? {
              txnIdPT: transaction.txnIdPT,
              txnIdCounter: transaction.txnIdCounter,
              streamSlot: transaction.streamSlot,
            }
          : {}),
        statements,
        commit,
        timeoutSeconds: runtime.timeoutSeconds,
        signal,
      });

      this.exchangesValue += result.exchanges;

      if (claim !== undefined) {
        if (result.started !== undefined) {
          claim.resolve(result.started, endpoint);
        } else {
          claim.reject(
            result.startFailure ?? new CamusError(CamusErrorCode.Generic, 'The transaction did not begin.'),
          );
        }

        claim = undefined;
      }

      batch.forEach((statement, i) => {
        const outcome = result.statements[i] ?? {};

        statement.settle(outcome);

        // A pipelined statement teaches the router what a lone one would. Without this, the first
        // exchange of every deferred transaction starts on the pool's rotation, most of them on a
        // follower, and every statement of the transaction is forwarded from there.
        const advice = outcome.query?.routing ?? outcome.nonQuery?.routing;

        if (advice !== undefined) {
          router?.learn(database, statement.sql, statement.routeKind, advice, observed[i]!);
        }
      });

      if (commit && result.committed) transaction.markCommittedByPipeline();

      const first = firstPipelineFailure(result);

      if (first !== undefined) throw first;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));

      // A failure before the exchange, or of the exchange itself: nothing was settled. So settle it
      // all with the one failure, the claim included, so that no caller waits forever.
      claim?.reject(failure);

      for (const statement of batch) statement.fail(failure);

      throw error;
    }
  }

  /**
   * Where a transaction that has not begun yet begins: the first statement's learned route when
   * the client routes, and the pool's rotation if not. That is the choice a lone first statement
   * makes.
   */
  private chooseEndpoint(batch: readonly QueuedStatement[]): string {
    const router = this.runtime.router;
    const first = batch[0];

    if (router !== undefined && first !== undefined) {
      const learned = router.selectEndpoint(this.runtime.database, first.sql, first.routeKind);

      if (learned.endpoint !== undefined) return learned.endpoint;
    }

    return this.runtime.nextEndpoint();
  }
}

/** One queued statement, and the promise its caller holds. */
class QueuedStatement {
  readonly promise: Promise<QueryResult<unknown> | ExecuteResult>;

  private resolve!: (value: QueryResult<unknown> | ExecuteResult) => void;

  private reject!: (error: Error) => void;

  private settled = false;

  constructor(
    readonly sql: string,
    readonly parameters: ReadonlyMap<string, ColumnValue> | undefined,
    readonly asReader: boolean,
    readonly kind: PipelineStatementKind,
    readonly routeKind: CamusRouteOpKind,
    private readonly int64: Int64Mode,
  ) {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });

    // A caller that awaits only the send, which rejects with the same failure, must not be charged
    // with an unhandled rejection. A caller that awaits this promise still sees the failure.
    this.promise.catch(() => undefined);
  }

  settle(outcome: PipelineStatementOutcome): void {
    if (outcome.failure !== undefined) {
      this.fail(outcome.failure);
      return;
    }

    if (this.asReader) {
      if (outcome.query !== undefined) {
        const { resultSet, cacheMetadata, routing } = outcome.query;

        this.succeed({
          ...this.mapRows(resultSet),
          cacheMetadata,
          routingAdvice: routing,
        });
        return;
      }

      if (outcome.nonQuery !== undefined) {
        const { returning, affectedRows, routing } = outcome.nonQuery;

        this.succeed({
          ...this.mapRows(returning ?? CamusResultSet.EMPTY),
          affectedRows,
          routingAdvice: routing,
        });
        return;
      }
    } else {
      if (outcome.nonQuery !== undefined) {
        this.succeed({
          affectedRows: outcome.nonQuery.affectedRows,
          routingAdvice: outcome.nonQuery.routing,
        });
        return;
      }

      if (outcome.query !== undefined) {
        this.succeed({
          affectedRows: outcome.query.resultSet.rowCount,
          routingAdvice: outcome.query.routing,
        });
        return;
      }
    }

    this.fail(new CamusError(CamusErrorCode.Generic, 'The statement was not answered.'));
  }

  fail(error: Error): void {
    if (this.settled) return;

    this.settled = true;
    this.reject(error);
  }

  private succeed(value: QueryResult<unknown> | ExecuteResult): void {
    if (this.settled) return;

    this.settled = true;
    this.resolve(value);
  }

  private mapRows(resultSet: CamusResultSet): Pick<QueryResult<unknown>, 'rows' | 'columns' | 'rowCount'> {
    const mapper = new RowMapper(resultSet.columnNames, { int64: this.int64 });

    return { rows: mapper.mapAll(resultSet), columns: resultSet.columns, rowCount: resultSet.rowCount };
  }
}
