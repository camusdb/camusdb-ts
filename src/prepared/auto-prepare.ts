/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';
import { isRetryable } from '../retry.js';
import type { ClientRuntime } from '../runtime.js';
import { isPreparableStatement } from '../statements.js';
import {
  PreparedResult,
  recordPreparedEviction,
  recordPreparedLookup,
  recordPreparedRegistration,
} from '../telemetry.js';
import { PrepareDecision } from './policy.js';
import type { EvictedStatement } from './policy.js';

/** What one statement's prepare step reads from its caller. */
export interface PrepareCallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutSeconds?: number | undefined;
}

/**
 * Whether this execution should name a prepared statement instead of carrying its SQL,
 * registering it first when this is the execution that tips it over the threshold.
 *
 * The registration is awaited rather than started in the background, because the whole point is
 * that this execution and the ones after it are cheap. Firing it off and running inline anyway
 * would leave a busy statement racing its own warm-up. It costs one extra round trip, once per
 * statement per endpoint.
 *
 * The caller passes the endpoint it already resolved. A REST handle is node-local and the pool
 * rotates, so registering against a freshly drawn endpoint would routinely prepare on one node
 * and execute on another — correct, because the transport re-registers where it lands, but a
 * wasted round trip every single time.
 */
export async function shouldPrepare(
  runtime: ClientRuntime,
  sql: string,
  endpoint: string,
  options: PrepareCallOptions,
): Promise<boolean> {
  const policy = runtime.preparedStatements;

  if (policy.isDisabled || !isPreparableStatement(sql)) return false;

  const { decision, evicted } = policy.decide(runtime.database, sql);

  releaseEvicted(runtime, endpoint, evicted);

  switch (decision) {
    case PrepareDecision.Yes:
      recordPreparedLookup(runtime.database, PreparedResult.Hit);
      return true;

    case PrepareDecision.Register: {
      const registered = await registerStatement(runtime, endpoint, runtime.database, sql, options);

      recordPreparedLookup(runtime.database, registered ? PreparedResult.Registered : PreparedResult.Miss);
      return registered;
    }

    default:
      recordPreparedLookup(runtime.database, PreparedResult.Miss);
      return false;
  }
}

/**
 * Registers a statement and records what happened, reporting whether it may now run prepared.
 *
 * A registration failure never reaches the caller: preparing is an optimization, and the
 * statement runs inline exactly as it would have if the driver had not tried. What the failure
 * does decide is whether to ask again. A refusal specific to this statement stops asking for that
 * statement; anything that says the node has no prepared-statement support at all stops asking
 * for every statement, because one round trip per distinct SQL to relearn that is worse than not
 * trying. A failure that never reached a verdict — a timeout, an unreachable node — drops the
 * entry instead, so one network blip does not cost this statement its registration for the life
 * of the process.
 */
export async function registerStatement(
  runtime: ClientRuntime,
  endpoint: string,
  database: string,
  sql: string,
  options: PrepareCallOptions,
): Promise<boolean> {
  const policy = runtime.preparedStatements;

  try {
    await runtime.transport.prepare(
      endpoint,
      database,
      sql,
      options.timeoutSeconds ?? runtime.timeoutSeconds,
      options.signal,
    );

    policy.markPrepared(database, sql);
    recordPreparedRegistration(database, PreparedResult.Success);
    return true;
  } catch (error) {
    // The caller's own cancellation is not a verdict on the statement, but the entry must not be
    // left mid-registration, or it would never be reconsidered.
    if (options.signal?.aborted === true) {
      policy.forget(database, sql);
      throw error;
    }

    // The statement is about to run inline and will report any real problem itself. The only
    // decision left here is whether asking again is worth a round trip.
    if (CamusError.is(error) && isUnsupported(error)) {
      policy.markRefused(database, sql);
      policy.disable();
      recordPreparedRegistration(database, PreparedResult.Unsupported, error);
      return false;
    }

    if (declinesStatement(error)) {
      policy.markRefused(database, sql);
      recordPreparedRegistration(database, PreparedResult.Refused, error);
    } else {
      policy.forget(database, sql);
    }

    return false;
  }
}

/**
 * Releases a statement the policy evicted, so the server stops holding a handle this client has
 * stopped using.
 *
 * It is best effort and off the caller's path: it is bookkeeping, not part of the statement being
 * run. It takes the endpoint the caller already resolved rather than drawing a new one, which
 * would rotate the pool as a side effect of housekeeping.
 */
export function releaseEvicted(
  runtime: ClientRuntime,
  endpoint: string,
  evicted: EvictedStatement | undefined,
): void {
  if (evicted === undefined) return;

  recordPreparedEviction(evicted.database);

  void runtime.transport.closePrepared(endpoint, evicted.database, evicted.sql).catch(() => undefined);
}

/**
 * The codes that say nothing about the statement itself.
 *
 * `Generic` covers a call that was sent and then lost, and every failure the driver could not
 * classify. The rest name the connection or the principal. A statement that meets one of these is
 * left reconsiderable: the next call site asks again.
 */
const UNINFORMATIVE_CODES = new Set<string>([
  CamusErrorCode.Generic,
  CamusErrorCode.EndpointUnreachable,
  CamusErrorCode.AuthenticationFailed,
  CamusErrorCode.InsufficientPrivilege,
  CamusErrorCode.TooManyAuthAttempts,
  CamusErrorCode.InsecureTransport,
]);

/**
 * True when the server gave a verdict on this statement, rather than the round trip failing.
 *
 * Only a verdict is terminal. A retryable condition, a transport failure, and an error the driver
 * did not raise itself all leave the question open.
 */
function declinesStatement(error: unknown): boolean {
  if (!CamusError.is(error)) return false;
  if (isRetryable(error)) return false;

  return !UNINFORMATIVE_CODES.has(error.code);
}

/**
 * True when a failure says the node does not implement prepared statements at all, rather than
 * declining this particular statement.
 *
 * Both spellings surface under the generic code, because a server old enough not to have the
 * feature is also too old to have a specific code for refusing it. A server that does have it
 * declines an individual statement with a `CADB05xx` code instead.
 *
 * It is a heuristic, and it is only ever used to answer "is asking again worth a round trip?".
 * Reading it wrong costs at most one wasted registration attempt per statement, never a failed
 * statement.
 */
function isUnsupported(error: CamusError): boolean {
  return (
    error.code === CamusErrorCode.Generic &&
    (error.message.includes('404') || error.message.toLowerCase().includes('unimplemented'))
  );
}
