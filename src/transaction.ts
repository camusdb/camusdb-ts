/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from './errors.js';
import { CamusErrorCode } from './error-codes.js';
import type { CamusTransactionOptions } from './options.js';
import { CamusPipeline } from './pipeline.js';
import { delay } from './retry.js';
import type { ClientRuntime } from './runtime.js';
import { CamusRouteOpKind } from './routing/route-cache.js';
import { CamusRetryKind, recordRetry, traced } from './telemetry.js';
import type { StartTransactionResult } from './transport/transport.js';

/**
 * A pipeline's claim on a transaction's `BEGIN`. It is settled once the server answered the
 * `BEGIN` that rode the pipeline's exchange.
 *
 * @internal
 */
export interface StartClaim {
  resolve(result: StartTransactionResult, target: string): void;
  reject(error: Error): void;
}

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
 * `options.deferBegin` defers `BEGIN` with learned routing off too. The first statement then starts
 * the transaction on the pool's rotation. When that first statement is a `CamusPipeline` send, the
 * `BEGIN` travels inside the same exchange.
 *
 * Two consequences of the deferral are visible, and only for a deferred transaction: the
 * server-minted identity reads as zero until the first statement, and a failure to begin surfaces
 * from that first statement rather than from the call that created the transaction.
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

  /**
   * True once a pipeline committed this transaction, so that a later finalize does not ask the
   * server about a transaction it no longer knows.
   */
  private committedByPipeline = false;

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
   * It is always true with learned routing off and no `deferBegin`. For a deferred transaction it
   * is false until the first statement, or until an explicit `affinity`, starts it.
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
      const result = await traced(this.runtime, { operationName: 'BEGIN' }, (operation) => {
        operation?.setEndpoint(target);

        return this.runtime.transport.startTransaction(
          target,
          this.runtime.database,
          this.options,
          this.runtime.timeoutSeconds,
          signal,
        );
      });

      this.seat(result, target);
    } catch (error) {
      this.startFailed = true;
      throw error;
    }
  }

  private seat(result: StartTransactionResult, target: string): void {
    this.txnIdPTValue = result.txnIdPT;
    this.txnIdCounterValue = result.txnIdCounter;
    this.streamSlot = result.streamSlot;
    this.endpointValue = target;
    this.startedValue = true;
  }

  /**
   * Several statements of this transaction, sent as one exchange and answered together. See
   * `CamusPipeline`. A transaction begun with `deferBegin`, or with learned routing on, sends its
   * `BEGIN` inside the first pipeline send too.
   */
  pipeline(): CamusPipeline {
    return new CamusPipeline(this, this.runtime);
  }

  /**
   * Lets a pipeline begin this transaction inside its first exchange.
   *
   * When nothing has begun the transaction yet, it reports a claim. The pipeline settles the claim
   * after the server answered the `BEGIN`. When a `BEGIN` is already under way, it reports that
   * `BEGIN` for the pipeline to await instead. When the transaction has started, it reports
   * neither. The memoized `startPromise` is what makes a pipeline and a statement that race to be
   * the first one agree on one `BEGIN`.
   *
   * @internal
   */
  claimStart(): { claim?: StartClaim; pending?: Promise<void> } {
    if (this.startedValue) return {};

    if (this.startPromise !== undefined) return { pending: this.startPromise };

    let resolve!: () => void;
    let reject!: (error: Error) => void;

    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });

    // A claim that fails with no statement waiting on it must not be reported as unhandled. The
    // failure reaches the pipeline's caller from the send.
    promise.catch(() => undefined);

    this.startPromise = promise;

    return {
      claim: {
        resolve: (result, target) => {
          this.seat(result, target);
          resolve();
        },
        reject: (error) => {
          this.startFailed = true;
          reject(error);
        },
      },
    };
  }

  /**
   * Records that a pipeline's conditional commit committed this transaction.
   *
   * @internal
   */
  markCommittedByPipeline(): void {
    this.committedByPipeline = true;
    this.finalized = true;
  }

  /**
   * True when a pipeline committed this transaction.
   *
   * @internal
   */
  get isCommittedByPipeline(): boolean {
    return this.committedByPipeline;
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
    // A pipeline committed this transaction already. A rollback has nothing to undo. A second
    // commit is a mistake of the caller, and the server would only answer that it does not know
    // the transaction.
    if (this.committedByPipeline) {
      if (commit) {
        throw new CamusError(CamusErrorCode.Generic, 'A pipeline already committed this transaction.');
      }

      return;
    }

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
    const name = commit ? 'COMMIT' : 'ROLLBACK';

    // One span over every attempt. Each retry is a `camusdb.retry` event on it.
    await traced(this.runtime, { operationName: name }, async (operation) => {
      operation?.setEndpoint(target);

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

          recordRetry(CamusRetryKind.Finalize, error, {
            database: this.runtime.database,
            operationName: name,
            operation,
          });

          await delay(finalizeDelayMs(attempt), signal);
        }
      }
    });
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
