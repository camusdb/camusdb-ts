/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/** Whether a statement was a query or a write. A route is learned per kind. */
export const CamusRouteOpKind = {
  Query: 0,
  NonQuery: 1,
} as const;

export type CamusRouteOpKind = (typeof CamusRouteOpKind)[keyof typeof CamusRouteOpKind];

interface Entry {
  nodeId: string;
  dependencyToken: string | undefined;
  expiresAt: number;
  revision: number;
  lastTouched: number;
  bytes: number;
}

/**
 * The bounded cache of destinations learned for statements.
 *
 * Each entry is keyed by database, exact SQL text, and statement kind, and holds a node identity
 * with an expiry measured on a monotonic clock. Two properties matter beyond ordinary caching:
 *
 * - A late reply cannot overwrite a newer route. Every read reports the entry's revision, and a
 *   write applies only when the revision it observed is still the current one. Two replies for the
 *   same statement can arrive out of order, and the older one must not win.
 * - The cache is bounded twice, by entry count and by retained bytes. SQL text is unbounded in
 *   length, so a count alone does not bound memory.
 */
export class CamusStatementRouteCache {
  private readonly entries = new Map<string, Entry>();

  private readonly maxEntries: number;

  private readonly maxBytes: number;

  private retainedBytes = 0;

  private revisionSeq = 0;

  constructor(maxEntries: number, maxBytes: number) {
    this.maxEntries = Math.max(1, maxEntries);
    this.maxBytes = Math.max(1, maxBytes);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * The node identity learned for a statement, and the revision that read observed. A miss, an
   * expired entry, and an entry that was never written all report `undefined` with revision 0.
   */
  tryGet(key: string, now: number): { nodeId: string | undefined; revision: number } {
    const entry = this.entries.get(key);

    if (entry === undefined) return { nodeId: undefined, revision: 0 };

    if (now >= entry.expiresAt) {
      this.remove(key, entry);
      return { nodeId: undefined, revision: 0 };
    }

    entry.lastTouched = now;
    return { nodeId: entry.nodeId, revision: entry.revision };
  }

  /**
   * Records a destination, but only when the caller's observed revision still matches. A first
   * write must observe revision 0, which is what a read of an absent entry reports.
   */
  learn(
    key: string,
    keyBytes: number,
    nodeId: string,
    dependencyToken: string | undefined,
    expiresAt: number,
    observedRevision: number,
    now: number,
  ): void {
    const existing = this.entries.get(key);

    if (existing !== undefined && existing.revision !== observedRevision) return;
    if (existing === undefined && observedRevision !== 0) return;

    const entry: Entry = existing ?? {
      nodeId,
      dependencyToken,
      expiresAt,
      revision: 0,
      lastTouched: now,
      bytes: 0,
    };

    if (existing !== undefined) this.retainedBytes -= existing.bytes;
    else this.entries.set(key, entry);

    entry.nodeId = nodeId;
    entry.dependencyToken = dependencyToken;
    entry.expiresAt = expiresAt;
    entry.revision = ++this.revisionSeq;
    entry.lastTouched = now;
    entry.bytes = keyBytes + (nodeId.length + (dependencyToken?.length ?? 0)) * 2 + 64;

    this.retainedBytes += entry.bytes;
    this.evict(now);
  }

  /** Forgets a destination, but only when the caller's observed revision still matches. */
  clear(key: string, observedRevision: number): void {
    const entry = this.entries.get(key);

    if (entry !== undefined && entry.revision === observedRevision) this.remove(key, entry);
  }

  private remove(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.retainedBytes -= entry.bytes;
  }

  private evict(now: number): void {
    if (this.entries.size <= this.maxEntries && this.retainedBytes <= this.maxBytes) return;

    // Expired entries first: they are free to drop and cost a live route nothing.
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.remove(key, entry);
    }

    while (this.entries.size > this.maxEntries || this.retainedBytes > this.maxBytes) {
      let victimKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;

      for (const [key, entry] of this.entries) {
        if (entry.lastTouched < oldest) {
          oldest = entry.lastTouched;
          victimKey = key;
        }
      }

      if (victimKey === undefined) return;

      const victim = this.entries.get(victimKey);
      if (victim === undefined) return;

      this.remove(victimKey, victim);
    }
  }
}

/** The cache key for one statement. The separator cannot appear in a kind or a database name. */
export function routeKey(database: string, sql: string, kind: CamusRouteOpKind): string {
  return `${String(kind)} ${database} ${sql}`;
}
