/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusBackupClient } from './backup.js';
import { evictAllCacheStatement, evictCacheStatement } from './cache.js';
import type { CamusCacheMetadata } from './cache.js';
import { rewriteStorageStatement } from './column-storage.js';
import type { ColumnValue } from './column-value.js';
import type { CamusClientOptions, CamusProtocol, ResolvedConfig } from './config.js';
import { describeConfig, resolveConnectionString, resolveOptions } from './config.js';
import { CamusError } from './errors.js';
import { CamusErrorCode } from './error-codes.js';
import type { CamusTransactionOptions } from './options.js';
import { withDefaults } from './options.js';
import { PrepareDecision } from './prepared/policy.js';
import type { EvictedStatement } from './prepared/policy.js';
import { CamusQueryStream } from './query-stream.js';
import type { CamusColumn } from './result-set.js';
import { RowMapper } from './result-set.js';
import { delay, isRetryable, withRetry } from './retry.js';
import type { RetryOptions } from './retry.js';
import { ClientRuntime } from './runtime.js';
import type { CamusRoutingAdvice } from './routing/advice.js';
import { ROUTING_ACCEPT_VERSION } from './routing/advice.js';
import { CamusRouteOpKind } from './routing/route-cache.js';
import type { CamusStatementRouter } from './routing/router.js';
import { isDdlStatement, isPreparableStatement, runsInOwnTransaction } from './statements.js';
import { CamusTransaction } from './transaction.js';
import type { CamusBranchRow, TransportSqlRequest } from './transport/transport.js';
import type { Int64Mode } from './values/decode.js';
import type { Parameters } from './values/encode.js';
import { encodeParameters } from './values/encode.js';

/** What one statement may override for itself. */
export interface StatementOptions {
  /** The transaction to run inside. Without one the statement runs in its own short transaction. */
  readonly transaction?: CamusTransaction | undefined;

  /** Ends the statement early. */
  readonly signal?: AbortSignal | undefined;

  /** A deadline for this statement alone, in seconds. */
  readonly timeoutSeconds?: number | undefined;

  /** How an `int64` column reaches the caller, for this statement alone. */
  readonly int64?: Int64Mode | undefined;
}

/** Options for a statement that begins its own short transaction. */
export interface AutocommitStatementOptions extends StatementOptions {
  /** Concurrency knobs for the short transaction the server begins for this statement. */
  readonly transactionOptions?: CamusTransactionOptions | undefined;
}

/** The rows of one query, and what the server reported about running it. */
export interface QueryResult<T> {
  /** The rows, as plain objects keyed by column name. */
  readonly rows: T[];

  /** The output columns, in order. Present even when there are no rows. */
  readonly columns: CamusColumn[];

  readonly rowCount: number;

  /** How a cache-hinted `SELECT` resolved, or `undefined` when the statement carried no hint. */
  readonly cacheMetadata?: CamusCacheMetadata | undefined;

  /**
   * The routing advice the response carried. It arrives only on a client with routing on, and only
   * for a statement the server judged eligible. It is diagnostic: the driver has already applied it.
   */
  readonly routingAdvice?: CamusRoutingAdvice | undefined;
}

/** What a write statement did. */
export interface ExecuteResult {
  readonly affectedRows: number;

  /** See `QueryResult.routingAdvice`. */
  readonly routingAdvice?: CamusRoutingAdvice | undefined;
}

/** How `client.transaction` runs and retries a unit of work. */
export interface TransactionRunOptions {
  /** How many times the work runs in total, the first attempt included. Default 5. */
  readonly maxAttempts?: number | undefined;

  /** Concurrency knobs for the transaction. */
  readonly transactionOptions?: CamusTransactionOptions | undefined;

  /** Ends the work early. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * A connection to one CamusDB database.
 *
 * A client is cheap to create and safe to share. It holds no socket of its own: the endpoint
 * rotation, the bearer token, the wire transport, and the learned routes are shared process-wide
 * by what they actually depend on, so building a client per request costs almost nothing and still
 * reuses the connections, the token, and the prepared statements a long-lived one would.
 *
 * ```ts
 * const client = CamusClient.fromConnectionString('Endpoint=http://localhost:8082;Database=test');
 *
 * const { rows } = await client.query<Robot>('SELECT * FROM robots WHERE year = @year', { year: 1974 });
 * ```
 *
 * Every method that reaches the server accepts an `AbortSignal` and a per-statement timeout.
 */
export class CamusClient implements AsyncDisposable {
  private readonly runtime: ClientRuntime;

