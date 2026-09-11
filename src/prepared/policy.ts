/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { SharedRegistry } from '../shared-registry.js';

/** What the policy decided about one execution of a statement. */
export const PrepareDecision = {
  /** Run it inline. It is not hot enough yet, or it cannot be prepared. */
  No: 'no',
  /** Register it now, then run this execution prepared. */
  Register: 'register',
  /** It is already registered. Run this execution prepared. */
  Yes: 'yes',
} as const;

export type PrepareDecision = (typeof PrepareDecision)[keyof typeof PrepareDecision];

const EntryState = {
  Counting: 0,
  Registering: 1,
  Prepared: 2,
  Refused: 3,
} as const;

type EntryState = (typeof EntryState)[keyof typeof EntryState];

interface Entry {
  readonly database: string;
  readonly sql: string;
  usages: number;
  state: EntryState;
}

/** A statement the policy evicted, so the server can stop holding a handle nobody uses. */
export interface EvictedStatement {
  readonly database: string;
  readonly sql: string;
}

/**
 * Which statements a client prepares.
 *
 * Preparing costs one extra round trip and saves the SQL text and the parameter names on every
 * execution after it, so it pays for a statement that runs many times and wastes a round trip for
 * one that runs once. The policy is that counting: a statement is registered once it has been seen
 * `minUsages` times, and the `maxAutoPrepare` most recently used registrations are kept.
 *
 * The policy is shared per deployment and settings rather than owned by one client. Which
 * statements a workload repeats is a property of the workload, and an application that builds a
 * client per request would restart the counting every time and never conclude anything.
 *
 * Recency is a `Map`, which preserves insertion order: re-inserting a key moves it to the end, so
 * the first key the map yields is the least recently used one.
 */
export class CamusPreparedStatementPolicy {
  static readonly DEFAULT_MAX_AUTO_PREPARE = 128;

  static readonly DEFAULT_MIN_USAGES = 2;

  private static readonly shared = new SharedRegistry<CamusPreparedStatementPolicy>();

  /** The process-wide policy for a deployment-and-settings key. */
  static forKey(key: string, factory: () => CamusPreparedStatementPolicy): CamusPreparedStatementPolicy {
    return CamusPreparedStatementPolicy.shared.get(key, factory);
  }

  /** @internal Test hook: drops every shared policy. */
  static resetShared(): void {
    CamusPreparedStatementPolicy.shared.clear();
  }

  readonly maxAutoPrepare: number;

  readonly minUsages: number;

  private readonly entries = new Map<string, Entry>();

  private disabled: boolean;

  constructor(maxAutoPrepare: number, minUsages: number) {
    this.maxAutoPrepare = maxAutoPrepare;
    this.minUsages = Math.max(1, minUsages);
    this.disabled = maxAutoPrepare <= 0;
  }

  /** True when automatic preparation is off, either by configuration or because a server refused. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  /** How many statements are currently kept prepared. */
  get preparedCount(): number {
    let count = 0;

    for (const entry of this.entries.values()) {
      if (entry.state === EntryState.Prepared) count++;
    }

    return count;
  }

  /** Whether one statement is currently kept prepared. */
  isPrepared(database: string, sql: string): boolean {
    return this.entries.get(key(database, sql))?.state === EntryState.Prepared;
  }

  /** Decides what this execution should do, and reports a statement the decision evicted. */
  decide(database: string, sql: string): { decision: PrepareDecision; evicted?: EvictedStatement } {
    if (this.disabled) return { decision: PrepareDecision.No };

    const { entry, evicted } = this.touch(database, sql);

    switch (entry.state) {
      case EntryState.Prepared:
        return { decision: PrepareDecision.Yes, ...(evicted ? { evicted } : {}) };

      case EntryState.Refused:
        return { decision: PrepareDecision.No, ...(evicted ? { evicted } : {}) };

      case EntryState.Registering:
        // A registration is already in flight. Running inline meanwhile is correct rather than
        // merely tolerable: the statement is not registered yet.
        return { decision: PrepareDecision.No, ...(evicted ? { evicted } : {}) };

      default:
        if (++entry.usages < this.minUsages) {
          return { decision: PrepareDecision.No, ...(evicted ? { evicted } : {}) };
        }

        entry.state = EntryState.Registering;
        return { decision: PrepareDecision.Register, ...(evicted ? { evicted } : {}) };
    }
  }

  /**
   * Marks a statement for registration because the caller asked for it directly.
   *
   * An explicit request overrides an earlier refusal: the caller may well have fixed whatever made
   * it fail, and it is asking rather than being guessed at.
   */
  pin(database: string, sql: string): { decision: PrepareDecision; evicted?: EvictedStatement } {
    const { entry, evicted } = this.touch(database, sql);

    if (entry.state === EntryState.Prepared) {
      return { decision: PrepareDecision.Yes, ...(evicted ? { evicted } : {}) };
    }

    entry.state = EntryState.Registering;
    entry.usages = Math.max(entry.usages, this.minUsages);

    return { decision: PrepareDecision.Register, ...(evicted ? { evicted } : {}) };
  }

  /** Records that the server registered a statement. */
  markPrepared(database: string, sql: string): void {
    const entry = this.entries.get(key(database, sql));
    if (entry !== undefined) entry.state = EntryState.Prepared;
  }

  /** Records that this statement should not be offered for registration again. */
  markRefused(database: string, sql: string): void {
    const entry = this.entries.get(key(database, sql));
    if (entry !== undefined) entry.state = EntryState.Refused;
  }

  /** Stops offering any statement for registration. Used when a server has no support at all. */
  disable(): void {
    this.disabled = true;
  }

  /** Drops what is known about a statement, so it is reconsidered from the start. */
  forget(database: string, sql: string): void {
    this.entries.delete(key(database, sql));
  }

  private touch(database: string, sql: string): { entry: Entry; evicted?: EvictedStatement } {
    const entryKey = key(database, sql);
    const existing = this.entries.get(entryKey);

    if (existing !== undefined) {
      // Re-inserting moves the key to the end of the map's order, which is the recency list.
      this.entries.delete(entryKey);
      this.entries.set(entryKey, existing);
      return { entry: existing };
    }

    let evicted: EvictedStatement | undefined;

    if (this.entries.size >= this.maxAutoPrepare) {
      const oldestKey = this.entries.keys().next().value;

      if (oldestKey !== undefined) {
        const oldest = this.entries.get(oldestKey)!;
        this.entries.delete(oldestKey);

        // Only a registered statement is worth telling the caller about. The rest were never more
        // than a counter.
        if (oldest.state === EntryState.Prepared) {
          evicted = { database: oldest.database, sql: oldest.sql };
        }
      }
    }

    const entry: Entry = { database, sql, usages: 0, state: EntryState.Counting };
    this.entries.set(entryKey, entry);

    return { entry, ...(evicted ? { evicted } : {}) };
  }
}

// A newline cannot appear in a database name, so it separates the two parts without ambiguity.
function key(database: string, sql: string): string {
  return `${database}\n${sql}`;
}
