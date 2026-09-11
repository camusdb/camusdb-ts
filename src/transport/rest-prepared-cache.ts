/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/** A statement the server registered over REST: its handle and its binding order. */
export interface RestPreparedStatement {
  readonly statementId: string;
  readonly parameterNames: readonly string[];
}

interface CacheKey {
  readonly endpoint: string;
  readonly database: string;
  readonly sql: string;
}

interface Entry {
  readonly pending: Promise<RestPreparedStatement>;

  /** The registration once it succeeded. It is what makes `invalidate` act at once. */
  resolved: RestPreparedStatement | undefined;
}

/**
 * The prepared-statement handles this transport holds, keyed by endpoint, database, and SQL.
 *
 * A REST handle is node-local: the node that minted it is the only one that knows it. So the
 * endpoint is part of the key, and a statement registered on three nodes has three entries.
 *
 * A registration in flight is stored as its promise, so concurrent first calls for the same
 * statement share one registration instead of racing to register it three times. Its result is
 * stored beside the promise once it arrives, so a caller that must drop a dead handle can do it
 * before its own next lookup — reading the promise instead would defer the drop by a microtask,
 * and the retry would then find and re-send the very handle it had just discarded.
 *
 * A registration that fails is dropped, so the next call tries again rather than inheriting a
 * poisoned entry forever.
 */
export class RestPreparedStatementCache {
  private readonly statements = new Map<string, Entry>();

  /** The registration for a statement, starting one when there is none. */
  async getOrAdd(
    key: CacheKey,
    register: () => Promise<RestPreparedStatement>,
  ): Promise<RestPreparedStatement> {
    const cacheKey = keyOf(key);

    for (;;) {
      const existing = this.statements.get(cacheKey);

      if (existing !== undefined) {
        try {
          return await existing.pending;
        } catch {
          // Whoever started it already reported the failure to its own caller. Drop the poisoned
          // entry and take a fresh turn rather than failing every later execution.
          this.remove(cacheKey, existing);
          continue;
        }
      }

      const pending = register();
      const entry: Entry = { pending, resolved: undefined };

      this.statements.set(cacheKey, entry);

      try {
        const statement = await pending;

        entry.resolved = statement;
        return statement;
      } catch (error) {
        this.remove(cacheKey, entry);
        throw error;
      }
    }
  }

  /** Drops a registration the server no longer honours, but only if it is still the current one. */
  invalidate(key: CacheKey, stale: RestPreparedStatement): void {
    const cacheKey = keyOf(key);
    const existing = this.statements.get(cacheKey);

    if (existing?.resolved === stale) this.remove(cacheKey, existing);
  }

  /**
   * Removes and reports every node's registration of one statement, so the caller can release each
   * handle on the node that minted it. A statement is closed everywhere it was registered, not
   * only where the caller happens to be sending.
   */
  async take(
    database: string,
    sql: string,
  ): Promise<{ endpoint: string; statement: RestPreparedStatement }[]> {
    const taken: { endpoint: string; statement: RestPreparedStatement }[] = [];

    for (const [cacheKey, entry] of [...this.statements]) {
      const parsed = parseKey(cacheKey);

      if (parsed.database !== database || parsed.sql !== sql) continue;

      this.statements.delete(cacheKey);

      try {
        taken.push({ endpoint: parsed.endpoint, statement: await entry.pending });
      } catch {
        // A registration that never succeeded has no handle to release.
      }
    }

    return taken;
  }

  private remove(cacheKey: string, expected: Entry): void {
    if (this.statements.get(cacheKey) === expected) this.statements.delete(cacheKey);
  }
}

// A newline cannot appear in an endpoint URL or a database name, so it separates the three parts
// without ambiguity — and the parts stay recoverable, which `take` needs.
function keyOf(key: CacheKey): string {
  return `${key.endpoint}\n${key.database}\n${key.sql}`;
}

function parseKey(cacheKey: string): CacheKey {
  const firstBreak = cacheKey.indexOf('\n');
  const secondBreak = cacheKey.indexOf('\n', firstBreak + 1);

  return {
    endpoint: cacheKey.slice(0, firstBreak),
    database: cacheKey.slice(firstBreak + 1, secondBreak),
    sql: cacheKey.slice(secondBreak + 1),
  };
}
