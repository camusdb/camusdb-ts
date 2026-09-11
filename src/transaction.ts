/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from './errors.js';
import { CamusErrorCode } from './error-codes.js';
import type { CamusTransactionOptions } from './options.js';
import { delay } from './retry.js';
import type { ClientRuntime } from './runtime.js';
import { CamusRouteOpKind } from './routing/route-cache.js';

/**
 * A set of reads and writes that take effect atomically, at one logical instant, across columns,
 * rows, and tables.
 *
 * **Where a transaction starts.** With learned routing off, `BEGIN` is sent when the transaction is
 * created, on the pool's next endpoint. With learned routing on, `BEGIN` is deferred: the
 * transaction is started by its first statement, on the endpoint that statement's learned route
 * names, so a transaction whose first statement touches a table runs where that table's leader is.
 * Once started it is pinned to that endpoint for its whole life; a statement's own route may inform
 * a later transaction, but never relocates this one. A caller that knows the transaction's hot
 * statement can choose the endpoint at `BEGIN` with `options.affinity` instead.
 *
 * Two consequences of the deferral are visible, and only in routed mode: the server-minted identity
 * reads as zero until the first statement, and a failure to begin surfaces from that first
 * statement rather than from the call that created the transaction.
 */
export class CamusTransaction {
  private readonly runtime: ClientRuntime;

  private txnIdPTValue = 0n;

  private txnIdCounterValue = 0;

  private endpointValue: string | undefined;

  private startedValue = false;

  /**
   * The single `BEGIN` in flight or finished, for a deferred transaction. Every racing first
   * statement awaits this same promise, and a `BEGIN` that failed stays failed: nothing was minted,
   * the transaction is unusable, and the caller begins a new one — which is the state a failed
   * eager `BEGIN` leaves too.
   */
  private startPromise: Promise<void> | undefined;

  private startFailed = false;

  private finalized = false;

  /** The concurrency knobs this transaction was begun with, after every default was applied. */
  readonly options: CamusTransactionOptions;

  /**
   * The stream slot this transaction's statements pin to, so the server sees them in one ordering
   * chain. It is a gRPC concept; REST does not pin.
   */
  streamSlot: number | undefined;

  /** @internal Use `CamusClient.beginTransaction`. */
  constructor(
    runtime: ClientRuntime,
    options: CamusTransactionOptions,
    started?: { txnIdPT: bigint; txnIdCounter: number; endpoint: string; streamSlot?: number | undefined },
  ) {
    this.runtime = runtime;
    this.options = options;

    if (started !== undefined) {
      this.txnIdPTValue = started.txnIdPT;
      this.txnIdCounterValue = started.txnIdCounter;
      this.endpointValue = started.endpoint;
      this.streamSlot = started.streamSlot;
      this.startedValue = true;
    }
  }

  /**
   * True once the server minted this transaction.
   *
   * It is always true with learned routing off. With routing on it is false until the first
   * statement, or until an explicit `affinity`, starts it.
   */
  get isStarted(): boolean {
    return this.startedValue;
  }

  /** True once this transaction was committed or rolled back. */
  get isFinalized(): boolean {
    return this.finalized;
  }

  /** The physical-time half of the server-minted identity. Zero until the transaction starts. */
  get txnIdPT(): bigint {
    return this.txnIdPTValue;
  }

  /** The counter half of the server-minted identity. Zero until the transaction starts. */
  get txnIdCounter(): number {
    return this.txnIdCounterValue;
  }

  /** The identity as one string, for logs and correlation. */
  get transactionId(): string {
    return `${this.txnIdPTValue.toString()}:${String(this.txnIdCounterValue)}`;
  }

  /** The endpoint this transaction is pinned to, or `undefined` while it has not started. */
  get endpoint(): string | undefined {
    return this.endpointValue;
  }

  /**
   * Starts the transaction if it has not started, and reports the endpoint it is pinned to.
   *
   * It starts on `preferredEndpoint` when one is given — a learned route for the statement about
   * to run — and on the pool's rotation otherwise. The first caller sends `BEGIN`; a concurrent
   * caller awaits that same send. Once started, a later call's preferred endpoint is ignored,
   * because the pin is final.
   *
   * @internal
   */
  async ensureStarted(preferredEndpoint: string | undefined, signal?: AbortSignal): Promise<string> {
    if (!this.startedValue) {
      this.startPromise ??= this.startOn(preferredEndpoint ?? this.runtime.nextEndpoint(), signal);

      await this.startPromise;
    }

    return this.endpointValue!;
  }

