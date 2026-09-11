/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusEndpointPool } from '../endpoint-pool.js';
import { SharedRegistry } from '../shared-registry.js';
import type { CamusRoutingAdvice } from './advice.js';
import { CamusRoutingDisposition, ROUTING_ACCEPT_VERSION } from './advice.js';
import type { CamusRouteOpKind } from './route-cache.js';
import { CamusStatementRouteCache, routeKey } from './route-cache.js';

/**
 * Learned statement routing for one deployment: the operator-configured trust map from server node
 * identities to endpoint pool members, plus the bounded cache of learned routes.
 *
 * The trust map is the routing authority. Advice names an opaque node identity; it becomes a
 * destination only through this map, and only when the mapped address is a member of the endpoint
 * pool. So a response can never steer traffic, or credentials, anywhere the operator did not list,
 * and every routable address already passed the same validation the pool applies.
 *
 * A router is shared per deployment and routing configuration, for the same reason the endpoint
 * pool is: an application that builds a client per request would otherwise start cold every time
 * and never learn anything.
 */
export class CamusStatementRouter {
  private static readonly shared = new SharedRegistry<CamusStatementRouter>();

  private static readonly MAX_ENTRIES = 4096;

  private static readonly MAX_BYTES = 4 * 1024 * 1024;

  /** The process-wide router for a deployment-and-configuration key. */
  static forKey(key: string, factory: () => CamusStatementRouter): CamusStatementRouter {
    return CamusStatementRouter.shared.get(key, factory);
  }

  /** @internal Test hook: drops every shared router. */
  static resetShared(): void {
    CamusStatementRouter.shared.clear();
  }

  private readonly routes = new CamusStatementRouteCache(
    CamusStatementRouter.MAX_ENTRIES,
    CamusStatementRouter.MAX_BYTES,
  );

  private readonly nodeAddresses: ReadonlyMap<string, string>;

  private readonly pool: CamusEndpointPool;

  private readonly maxHintAgeMs: number;

  /** @internal Test hook: the monotonic clock this router reads. */
  clock: () => number = () => performance.now();

  constructor(nodeAddresses: ReadonlyMap<string, string>, pool: CamusEndpointPool, maxHintAgeMs: number) {
    this.nodeAddresses = nodeAddresses;
    this.pool = pool;
    this.maxHintAgeMs = Math.max(1, maxHintAgeMs);
  }

  /** How many destinations are currently learned. Diagnostic. */
  get learnedRouteCount(): number {
    return this.routes.size;
  }

  /**
   * The endpoint to prefer for a statement, or `undefined` to fall back to the pool's rotation.
   *
   * The returned `revision` must be handed back to `learn` for the same statement, so a reply that
   * arrives late cannot overwrite a route a faster reply already refreshed.
   */
  selectEndpoint(
    database: string,
    sql: string,
    kind: CamusRouteOpKind,
  ): { endpoint: string | undefined; revision: number } {
    const key = routeKey(database, sql, kind);
    const { nodeId, revision } = this.routes.tryGet(key, this.clock());

    if (nodeId === undefined) return { endpoint: undefined, revision };

    const address = this.nodeAddresses.get(nodeId);

    if (address === undefined) return { endpoint: undefined, revision };

    // A route pointing at a node that stopped answering falls back to rotation rather than
    // steering traffic at it.
    return { endpoint: this.pool.isQuarantined(address) ? undefined : address, revision };
  }

  /** Applies the advice a statement's reply carried. Unusable advice is dropped, never an error. */
  learn(
    database: string,
    sql: string,
    kind: CamusRouteOpKind,
    advice: CamusRoutingAdvice | undefined,
    observedRevision: number,
  ): void {
    if (advice === undefined || advice.version !== ROUTING_ACCEPT_VERSION) return;

    const key = routeKey(database, sql, kind);

    if (advice.disposition === CamusRoutingDisposition.Clear) {
      this.routes.clear(key, observedRevision);
      return;
    }

    if (
      advice.disposition !== CamusRoutingDisposition.Prefer ||
      !advice.parametersIndependentScope ||
      advice.preferredNodeId === undefined ||
      advice.maxAgeMs <= 0 ||
      !this.nodeAddresses.has(advice.preferredNodeId)
    ) {
      return;
    }

    const now = this.clock();
    const ttl = Math.min(advice.maxAgeMs, this.maxHintAgeMs);

    this.routes.learn(
      key,
      (database.length + sql.length) * 2,
      advice.preferredNodeId,
      advice.dependencyToken,
      now + ttl,
      observedRevision,
      now,
    );
  }
}
