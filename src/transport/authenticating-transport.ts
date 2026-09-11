/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusTokenProvider } from '../auth/token-provider.js';
import type { CamusProtocol } from '../config.js';
import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';
import type { CamusTransactionOptions } from '../options.js';
import type { CamusRowSource } from '../row-source.js';
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

/**
 * Wraps a transport with the reactive half of token management.
 *
 * The inner transport attaches whatever token the provider currently holds. This wrapper watches
 * for the server rejecting it with `CADB0516`, discards it, and replays the operation once with a
 * freshly minted one.
 *
 * That covers the failures a client-side expiry timer cannot see: a rotated password, a dropped
 * user, a logout from elsewhere, a server configured with a shorter token lifetime than the driver
 * assumes, or a token minted before a server restart. It does **not** retry `CADB0517`,
 * insufficient privilege: authenticating again as the same user cannot grant a privilege, so a
 * retry would only double the work before the same refusal.
 *
 * There is exactly one replay per call, and only when the attempt actually presented a token the
 * provider can replace. A rejection with no token in hand came from the login itself — a wrong
 * password — and replaying it would burn two attempts per statement against a limit of twenty per
 * account per minute. A token supplied directly is likewise reported as it is, because there is no
 * password to mint a replacement with.
 *
 * A replayed statement never reached execution, so a replay here is no less safe than the retry
 * paths the driver already runs for a serializable conflict.
 */
export class AuthenticatingTransport implements CamusTransport {
  /** The wrapped transport, for tests and for the login client the gRPC transport also is. */
  readonly inner: CamusTransport;

  private readonly auth: CamusTokenProvider;

  constructor(inner: CamusTransport, auth: CamusTokenProvider) {
    this.inner = inner;
    this.auth = auth;
  }

  get protocol(): CamusProtocol {
    return this.inner.protocol;
  }

  startTransaction(
    endpoint: string,
    database: string,
    options: CamusTransactionOptions,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<StartTransactionResult> {
    return this.run(() => this.inner.startTransaction(endpoint, database, options, timeoutSeconds, signal));
  }

  finalizeTransaction(
    commit: boolean,
    endpoint: string,
    database: string,
    txnIdPT: bigint,
    txnIdCounter: number,
    streamSlot: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.run(() =>
      this.inner.finalizeTransaction(
        commit,
        endpoint,
        database,
        txnIdPT,
        txnIdCounter,
        streamSlot,
        timeoutSeconds,
        signal,
      ),
    );
  }

  executeQuery(request: TransportSqlRequest): Promise<QueryTransportResult> {
    return this.run(() => this.inner.executeQuery(request));
  }

  executeQueryStream(request: TransportSqlRequest): Promise<CamusRowSource> {
    return this.run(() => this.inner.executeQueryStream(request));
  }

  executeNonQuery(request: TransportSqlRequest): Promise<NonQueryTransportResult> {
    return this.run(() => this.inner.executeNonQuery(request));
  }

  insert(request: TransportInsertRequest): Promise<number> {
    return this.run(() => this.inner.insert(request));
  }

  executeDdl(request: TransportSqlRequest): Promise<boolean> {
    return this.run(() => this.inner.executeDdl(request));
  }

  prepare(
    endpoint: string,
    database: string,
    sql: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<PreparedStatementInfo> {
    return this.run(() => this.inner.prepare(endpoint, database, sql, timeoutSeconds, signal));
  }

  /**
   * Closing is best-effort and idempotent. A token the server has already rejected means the
   * handle it named is unreachable anyway, so there is nothing a replay could still release.
   */
  closePrepared(endpoint: string, database: string, sql: string, signal?: AbortSignal): Promise<void> {
    return this.inner.closePrepared(endpoint, database, sql, signal);
  }

  ping(endpoint: string, timeoutSeconds: number, signal?: AbortSignal): Promise<boolean> {
    return this.run(() => this.inner.ping(endpoint, timeoutSeconds, signal));
  }

  createDatabase(
    endpoint: string,
    database: string,
    ifNotExists: boolean,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.run(() => this.inner.createDatabase(endpoint, database, ifNotExists, timeoutSeconds, signal));
  }

  createBranchDatabase(
    endpoint: string,
    branchName: string,
    sourceDatabaseName: string,
    ifNotExists: boolean,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.run(() =>
      this.inner.createBranchDatabase(
        endpoint,
        branchName,
        sourceDatabaseName,
        ifNotExists,
        timeoutSeconds,
        signal,
      ),
    );
  }

  dropDatabase(
    endpoint: string,
    database: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.run(() => this.inner.dropDatabase(endpoint, database, timeoutSeconds, signal));
  }

  showBranches(
    endpoint: string,
    database: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CamusBranchRow[]> {
    return this.run(() => this.inner.showBranches(endpoint, database, timeoutSeconds, signal));
  }

  showAncestors(
    endpoint: string,
    database: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CamusBranchRow[]> {
    return this.run(() => this.inner.showAncestors(endpoint, database, timeoutSeconds, signal));
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    // Read before the call, so a refresh by a concurrent caller is not thrown away: only the token
    // this attempt actually presented is discarded.
    let presented = this.auth.currentToken;

    try {
      return await operation();
    } catch (error) {
      if (!this.isRenewable(error)) throw error;

      // The cache is normally warm before the call. On a client's first statement it is not: the
      // inner transport mints the token during the call, and the read above returned undefined.
      // Falling back to the token the provider holds now discards the one that call actually
      // presented, instead of invalidating nothing and replaying with the same rejected token.
      presented ??= this.auth.currentToken;

      if (presented === undefined) throw error;

      this.auth.invalidate(presented);
    }

    return operation();
  }

  private isRenewable(error: unknown): boolean {
    return CamusError.is(error) && error.code === CamusErrorCode.AuthenticationFailed && this.auth.canRenew;
  }
}