  private async startOn(target: string, signal: AbortSignal | undefined): Promise<void> {
    try {
      const result = await this.runtime.transport.startTransaction(
        target,
        this.runtime.database,
        this.options,
        this.runtime.timeoutSeconds,
        signal,
      );

      this.txnIdPTValue = result.txnIdPT;
      this.txnIdCounterValue = result.txnIdCounter;
      this.streamSlot = result.streamSlot;
      this.endpointValue = target;
      this.startedValue = true;
    } catch (error) {
      this.startFailed = true;
      throw error;
    }
  }

  /** Makes this transaction's writes durable. */
  commit(signal?: AbortSignal): Promise<void> {
    return this.finalize(true, signal);
  }

  /** Discards this transaction's writes. */
  rollback(signal?: AbortSignal): Promise<void> {
    return this.finalize(false, signal);
  }

  /**
   * Issues a commit or a rollback, and resolves a `CADB0509` outcome by re-issuing the **same**
   * finalize on the **same** handle, bounded and backing off.
   *
   * `CADB0509` says the outcome is not known yet. The transaction is not dead, so the operation
   * must never be replayed from `BEGIN`: that could apply an already-durable commit a second time.
   * Every other failure reaches the caller.
   *
   * A deferred transaction that ran no statement is started here first, on the pool's rotation, so
   * the server sees the same `BEGIN` and finalize pair it always did.
   */
  private async finalize(commit: boolean, signal: AbortSignal | undefined): Promise<void> {
    if (this.finalized) {
      throw new CamusError(CamusErrorCode.Generic, 'This transaction was already committed or rolled back.');
    }

    // A deferred `BEGIN` that failed left nothing on the server. The failure already surfaced at
    // the statement that triggered it, so a rollback — which a scope issues without looking — has
    // nothing to undo and finishes quietly, while a commit still reports the failed start.
    if (!commit && !this.startedValue && this.startFailed) {
      this.finalized = true;
      return;
    }

    const target = await this.ensureStarted(undefined, signal);

    for (let attempt = 0; ; attempt++) {
      try {
        await this.runtime.transport.finalizeTransaction(
          commit,
          target,
          this.runtime.database,
          this.txnIdPTValue,
          this.txnIdCounterValue,
          this.streamSlot,
          this.runtime.timeoutSeconds,
          signal,
        );

        this.finalized = true;
        return;
      } catch (error) {
        if (
          !CamusError.is(error) ||
          error.code !== CamusErrorCode.FinalizeUnresolved ||
          attempt >= MAX_FINALIZE_ATTEMPTS
        ) {
          throw error;
        }

        await delay(finalizeDelayMs(attempt), signal);
      }
    }
  }

  /**
   * Rolls the transaction back if it was neither committed nor rolled back, so a `using` block
   * cannot leave one open. A rollback that itself fails is swallowed: the block is unwinding, and
   * the server ends an abandoned transaction on its own session timeout.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.finalized) return;

    try {
      await this.rollback();
    } catch {
      // Nothing useful can be done while a scope is unwinding.
    }
  }

  /**
   * The routing kind a statement of this transaction reports. Statements inside a transaction still
   * negotiate and learn, for the benefit of the next transaction, but the route they learn never
   * moves this one.
   *
   * @internal
   */
  static readonly routeKind = CamusRouteOpKind;
}

/**
 * How many times an unresolved commit or rollback is re-issued on the same handle before the error
 * reaches the caller. The server's own session timeout is the ultimate backstop.
 */
const MAX_FINALIZE_ATTEMPTS = 10;

/**
 * The finalize back-off: 50 ms doubling to about 3.2 seconds, which matches the server's contract
 * for an unresolved outcome.
 */
function finalizeDelayMs(attempt: number): number {
  return 50 * 2 ** Math.min(attempt, 6);
}