  private backupClient: CamusBackupClient | undefined;

  /**
   * Builds a client from an options object, or from a connection string.
   *
   * ```ts
   * new CamusClient({ endpoint: 'http://localhost:8082', database: 'test' });
   * new CamusClient('Endpoint=http://localhost:8082;Database=test');
   * ```
   */
  constructor(options: CamusClientOptions | string) {
    this.runtime = new ClientRuntime(
      typeof options === 'string' ? resolveConnectionString(options) : resolveOptions(options),
    );
  }

  /**
   * Builds a client from a `key=value;key=value` connection string.
   *
   * ```ts
   * CamusClient.fromConnectionString('Endpoint=http://localhost:8082;Database=test;User=app;Password=secret');
   * ```
   *
   * Keys are matched without regard to case. Wrap a value in quotes to keep a semicolon or
   * surrounding spaces in it, and double the quote character to include one.
   */
  static fromConnectionString(connectionString: string): CamusClient {
    return new CamusClient(connectionString);
  }

  /** @internal The resolved configuration, for tests and diagnostics. */
  get config(): ResolvedConfig {
    return this.runtime.config;
  }

  /** The database statements run against. */
  get database(): string {
    return this.runtime.database;
  }

  /** The wire protocol this client speaks. */
  get protocol(): CamusProtocol {
    return this.runtime.transport.protocol;
  }

  /** The bearer token currently held, or `undefined`. Reading it never triggers a login. */
  get accessToken(): string | undefined {
    return this.runtime.auth.currentToken;
  }

  /**
   * The node's online backup administration API.
   *
   * It is server-level and node-wide, not scoped to this client's database, and it needs a
   * superuser token when authentication is on.
   */
  get backups(): CamusBackupClient {
    this.backupClient ??= new CamusBackupClient(this.runtime);
    return this.backupClient;
  }

  /** How many statements this client currently keeps prepared on the server. */
  get preparedStatementCount(): number {
    return this.runtime.preparedStatements.preparedCount;
  }

  /** How many destinations learned routing currently holds. Zero when routing is off. */
  get learnedRouteCount(): number {
    return this.runtime.router?.learnedRouteCount ?? 0;
  }

  /** Points this client at another database. It sends nothing. */
  changeDatabase(database: string): void {
    if (database.trim().length === 0) {
      throw new CamusError(CamusErrorCode.Generic, 'A database name cannot be empty.');
    }

    this.runtime.database = database;
  }

  /** The configuration as text, with every secret masked. Safe to log. */
  toString(): string {
    return `CamusClient(${describeConfig(this.runtime.config)})`;
  }

  // ─── Statements ───────────────────────────────────────────────────────────

  /**
   * Runs a `SELECT` and reads every row.
   *
   * ```ts
   * const { rows } = await client.query<Robot>(
   *   'SELECT id, name, year FROM robots WHERE year > @year',
   *   { year: 1970 },
   * );
   * ```
   *
   * Give a type argument to describe the row shape. It is not checked against the server's schema —
   * nothing on this side can check that — so it states what you expect, and the driver maps each
   * column to the JavaScript value its declared type calls for.
   *
   * Use `queryStream` when the result may be large: this method holds every row in memory.
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    parameters?: Parameters,
    options: StatementOptions = {},
  ): Promise<QueryResult<T>> {
    const encoded = encodeParameters(parameters);
    const transaction = options.transaction;

    const route = await this.route(sql, CamusRouteOpKind.Query, transaction, options.signal);

    const request = await this.buildRequest(sql, encoded, route, transaction, options, {
      negotiateRouting: route.router !== undefined,
    });

    const result = await this.runtime.transport.executeQuery(request);

    route.router?.learn(request.database, sql, CamusRouteOpKind.Query, result.routing, route.revision);

    const mapper = new RowMapper(result.resultSet.columnNames, this.decodeOptions(options));

    return {
      rows: mapper.mapAll<T>(result.resultSet),
      columns: result.resultSet.columns,
      rowCount: result.resultSet.rowCount,
      cacheMetadata: result.cacheMetadata,
      routingAdvice: result.routing,
    };
  }

  /** Runs a `SELECT` and reads its first row, or `undefined` when it returned none. */
  async queryOne<T = Record<string, unknown>>(
    sql: string,
    parameters?: Parameters,
    options: StatementOptions = {},
  ): Promise<T | undefined> {
    const result = await this.query<T>(sql, parameters, options);
    return result.rows[0];
  }

