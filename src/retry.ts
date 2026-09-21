/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from './errors.js';
import { CamusErrorCode } from './error-codes.js';

/**
 * Which failures a caller may retry, and a loop that does it.
 *
 * A serializable transaction can lose a conflict and be aborted. The abort is not a bug and it is
 * not a lasting condition: the same work, run again, usually commits. This module holds the one
 * classification of "run it again" the whole driver uses, so a retry loop a caller writes and the
 * loops inside the driver agree on what is retryable.
 */

/** The server codes that name a lost conflict or a transient internal condition. */
const RETRYABLE_CODES = new Set(['CADB0502', 'CADB0504', 'CADB0505']);

/**
 * Message fragments that name the same conditions on a server that reported them without a
 * dedicated code. A message test is coarse, but the alternative is failing a transaction that
 * would have committed on its second attempt.
 */
const RETRYABLE_MESSAGE_MARKERS = ['MustRetry', 'AlreadyLocked', 'commit returned Aborted'];

/** How far `isRetryable` walks a `cause` chain before it stops. */
const MAX_CAUSE_DEPTH = 16;

/**
 * True when running the same work again may succeed.
 *
 * `CADB0509` is deliberately **not** retryable here. It says a commit or rollback outcome is not
 * resolved yet, which means the transaction may already be durable — replaying the work from
 * `BEGIN` could apply it twice. The driver resolves that code by re-issuing the same finalize on
 * the same handle, which `CamusTransaction` does on its own.
 */
export function isRetryable(error: unknown): boolean {
  let current: unknown = error;

  // A cause chain comes from outside the driver and can hold a cycle. The cap bounds the walk
  // without a visited set; no real chain is anywhere near this deep.
  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
    const next: unknown = (current as { cause?: unknown }).cause;

    if (!CamusError.is(current)) {
      current = next;
      continue;
    }

    if (current.code === CamusErrorCode.FinalizeUnresolved) return false;
    if (RETRYABLE_CODES.has(current.code)) return true;

    for (const marker of RETRYABLE_MESSAGE_MARKERS) {
      if (current.message.includes(marker)) return true;
    }

    current = next;
  }

  return false;
}

/** How a retry loop behaves. */
export interface RetryOptions {
  /** How many times the work runs in total, the first attempt included. Default 5. */
  readonly maxAttempts?: number;

  /** Ends the loop between attempts. */
  readonly signal?: AbortSignal;
}

/**
 * Runs `operation` and retries it while it fails with a retryable error.
 *
 * Use it around a unit of work that is safe to run twice — a single autocommit statement, or a
 * whole transaction from `BEGIN` to `COMMIT`. Do not use it around a commit alone: a commit whose
 * outcome is unknown must not be replayed from the start.
 *
 * The delay grows exponentially from 20 ms, caps at 400 ms, and carries 25% jitter, so a set of
 * clients that conflicted do not retry in step.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;

      await delay(computeDelayMs(attempt), options.signal);
    }
  }
}

/**
 * The back-off after attempt number `attempt`, in milliseconds. Exported so a caller can mirror the
 * schedule. The first retry waits the documented 20 ms base, the second 40 ms, and so on.
 */
export function computeDelayMs(attempt: number): number {
  const base = Math.min(20 * 2 ** (attempt - 1), 400);
  const jitter = base * 0.25 * (2 * Math.random() - 1);

  return Math.max(1, base + jitter);
}

/** A cancellable sleep. Rejects with the signal's reason when the signal ends the wait. */
export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason as Error);

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);

    function onAbort(): void {
      clearTimeout(timer);
      reject(signal!.reason as Error);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
