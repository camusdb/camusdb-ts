/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * A bounded, process-wide registry of objects that several clients share.
 *
 * Four kinds of driver state outlive the client that created it: the endpoint rotation and the
 * health it depends on, the bearer token, the transport that holds prepared-statement
 * registrations, and the learned-route cache. Each is a property of a deployment, not of one
 * client object, and an application that builds a client per request would otherwise start every
 * one of them cold — a multi-endpoint deployment would send all its traffic to one node, and every
 * request would perform its own login against a per-account rate limit.
 *
 * Past `maxEntries` a caller gets an unshared object rather than growing a map nothing empties.
 * Sharing is an optimization, so the cap trades that optimization for a bound on a process that
 * talks to unboundedly many deployments or identities.
 */
export class SharedRegistry<T> {
  private readonly entries = new Map<string, T>();

  private readonly maxEntries: number;

  constructor(maxEntries = 1024) {
    this.maxEntries = maxEntries;
  }

  /** The shared object for `key`, built on first use. */
  get(key: string, factory: () => T): T {
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;

    const created = factory();

    if (this.entries.size >= this.maxEntries) return created;

    // A racing caller cannot exist: this runs on one thread and `factory` is synchronous.
    this.entries.set(key, created);
    return created;
  }

  /** Every shared object. Used to shut a process down cleanly. */
  values(): IterableIterator<T> {
    return this.entries.values();
  }

  /** Drops every entry. Tests use it to isolate one case from the next. */
  clear(): void {
    this.entries.clear();
  }
}