  /**
   * Runs a `SELECT` and reads the first column of its first row, or `undefined`.
   *
   * ```ts
   * const total = await client.scalar<number>('SELECT COUNT(*) FROM robots');
   * ```
   */
  async scalar<T = unknown>(
    sql: string,
    parameters?: Parameters,
    options: StatementOptions = {},
  ): Promise<T | undefined> {
    const result = await this.query(sql, parameters, options);

    const row = result.rows[0];
    const firstColumn = result.columns[0];

    if (row === undefined || firstColumn === undefined) return undefined;

    return row[firstColumn.name] as T | undefined;
  }

  /**
   * Runs a `SELECT` and reports its rows one at a time, so a large result never fully materializes
   * on this side.
   *
   * ```ts
   * await using stream = await client.queryStream<Robot>('SELECT * FROM robots');
   *
   * for await (const robot of stream) {
   *   process(robot);
   * }
   * ```
   *
   * It is genuinely incremental over REST. Over gRPC the data plane multiplexes results over
   * shared streams that decode a whole result before returning, so this buffers and replays: the
   * caller's code is the same, but the memory saving is not there.
   *
   * The streaming path gives up the transparent retry of a serializable conflict that `query` has;
   * see `CamusQueryStream`.
   */
  async queryStream<T = Record<string, unknown>>(
    sql: string,
    parameters?: Parameters,
    options: StatementOptions = {},
  ): Promise<CamusQueryStream<T>> {
    const encoded = encodeParameters(parameters);
    const transaction = options.transaction;

    // A learned route still steers the send, which costs nothing, but the streaming endpoint's
    // trailer carries no routing metadata, so nothing is negotiated or learned.
    const route = await this.route(sql, CamusRouteOpKind.Query, transaction, options.signal);

    const request = await this.buildRequest(sql, encoded, route, transaction, options, {
      negotiateRouting: false,
    });

    const source = await this.runtime.transport.executeQueryStream(request);

    return new CamusQueryStream<T>(source, this.decodeOptions(options));
  }

  /**
   * Runs an `INSERT`, `UPDATE`, or `DELETE` and reports how many rows it changed.
   *
   * ```ts
   * const { affectedRows } = await client.execute(
   *   'UPDATE robots SET year = @year WHERE id = @id',
   *   { year: 1984, id: robotId },
   * );
   * ```
   *
   * A DDL statement is accepted here too and is sent to the DDL route, where it reports zero rows.
   */
  async execute(
    sql: string,
    parameters?: Parameters,
    options: AutocommitStatementOptions = {},
  ): Promise<ExecuteResult> {
    if (isDdlStatement(sql)) {
      await this.executeDdl(sql, options);
      return { affectedRows: 0 };
    }

    return this.executeNonQuery(sql, parameters, options);
  }

  /**
   * Runs a schema statement: `CREATE TABLE`, `ALTER TABLE`, `DROP INDEX`, a view definition, and
   * so on.
   *
   * `TRUNCATE` is refused inside an explicit transaction. It commits a replicated schema entry that
   * a rollback cannot undo, so the server refuses it rather than promise a rollback it cannot
   * deliver, and the driver refuses it before the round trip.
   */
  async executeDdl(sql: string, options: AutocommitStatementOptions = {}): Promise<boolean> {
    const transaction = options.transaction;

    if (transaction !== undefined && runsInOwnTransaction(sql)) {
      throw new CamusError(
        CamusErrorCode.StatementNotAllowedInTransaction,
        'TRUNCATE runs in its own internal transaction and is refused inside an explicit one. It ' +
          'commits a replicated schema entry that a rollback cannot undo. Commit or roll back this ' +
          'transaction first, then run TRUNCATE.',
      );
    }

    const endpoint =
      transaction !== undefined
        ? await transaction.ensureStarted(undefined, options.signal)
        : this.runtime.nextEndpoint();

    return this.runtime.transport.executeDdl({
      endpoint,
      database: this.runtime.database,
      sql,
      timeoutSeconds: options.timeoutSeconds ?? this.runtime.timeoutSeconds,
      prepared: false,
      routingAcceptVersion: 0,
      ...(transaction === undefined
        ? { autocommitOptions: this.resolveTransactionOptions(options.transactionOptions) }
        : {
            txnIdPT: transaction.txnIdPT,
            txnIdCounter: transaction.txnIdCounter,
            streamSlot: transaction.streamSlot,
          }),
      signal: options.signal,
    });
  }

