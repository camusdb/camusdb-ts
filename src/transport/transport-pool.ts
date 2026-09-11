/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { SharedRegistry } from '../shared-registry.js';
import type { CamusTransport } from './transport.js';

/**
 * The transports in use, one per deployment and identity rather than one per client object.
 *
 * A transport owns server-side state that outlives the request that created it:
 * prepared-statement registrations above all, and for gRPC a pool of long-lived streams and their
 * channels. An application that builds a client per request would otherwise get a fresh
 * registration cache every time — while the prepare policy, which is shared, reports a hot
 * statement as already registered. Each new transport would then register that statement again,
 * and nothing would close the ones it replaced, until the server's per-principal cap refused them
 * and every statement quietly fell back to inline execution.
 *
 * Sharing puts the registration cache on the same lifetime as the decision to prepare, which is
 * what the policy always assumed: one registration per statement per deployment, evicted by the
 * policy's own bound.
 *
 * A shared transport lives as long as the process. That is bounded by how many distinct
 * deployments and identities a process talks to, not by how many clients it opens.
 */
export class CamusTransportPool {
  private static readonly shared = new SharedRegistry<CamusTransport>();

  /** The transport for a key, built once per process. */
  static forKey(key: string, factory: () => CamusTransport): CamusTransport {
    return CamusTransportPool.shared.get(key, factory);
  }

  /**
   * Closes every shared transport and drops them.
   *
   * Call it when a process is shutting down and wants its gRPC channels released promptly. A later
   * client rebuilds whatever it needs, so this is never required for correctness.
   */
  static async closeAll(): Promise<void> {
    const transports = [...CamusTransportPool.shared.values()];

    CamusTransportPool.shared.clear();

    await Promise.allSettled(transports.map((transport) => transport.close()));
  }

  /** @internal Test hook: drops every shared transport without closing it. */
  static resetShared(): void {
    CamusTransportPool.shared.clear();
  }
}
