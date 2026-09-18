/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { GrpcStatusError } from './proto.js';

/**
 * Whether a gRPC failure says the endpoint is down, and whether the request that hit it ever left
 * the client.
 *
 * The REST transport always set a node aside after a failure to reach it. The gRPC transport did
 * not: it translated the failure and drew the same node again, and learned routing kept preferring
 * it. A leader kill therefore produced a storm of refused connections, not a failover.
 *
 * The two questions are separate, and this module answers each one on its own. A connection that
 * died under a call in flight is good evidence that the node is gone, but it leaves that call's
 * outcome unknown. The caller must never be told "never sent" about a commit that may have landed.
 */

/** grpc-js reports `UNAVAILABLE` as status code 14. */
const GRPC_STATUS_UNAVAILABLE = 14;

/**
 * Detail fragments grpc-js writes when the connection died under a call that was already sent.
 *
 * Their outcome is unknown, so they keep the generic code. The node is gone all the same, and the
 * pool must learn it: after a leader kill the batcher's open streams die first, and its reconnect
 * is what finally produces the refused connection. To wait for the refused connection alone leaves
 * seconds in which every statement still goes to the dead node.
 */
const IN_FLIGHT_LOSS_MARKERS = ['connection dropped', 'write error:', 'write failed with error'];

/**
 * Detail fragments grpc-js writes before any byte goes out: the picker had no ready connection,
 * the name did not resolve, or the socket was refused. `No connection established` carries the
 * underlying Node error as `Last error:`, and the socket codes are listed as well, because a
 * different load balancer or resolver can report one without that wrapper.
 */
const CONNECT_FAILURE_MARKERS = [
  'no connection established',
  'name resolution failed',
  'subchannel not ready',
  'failed to connect before the deadline',
  'econnrefused',
  'ehostunreach',
  'enetunreach',
  'enotfound',
  'eai_again',
  'eaddrnotavail',
  'etimedout',
];

/**
 * Whether the endpoint could not be connected to at all.
 *
 * This is the narrow question. It is true only for the shapes the runtime produces before any byte
 * goes out, so a caller told "never sent" can retry the work elsewhere in safety. A server that
 * answered with `UNAVAILABLE` — one node reporting that a peer did not answer — is not this, and
 * neither is a call that was sent and then lost.
 */
export function isEndpointUnreachable(error: GrpcStatusError): boolean {
  if (error.code !== GRPC_STATUS_UNAVAILABLE) return false;

  const detail = statusDetail(error);

  // A call that was sent and then lost its connection is NOT this. Its outcome is unknown, and a
  // caller told "never sent" would retry a commit that may already be durable. The .NET driver's
  // run lk5 (2026-09-15) did exactly that when a reset socket was accepted here on the strength of
  // its socket error code: 37 rows carried commits the client had written off.
  if (IN_FLIGHT_LOSS_MARKERS.some((marker) => detail.includes(marker))) return false;

  return CONNECT_FAILURE_MARKERS.some((marker) => detail.includes(marker));
}

/**
 * Whether the endpoint is down, for the pool's purposes.
 *
 * This is the wide question, and it is what quarantine reads. It adds the connections that died
 * under a call in flight to the connections that never opened. Both mean the node stopped
 * answering, and every request routed there before the pool learns it fails the same way.
 */
export function indicatesEndpointDown(error: GrpcStatusError): boolean {
  if (isEndpointUnreachable(error)) return true;
  if (error.code !== GRPC_STATUS_UNAVAILABLE) return false;

  const detail = statusDetail(error);

  return IN_FLIGHT_LOSS_MARKERS.some((marker) => detail.includes(marker));
}

/**
 * The failure text to classify, folded to lower case.
 *
 * `details` holds the status detail on its own. `message` prefixes it with the status code and
 * name, and is the fallback for a rejection that carries no detail.
 */
function statusDetail(error: GrpcStatusError): string {
  const detail = error.details ?? '';

  return (detail.length > 0 ? detail : error.message).toLowerCase();
}