  /**
   * Inserts one row through the server's typed row-level route, naming a table and a column-to-value
   * map instead of composing SQL.
   *
   * ```ts
   * await client.insert('robots', { id: CamusObjectId.generateAsString(), name: 'r1', year: 1974 });
   * ```
   *
   * It performs exactly what `INSERT INTO` performs, and takes the same authorization, endpoint
   * health, and error translation. Use it to avoid building statement text for a hot write path.
   */
  async insert(table: string, values: Parameters, options: StatementOptions = {}): Promise<number> {
    const transaction = options.transaction;

    const endpoint =
      transaction !== undefined
        ? await transaction.ensureStarted(undefined, options.signal)
        : this.runtime.nextEndpoint();

    return this.runtime.transport.insert({
      endpoint,
      database: this.runtime.database,
      table,
      values: encodeUnprefixed(values),
      timeoutSeconds: options.timeoutSeconds ?? this.runtime.timeoutSeconds,
      ...(transaction === undefined
        ? {}
        : {
            txnIdPT: transaction.txnIdPT,
            txnIdCounter: transaction.txnIdCounter,
            streamSlot: transaction.streamSlot,
          }),
      signal: options.signal,
    });
  }

  /** Reports whether the server answers. */
  ping(options: { signal?: AbortSignal; timeoutSeconds?: number } = {}): Promise<boolean> {
    return this.runtime.transport.ping(
      this.runtime.nextEndpoint(),
      options.timeoutSeconds ?? this.runtime.timeoutSeconds,
      options.signal,
    );
  }

  // ─── Transactions ─────────────────────────────────────────────────────────

  /**
   * Begins an explicit transaction.
   *
   * Prefer `transaction`, which commits, rolls back, and retries for you. Use this when the unit of
   * work does not fit inside one function — a saga driven by external events, say.
   *
   * ```ts
   * await using txn = await client.beginTransaction();
   *
   * await client.execute('UPDATE accounts SET balance = balance - 10 WHERE id = @id', { id: from }, { transaction: txn });
   * await client.execute('UPDATE accounts SET balance = balance + 10 WHERE id = @id', { id: to }, { transaction: txn });
   *
   * await txn.commit();
   * ```
   *
   * With `await using`, a transaction that is left without a commit is rolled back as the block
   * unwinds.
   */
  async beginTransaction(
    options: CamusTransactionOptions = {},
    signal?: AbortSignal,
  ): Promise<CamusTransaction> {
    const effective = this.resolveTransactionOptions(options);
    const router = this.runtime.router;

    if (router === undefined) {
      // Routing off: begin here, on the rotation, right now.
      const endpoint = this.runtime.nextEndpoint();

      const result = await this.runtime.transport.startTransaction(
        endpoint,
        this.runtime.database,
        effective,
        this.runtime.timeoutSeconds,
        signal,
      );

      return new CamusTransaction(this.runtime, effective, {
        txnIdPT: result.txnIdPT,
        txnIdCounter: result.txnIdCounter,
        endpoint,
        streamSlot: result.streamSlot,
      });
    }

    const deferred = new CamusTransaction(this.runtime, effective);

    // An explicit affinity begins the transaction here, on the named statement's learned endpoint,
    // falling back to rotation when nothing is learned. Without one, the first statement chooses.
    if (effective.affinity !== undefined) {
      const learned = router.selectEndpoint(
        this.runtime.database,
        effective.affinity,
        CamusRouteOpKind.Query,
      );

      await deferred.ensureStarted(learned.endpoint, signal);
    }

    return deferred;
  }

  /**
   * Runs a unit of work inside a transaction, committing it when the work returns and rolling it
   * back when the work throws.
   *
   * ```ts
   * await client.transaction(async (txn) => {
   *   await client.execute('UPDATE accounts SET balance = balance - @amount WHERE id = @id',
   *     { amount, id: from }, { transaction: txn });
   *   await client.execute('UPDATE accounts SET balance = balance + @amount WHERE id = @id',
   *     { amount, id: to }, { transaction: txn });
   * });
   * ```
   *
   * A serializable conflict is retried: the whole function runs again on a fresh transaction, with
   * an exponential back-off. So the function must be safe to run more than once — it must not send
   * an email, charge a card, or mutate state outside the database on a path that could repeat.
   *
   * A commit that reports an unresolved outcome is **not** retried this way. That case is resolved
   * inside `CamusTransaction`, by re-issuing the same commit on the same handle, because replaying
   * the work could apply an already-durable commit twice.
   */
  async transaction<T>(
    work: (transaction: CamusTransaction) => Promise<T>,
    options: TransactionRunOptions = {},
  ): Promise<T> {
    const retryOptions: RetryOptions = {
      maxAttempts: options.maxAttempts ?? 5,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };

    return withRetry(async () => {
      const transaction = await this.beginTransaction(options.transactionOptions ?? {}, options.signal);

      let result: T;

      try {
        result = await work(transaction);
      } catch (error) {
        await rollbackQuietly(transaction);
        throw error;
      }

      // A commit that lost a conflict leaves nothing to roll back, and one whose outcome was
      // unknown was already resolved inside `commit`. Either way the transaction is over, and the
      // retry loop above decides whether to run the whole unit of work again.
      await transaction.commit(options.signal);

      return result;
    }, retryOptions);
  }

