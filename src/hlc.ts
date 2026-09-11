/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * One instant on the cluster's hybrid logical clock, as a response envelope reports it.
 *
 * `l` is the physical component in milliseconds and `c` is the logical counter that orders events
 * inside one millisecond. The node dimension is not part of a cache report, so it is absent here.
 */
export interface CamusHlcTimestamp {
  readonly l: bigint;
  readonly c: number;
}

/** `l:c`, the form the server writes an instant in. */
export function formatHlc(timestamp: CamusHlcTimestamp): string {
  return `${timestamp.l.toString()}:${timestamp.c.toString()}`;
}
