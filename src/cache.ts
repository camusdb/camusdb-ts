/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusHlcTimestamp } from './hlc.js';
import { validateBareName } from './sql-syntax.js';

/** How the server resolved a cache-hinted `SELECT`. */
export const CamusCacheStatus = {
  /** The statement carried no hint, so the cache was not consulted. */
  None: 'none',
  /** A stored result answered the statement. */
  Hit: 'hit',
  /** No stored result answered it; this one may now be stored. */
  Miss: 'miss',
  /** The cache path was entered and abandoned. `bypassReason` says why. */
  Bypass: 'bypass',
  /** A stored result was past its age and was recomputed. */
  StaleRevalidated: 'stale-revalidated',
  /** The computed result was dropped before it could be stored. */
  EvictedBeforePublish: 'evicted-before-publish',
  /** A status this driver does not know. Read `rawStatus`. */
  Unknown: 'unknown',
} as const;

export type CamusCacheStatus = (typeof CamusCacheStatus)[keyof typeof CamusCacheStatus];

/**
 * What the server reported about a cache-hinted `SELECT`.
 *
 * It is present only when the statement entered the cache path, so `undefined` means the statement
 * carried no `{cache=…}` hint. A hinted statement that skipped the cache reports
 * `status: 'bypass'` with a `bypassReason`.
 */
export interface CamusCacheMetadata {
  /** The parsed status. */
  readonly status: CamusCacheStatus;

  /** The status exactly as the server wrote it. Read it when `status` is `unknown`. */
  readonly rawStatus?: string | undefined;

  /** Why the cache was skipped, or why the result was not stored. Absent otherwise. */
  readonly bypassReason?: string | undefined;

  /** The logical cache family from the hint. Always set when this object is present. */
  readonly name?: string | undefined;

  /** When a served result was computed. Present only on a hit. */
  readonly cachedAtHlc?: CamusHlcTimestamp | undefined;

  /** Roughly how old a served result is, in milliseconds. Present only on a hit. */
  readonly ageMs?: number | undefined;

  /** True when a stored result answered the statement. */
  readonly isHit: boolean;
}

/** Builds the public object from the parts a transport decoded. */
export function makeCacheMetadata(parts: {
  rawStatus?: string | undefined;
  bypassReason?: string | undefined;
  name?: string | undefined;
  cachedAtHlc?: CamusHlcTimestamp | undefined;
  ageMs?: number | undefined;
}): CamusCacheMetadata {
  const status = parseCacheStatus(parts.rawStatus);

  return {
    status,
    rawStatus: parts.rawStatus,
    bypassReason: parts.bypassReason,
    name: parts.name,
    cachedAtHlc: parts.cachedAtHlc,
    ageMs: parts.ageMs,
    isHit: status === CamusCacheStatus.Hit,
  };
}

function parseCacheStatus(status: string | undefined): CamusCacheStatus {
  switch (status) {
    case undefined:
      return CamusCacheStatus.None;
    case 'hit':
      return CamusCacheStatus.Hit;
    case 'miss':
      return CamusCacheStatus.Miss;
    case 'bypass':
      return CamusCacheStatus.Bypass;
    case 'stale-revalidated':
      return CamusCacheStatus.StaleRevalidated;
    case 'evicted-before-publish':
      return CamusCacheStatus.EvictedBeforePublish;
    default:
      return CamusCacheStatus.Unknown;
  }
}

const MAX_CACHE_NAME_LENGTH = 128;

/**
 * Builds the `{cache=…}` hint a `SELECT` carries to ask for its result to be cached.
 *
 * Put the returned text **immediately after the table reference**, and after its alias when it has
 * one. The hint applies to the whole statement, not only to the table it is attached to, and only
 * one hint per statement is allowed.
 *
 * ```ts
 * const hint = cacheHint('recent_orders', { ttlMs: 30_000 });
 * const result = await client.query(`SELECT id, total FROM orders ${hint} WHERE status = @status`, {
 *   status: 1,
 * });
 * ```
 *
 * @param name the logical cache family. It is written into the statement as a bare identifier, so
 * it must be one: a letter or an underscore, then letters, digits, or underscores. A hyphen, a dot
 * and a colon are all parse errors on the server, and are refused here rather than sent.
 * @param options.ttlMs how long a stored result stays fresh, in milliseconds.
 * @param options.strict when true, the server validates each hit against live storage.
 */
export function cacheHint(name: string, options?: { ttlMs?: number; strict?: boolean }): string {
  validateCacheFamilyIdentifier(name);

  let hint = `{cache=${name}`;

  if (options?.ttlMs !== undefined) {
    const ttl = options.ttlMs;

    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 2_147_483_647) {
      throw new RangeError('ttlMs must be a positive whole number of milliseconds below 2^31.');
    }

    hint += `, ttl=${String(ttl)}`;
  }

  if (options?.strict === true) hint += ', strict';

  return `${hint}}`;
}

/**
 * The statement that drops every cached result in one family, for the current database.
 *
 * The family name is a quoted string here rather than a bare identifier, so it accepts more than
 * `cacheHint` does — a name minted elsewhere, with a hyphen in it, can still be evicted.
 */
export function evictCacheStatement(name: string): string {
  validateBareName(name, MAX_CACHE_NAME_LENGTH, 'name');
  return `EVICT CACHE '${name}'`;
}

/**
 * Refuses a family name the server's hint grammar cannot read.
 *
 * The name goes into the statement as a bare identifier, with nothing around it to escape it, so a
 * character outside the identifier set is a parse error rather than an oddly named family. Refusing
 * it here reports the problem where the name was written, rather than as a syntax error naming a
 * column position.
 */
function validateCacheFamilyIdentifier(name: string): void {
  validateBareName(name, MAX_CACHE_NAME_LENGTH, 'name');

  if (!/^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(name)) {
    throw new TypeError(
      `The cache family '${name}' is not a bare identifier. A hint writes the name into the ` +
        'statement unquoted, so it must start with a letter or an underscore and hold only ' +
        'letters, digits, and underscores.',
    );
  }
}

/** The statement that drops every cached result for the current database. */
export function evictAllCacheStatement(): string {
  return 'EVICT CACHE ALL';
}