  // ─── Prepared statements ──────────────────────────────────────────────────

  /**
   * Registers a statement with the server, so this and every later execution of the same SQL sends
   * only a handle and its parameter values.
   *
   * Calling it is optional. The driver prepares a statement on its own once it has seen the same
   * SQL a few times; see the `maxAutoPrepare` and `autoPrepareMinUsages` settings. Call it to skip
   * that warm-up for a statement you already know is hot.
   *
   * Registration is idempotent per endpoint, database, and SQL, so preparing twice costs nothing. A
   * statement that cannot be prepared — schema, administration, or a server with no support for it
   * — is remembered as such and keeps running inline. That is not an error, and this method does
   * not report one for it.
   */
  async prepare(sql: string, options: StatementOptions = {}): Promise<void> {
    if (!isPreparableStatement(sql)) return;

    const policy = this.runtime.preparedStatements;
    const database = this.runtime.database;

    const endpoint =
      options.transaction !== undefined
        ? await options.transaction.ensureStarted(undefined, options.signal)
        : this.runtime.nextEndpoint();

    const { decision, evicted } = policy.pin(database, sql);

    if (decision === PrepareDecision.Register) {
      await this.register(endpoint, database, sql, options);
    }

    this.release(endpoint, evicted);
  }

  /** Whether a statement is currently kept prepared for this client's database. */
  isPrepared(sql: string): boolean {
    return this.runtime.preparedStatements.isPrepared(this.runtime.database, sql);
  }

  // ─── Authentication ───────────────────────────────────────────────────────

  /**
   * Authenticates as a user and caches the resulting bearer token for every later statement.
   *
   * It is only needed when the credentials are not already in the configuration, which
   * authenticates on first use, or to switch identity. Prefer it over putting a password in a
   * connection string when the password comes from a secret manager at run time.
   *
   * Against a server with authentication off this still performs a real login and will fail, so do
   * not call it unconditionally.
   *
   * @returns the minted token. The driver already holds it; it is reported for a caller that wants
   * to pass it to another process.
   */
  login(user: string, password: string, signal?: AbortSignal): Promise<string> {
    if (user.trim().length === 0) {
      throw new CamusError(CamusErrorCode.Generic, 'A user name cannot be empty.');
    }

    return this.runtime.auth.login(user, password, signal);
  }

  /**
   * Revokes this client's bearer token on the server.
   *
   * The configured credentials are kept, so a later statement authenticates again on its own: this
   * ends a session, it does not switch authentication off. It does nothing when no token has been
   * minted.
   */
  logout(signal?: AbortSignal): Promise<void> {
    return this.runtime.auth.logout(signal);
  }

  // ─── Databases ────────────────────────────────────────────────────────────

