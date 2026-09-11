/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from './errors.js';
import { CamusErrorCode } from './error-codes.js';
import { SharedRegistry } from './shared-registry.js';

/**
 * The endpoints one deployment's clients rotate through, and which of them are set aside after
 * failing to answer at all.
 *
 * A pool is shared per endpoint list rather than owned by one client. The rotation and the health
 * it depends on are properties of the deployment; a per-client pool would restart its rotation at
 * the first endpoint on every request.
 *
 * Quarantine expires. A pool that outlives the request that marked an endpoint cannot mark it
 * forever: with a single endpoint configured — the common case — the first refused connection
 * would otherwise end the process's ability to reach the database at all, long after the node came
 * back. An endpoint is set aside for `QUARANTINE_PERIOD_MS` and then drawn again; a node that is
 * still down is simply marked again by the request that draws it, at a cost of one failed request
 * per period.
 */
export class CamusEndpointPool {
  /** How long an endpoint that failed at the transport level is passed over. */
  static readonly QUARANTINE_PERIOD_MS = 30_000;

  private static readonly shared = new SharedRegistry<CamusEndpointPool>();

  /**
   * The process-wide pool for an endpoint list, built on first use. Keyed by the list alone, so
   * clients that differ only in database, credentials, or timeout share one rotation and one view
   * of which nodes are answering.
   */
  static forEndpoints(endpointList: string): CamusEndpointPool {
    return CamusEndpointPool.shared.get(endpointList, () => new CamusEndpointPool(endpointList));
  }

  /** @internal Test hook: drops every shared pool. */
  static resetShared(): void {
    CamusEndpointPool.shared.clear();
  }

  private readonly endpoints: string[];

  /**
   * Monotonic-clock deadlines, indexed alongside `endpoints`. Zero — the initial value — is in the
   * past, so an endpoint that has never failed needs no special case.
   */
  private readonly quarantinedUntil: number[];

  private nextIndex = 0;

  /** @internal Test hook: the monotonic clock this pool reads. */
  clock: () => number = () => performance.now();

  constructor(endpointList: string) {
    this.endpoints = endpointList
      .split(',')
      .map((endpoint) => endpoint.trim())
      .filter((endpoint) => endpoint.length > 0);

    if (this.endpoints.length === 0) {
      throw new CamusError(CamusErrorCode.Generic, 'Endpoint is required.');
    }

    this.quarantinedUntil = new Array<number>(this.endpoints.length).fill(0);
  }

  /** Every configured endpoint, in the order it was written. */
  get members(): readonly string[] {
    return this.endpoints;
  }

  /**
   * The next endpoint to send to, skipping those in quarantine.
   *
   * When every endpoint is quarantined the one closest to leaving is returned rather than an
   * error. The deployment is evidently down, and letting the request go and fail against the real
   * node reports why, where a synthetic "no endpoints" would replace the server's diagnosis with
   * the driver's bookkeeping.
   */
  next(): string {
    const now = this.clock();
    let fallback = -1;

    for (let i = 0; i < this.endpoints.length; i++) {
      const index = this.nextIndex;
      this.nextIndex = (this.nextIndex + 1) % this.endpoints.length;

      if (this.quarantinedUntil[index]! <= now) return this.endpoints[index]!;

      if (fallback < 0 || this.quarantinedUntil[index]! < this.quarantinedUntil[fallback]!) {
        fallback = index;
      }
    }

    return this.endpoints[fallback === -1 ? 0 : fallback]!;
  }

  /**
   * Whether an endpoint is currently set aside. Learned routing reads it before preferring an
   * endpoint, so a route pointing at a node that stopped answering falls back to rotation. An
   * address the pool does not know reports as not quarantined.
   */
  isQuarantined(endpoint: string): boolean {
    const index = this.indexOf(endpoint);
    if (index < 0) return false;

    return this.quarantinedUntil[index]! > this.clock();
  }

  /**
   * Whether an address is one of the configured endpoints. The routing trust map uses it to refuse
   * mapping a node identity to any address the operator did not list.
   */
  contains(endpoint: string): boolean {
    return this.indexOf(endpoint) >= 0;
  }

  /** Sets an endpoint aside, so the endpoints that are answering carry the traffic meanwhile. */
  markUnreachable(endpoint: string): void {
    const index = this.indexOf(endpoint);
    if (index < 0) return;

    this.quarantinedUntil[index] = this.clock() + CamusEndpointPool.QUARANTINE_PERIOD_MS;
  }

  private indexOf(endpoint: string): number {
    const wanted = endpoint.toLowerCase();

    for (let i = 0; i < this.endpoints.length; i++) {
      if (this.endpoints[i]!.toLowerCase() === wanted) return i;
    }

    return -1;
  }
}
