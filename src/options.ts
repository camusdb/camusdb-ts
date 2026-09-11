/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * The SQL isolation level a transaction runs at. It is independent of `CamusLocking`.
 *
 * The member values are the exact strings the server accepts in the `isolationLevel` wire field.
 */
export const CamusIsolationLevel = {
  /** Lock-free reads of the latest committed value. No repeatable-read or phantom protection. */
  ReadCommitted: 'ReadCommitted',

  /**
   * The strongest level. The outcome is equivalent to some serial order. A read-write transaction
   * takes point and range locks; a read-only one is a lock-free consistent snapshot.
   */
  Serializable: 'Serializable',
} as const;

export type CamusIsolationLevel = (typeof CamusIsolationLevel)[keyof typeof CamusIsolationLevel];

/** Whether a transaction may write. */
export const CamusTransactionMode = {
  /** The transaction may read and write. This is the default. */
  ReadWrite: 'ReadWrite',

  /**
   * The transaction only reads. Together with `Serializable` this is a lock-free consistent
   * snapshot, pinned to the instant it began and resumable across several requests.
   */
  ReadOnly: 'ReadOnly',
} as const;

export type CamusTransactionMode = (typeof CamusTransactionMode)[keyof typeof CamusTransactionMode];

/** How a transaction resolves a conflict. It is independent of `CamusIsolationLevel`. */
export const CamusLocking = {
  /**
   * Take locks up front. A conflicting transaction blocks, or deadlock avoidance aborts it, at the
   * moment it asks for a lock. This is the default, and what almost every caller uses.
   */
  Pessimistic: 'Pessimistic',

  /**
   * Take no explicit locks. Stage the writes, record what was read, and detect write-write and
   * read-write conflicts only at commit. A losing transaction fails its commit and must be retried.
   * Good for a read-mostly workload with little contention. It does not protect against phantoms;
   * use `Serializable` with pessimistic locking when you need that.
   */
  Optimistic: 'Optimistic',
} as const;

export type CamusLocking = (typeof CamusLocking)[keyof typeof CamusLocking];

/**
 * The concurrency knobs for one transaction, or for the short transaction the server begins for a
 * single autocommit statement.
 *
 * Every knob is optional. A knob left unset falls back to the client's default options, then to
 * the connection-string defaults, then to the server default.
 */
export interface CamusTransactionOptions {
  readonly isolationLevel?: CamusIsolationLevel | undefined;
  readonly mode?: CamusTransactionMode | undefined;
  readonly locking?: CamusLocking | undefined;

  /**
   * The exact SQL text of the statement whose learned route decides where this transaction starts.
   *
   * It matters only with learned routing on. Without it, the transaction's first statement chooses
   * the endpoint; with it, `BEGIN` is sent at once, to the endpoint that statement's route names.
   * Set it when the transaction's hot statement is not its first one.
   */
  readonly affinity?: string | undefined;
}

/** No knob set: every one deferred to a lower level of defaults. */
export const DEFAULT_TRANSACTION_OPTIONS: CamusTransactionOptions = Object.freeze({});

/** Optimistic locking, with isolation and mode left to the defaults. */
export const OPTIMISTIC_TRANSACTION_OPTIONS: CamusTransactionOptions = Object.freeze({
  locking: CamusLocking.Optimistic,
});

/** A lock-free consistent snapshot: serializable and read-only. */
export const SNAPSHOT_TRANSACTION_OPTIONS: CamusTransactionOptions = Object.freeze({
  isolationLevel: CamusIsolationLevel.Serializable,
  mode: CamusTransactionMode.ReadOnly,
});

/** Fills every knob this object left unset from `fallback`. */
export function withDefaults(
  options: CamusTransactionOptions,
  fallback: CamusTransactionOptions | undefined,
): CamusTransactionOptions {
  if (fallback === undefined) return options;

  return {
    isolationLevel: options.isolationLevel ?? fallback.isolationLevel,
    mode: options.mode ?? fallback.mode,
    locking: options.locking ?? fallback.locking,
    affinity: options.affinity ?? fallback.affinity,
  };
}