  /**
   * Creates a database.
   *
   * Concurrent creations can collide transiently while the server allocates the shared database id
   * sequence, which is what several environments provisioning in parallel produce. That is reported
   * as a retryable condition and is retried here.
   *
   * With `ifNotExists`, a creation that loses a registration race is treated as success. The caller
   * asked for the database to exist, and it does.
   */
  async createDatabase(
    database: string = this.runtime.database,
    options: { ifNotExists?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    const ifNotExists = options.ifNotExists === true;

    await this.withTransientRetry(async () => {
      try {
        await this.runtime.transport.createDatabase(
          this.runtime.nextEndpoint(),
          database,
          ifNotExists,
          this.runtime.timeoutSeconds,
          options.signal,
        );
      } catch (error) {
        // The server's idempotent existence check has a gap against concurrent registration: two
        // racing creations for the same name can both pass it, and the one that loses is refused
        // as already registered. The caller asked for the database to exist, and it does.
        if (ifNotExists && CamusError.is(error) && error.code === CamusErrorCode.DatabaseAlreadyExists) {
          return;
        }

        throw error;
      }
    }, options.signal);
  }

  /** Drops a database and everything in it. */
  dropDatabase(
    database: string = this.runtime.database,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.runtime.transport.dropDatabase(
      this.runtime.nextEndpoint(),
      database,
      this.runtime.timeoutSeconds,
      options.signal,
    );
  }

  /**
   * Creates a copy-on-write branch of a database. It is the same operation as
   * `CREATE DATABASE branch BRANCH FROM source`.
   */
  createBranchDatabase(
    branchName: string,
    sourceDatabaseName: string,
    options: { ifNotExists?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.withTransientRetry(
      () =>
        this.runtime.transport.createBranchDatabase(
          this.runtime.nextEndpoint(),
          branchName,
          sourceDatabaseName,
          options.ifNotExists === true,
          this.runtime.timeoutSeconds,
          options.signal,
        ),
      options.signal,
    );
  }

  /**
   * Every transitive descendant of a database, ordered by depth and then by name. A database with
   * no descendants reports an empty list.
   */
  showBranches(
    database: string = this.runtime.database,
    options: { signal?: AbortSignal } = {},
  ): Promise<CamusBranchRow[]> {
    return this.runtime.transport.showBranches(
      this.runtime.nextEndpoint(),
      database,
      this.runtime.timeoutSeconds,
      options.signal,
    );
  }

  /**
   * The ancestry chain of a database, from its nearest parent to the root. A root database reports
   * an empty list.
   */
  showAncestors(
    database: string = this.runtime.database,
    options: { signal?: AbortSignal } = {},
  ): Promise<CamusBranchRow[]> {
    return this.runtime.transport.showAncestors(
      this.runtime.nextEndpoint(),
      database,
      this.runtime.timeoutSeconds,
      options.signal,
    );
  }

  // ─── Large values ─────────────────────────────────────────────────────────

  /**
   * Converts the rows a table already stores to its current large-value storage rules, with
   * `ALTER TABLE … REWRITE STORAGE`.
   *
   * ```ts
   * await client.rewriteStorage('docs', { timeoutSeconds: 3600 });
   * ```
   *
   * With `inline`, it runs `REWRITE STORAGE INLINE` instead, which stores every value inside its row
   * and uncompressed. That is the form a server without large-value storage can read. No value
   * changes, so no query result changes. Only the physical form of each row, and the I/O a query
   * does, change.
   *
   * The server runs the rewrite in its own bounded transactions, never in a caller's transaction, so
   * this method takes none. A rollback cannot undo the batches that committed. The time is
   * proportional to the table, so give a large table a sufficient `timeoutSeconds`. The rewrite is
   * idempotent and resumable: when a run stops, a second run continues after the last committed
   * batch. It never overwrites a user write, but a concurrent write to a row in a committing batch
   * can fail with the retryable `CADB0502`.
   */
  async rewriteStorage(
    table: string,
    options: { inline?: boolean; signal?: AbortSignal; timeoutSeconds?: number } = {},
  ): Promise<void> {
    await this.executeDdl(rewriteStorageStatement(table, { inline: options.inline ?? false }), {
      signal: options.signal,
      timeoutSeconds: options.timeoutSeconds,
    });
  }

  // ─── Query result cache ───────────────────────────────────────────────────

  /** Drops every cached query result in one family, for the current database. */
  async evictCache(name: string, options: StatementOptions = {}): Promise<void> {
    await this.executeNonQuery(evictCacheStatement(name), undefined, options);
  }

  /** Drops every cached query result for the current database. It never touches another one's. */
  async evictAllCache(options: StatementOptions = {}): Promise<void> {
    await this.executeNonQuery(evictAllCacheStatement(), undefined, options);
  }

  // ─── Lifetime ─────────────────────────────────────────────────────────────

  /**
   * Releases what this client holds on its own, which today is nothing: the transport, the token,
   * and the endpoint rotation are shared, and outlive any one client.
   *
   * Call `CamusTransportPool.closeAll` to release the shared gRPC channels when a process is
   * shutting down.
   */
  async close(): Promise<void> {
    await Promise.resolve();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async executeNonQuery(
    sql: string,
    parameters: Parameters | undefined,
    options: AutocommitStatementOptions,
  ): Promise<ExecuteResult> {
    const encoded = encodeParameters(parameters);
    const transaction = options.transaction;

    const route = await this.route(sql, CamusRouteOpKind.NonQuery, transaction, options.signal);

    const request = await this.buildRequest(sql, encoded, route, transaction, options, {
      negotiateRouting: route.router !== undefined,
      autocommitOptions:
        transaction === undefined ? this.resolveTransactionOptions(options.transactionOptions) : undefined,
    });

    const result = await this.runtime.transport.executeNonQuery(request);

    route.router?.learn(request.database, sql, CamusRouteOpKind.NonQuery, result.routing, route.revision);

    return { affectedRows: result.affectedRows, routingAdvice: result.routing };
  }

  /**
   * Resolves where one statement is sent, in strict order of precedence.
   *
   * An explicit transaction's pinned endpoint always wins: its operations must land in one
   * server-side ordering chain, and advice may inform the next transaction but never relocates
   * this one. Then a fresh learned route, when routing is on. Then the pool's ordinary rotation.
   *
   * It also reports the router and the route entry's revision, so the reply's advice can be applied
   * conditionally: a late reply must never overwrite a route a faster reply already refreshed. A
   * router of `undefined` means "do not negotiate", and a client with routing off then sends
   * requests identical to a pre-routing driver's.
   *
   * A deferred transaction — routing on, no statement yet — is started here by its first statement,
   * on that statement's learned endpoint when one is fresh and on rotation otherwise. Every later
   * statement finds the pin already set.
   */
  private async route(
    sql: string,
    kind: CamusRouteOpKind,
    transaction: CamusTransaction | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ endpoint: string; router: CamusStatementRouter | undefined; revision: number }> {
    const router = this.runtime.router;

    if (transaction !== undefined) {
      if (router === undefined) {
        return {
          endpoint: await transaction.ensureStarted(undefined, signal),
          router: undefined,
          revision: 0,
        };
      }

      // Consulted even when the pin is already set: the observed revision is what lets the reply's
      // advice refresh the route conditionally, instead of losing to the entry it would refresh.
      const learned = router.selectEndpoint(this.runtime.database, sql, kind);
      const pinned = await transaction.ensureStarted(learned.endpoint, signal);

      return { endpoint: pinned, router, revision: learned.revision };
    }

    if (router === undefined) {
      return { endpoint: this.runtime.nextEndpoint(), router: undefined, revision: 0 };
    }

    const learned = router.selectEndpoint(this.runtime.database, sql, kind);

    return {
      endpoint: learned.endpoint ?? this.runtime.nextEndpoint(),
      router,
      revision: learned.revision,
    };
  }

  private async buildRequest(
    sql: string,
    parameters: ReadonlyMap<string, ColumnValue> | undefined,
    route: { endpoint: string; router: CamusStatementRouter | undefined },
    transaction: CamusTransaction | undefined,
    options: StatementOptions,
    extra: { negotiateRouting: boolean; autocommitOptions?: CamusTransactionOptions | undefined },
  ): Promise<TransportSqlRequest> {
    return {
      endpoint: route.endpoint,
      database: this.runtime.database,
      sql,
      parameters,
      timeoutSeconds: options.timeoutSeconds ?? this.runtime.timeoutSeconds,
      prepared: await this.shouldPrepare(sql, route.endpoint, options),
      routingAcceptVersion: extra.negotiateRouting ? ROUTING_ACCEPT_VERSION : 0,
      ...(transaction === undefined
        ? extra.autocommitOptions === undefined
          ? {}
          : { autocommitOptions: extra.autocommitOptions }
        : {
            txnIdPT: transaction.txnIdPT,
            txnIdCounter: transaction.txnIdCounter,
            streamSlot: transaction.streamSlot,
          }),
      signal: options.signal,
    };
  }

  /**
   * Whether this execution should name a prepared statement instead of carrying its SQL,
   * registering it first when this is the execution that tips it over the threshold.
   *
   * The registration is awaited rather than started in the background, because the whole point is
   * that this execution and the ones after it are cheap. Firing it off and running inline anyway
   * would leave a busy statement racing its own warm-up. It costs one extra round trip, once per
   * statement per endpoint.
   *
   * The caller passes the endpoint it already resolved. A REST handle is node-local and the pool
   * rotates, so registering against a freshly drawn endpoint would routinely prepare on one node
   * and execute on another — correct, because the transport re-registers where it lands, but a
   * wasted round trip every single time.
   */
  private async shouldPrepare(sql: string, endpoint: string, options: StatementOptions): Promise<boolean> {
    const policy = this.runtime.preparedStatements;

    if (policy.isDisabled || !isPreparableStatement(sql)) return false;

    const { decision, evicted } = policy.decide(this.runtime.database, sql);

    this.release(endpoint, evicted);

    switch (decision) {
      case PrepareDecision.Yes:
        return true;

      case PrepareDecision.Register:
        return this.register(endpoint, this.runtime.database, sql, options);

      default:
        return false;
    }
  }

  /**
   * Registers a statement and records what happened, reporting whether it may now run prepared.
   *
   * A registration failure never reaches the caller: preparing is an optimization, and the
   * statement runs inline exactly as it would have if the driver had not tried. What the failure
   * does decide is whether to ask again. A refusal specific to this statement stops asking for that
   * statement; anything that says the node has no prepared-statement support at all stops asking
   * for every statement, because one round trip per distinct SQL to relearn that is worse than not
   * trying.
   */
  private async register(
    endpoint: string,
    database: string,
    sql: string,
    options: StatementOptions,
  ): Promise<boolean> {
    const policy = this.runtime.preparedStatements;

    try {
      await this.runtime.transport.prepare(
        endpoint,
        database,
        sql,
        options.timeoutSeconds ?? this.runtime.timeoutSeconds,
        options.signal,
      );

      policy.markPrepared(database, sql);
      return true;
    } catch (error) {
      // The caller's own cancellation is not a verdict on the statement, but the entry must not be
      // left mid-registration, or it would never be reconsidered.
      if (options.signal?.aborted === true) {
        policy.forget(database, sql);
        throw error;
      }

      // Deliberately broad. Whatever went wrong, the statement is about to run inline and will
      // report any real problem itself; the only decision left here is whether asking again is
      // worth a round trip, and for this statement it is not.
      policy.markRefused(database, sql);

      if (CamusError.is(error) && isUnsupported(error)) policy.disable();

      return false;
    }
  }

  /**
   * Releases a statement the policy evicted, so the server stops holding a handle this client has
   * stopped using.
   *
   * It is best effort and off the caller's path: it is bookkeeping, not part of the statement being
   * run. It takes the endpoint the caller already resolved rather than drawing a new one, which
   * would rotate the pool as a side effect of housekeeping.
   */
  private release(endpoint: string, evicted: EvictedStatement | undefined): void {
    if (evicted === undefined) return;

    void this.runtime.transport.closePrepared(endpoint, evicted.database, evicted.sql).catch(() => undefined);
  }

  /**
   * The effective options for a transaction or an autocommit statement: the caller's explicit knobs
   * win, then this client's defaults, then the server default for any knob still unset.
   */
  private resolveTransactionOptions(requested: CamusTransactionOptions | undefined): CamusTransactionOptions {
    return withDefaults(requested ?? {}, this.runtime.config.defaultTransactionOptions);
  }

  private decodeOptions(options: StatementOptions): { int64: Int64Mode } {
    return { int64: options.int64 ?? this.runtime.config.decode.int64 };
  }

  private async withTransientRetry<T>(
    operation: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const maxAttempts = 5;

    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryable(error)) throw error;

        const base = Math.min(50 * 2 ** (attempt - 1), 800);
        const jitter = base * 0.25 * (2 * Math.random() - 1);

        await delay(Math.max(1, base + jitter), signal);
      }
    }
  }
}

/**
 * True when a failure says the node does not implement prepared statements at all, rather than
 * declining this particular statement.
 *
 * Both spellings surface under the generic code, because a server old enough not to have the
 * feature is also too old to have a specific code for refusing it. A server that does have it
 * declines an individual statement with a `CADB05xx` code instead.
 *
 * It is a heuristic, and it is only ever used to answer "is asking again worth a round trip?".
 * Reading it wrong costs at most one wasted registration attempt per statement, never a failed
 * statement.
 */
function isUnsupported(error: CamusError): boolean {
  return (
    error.code === CamusErrorCode.Generic &&
    (error.message.includes('404') || error.message.toLowerCase().includes('unimplemented'))
  );
}

/**
 * The typed row insert names columns as they are, with no `@` placeholder prefix, because it binds
 * to column names rather than to placeholders.
 */
function encodeUnprefixed(values: Parameters): Map<string, ColumnValue> {
  const encoded = encodeParameters(values) ?? new Map<string, ColumnValue>();
  const columns = new Map<string, ColumnValue>();

  for (const [name, value] of encoded) {
    columns.set(name.startsWith('@') ? name.slice(1) : name, value);
  }

  return columns;
}

async function rollbackQuietly(transaction: CamusTransaction): Promise<void> {
  try {
    await transaction.rollback();
  } catch {
    // The work already failed, and that is the failure worth reporting. An abandoned transaction
    // is ended by the server's own session timeout.
  }
}
