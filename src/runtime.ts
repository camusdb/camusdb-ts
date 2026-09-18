/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusLoginClient } from './auth/login-client.js';
import { RestLoginClient } from './auth/rest-login-client.js';
import { CamusTokenProvider } from './auth/token-provider.js';
import type { ResolvedConfig } from './config.js';
import { CamusProtocol, CamusRoutingMode, deploymentKey, resolveBackupEndpoint } from './config.js';
import { CamusEndpointPool } from './endpoint-pool.js';
import { CamusPreparedStatementPolicy } from './prepared/policy.js';
import { CamusStatementRouter } from './routing/router.js';
import { AuthenticatingTransport } from './transport/authenticating-transport.js';
import { GrpcTransport } from './transport/grpc/grpc-transport.js';
import { RestTransport } from './transport/rest-transport.js';
import type { CamusTransport } from './transport/transport.js';
import { CamusTransportPool } from './transport/transport-pool.js';

/**
 * Everything a client runs on, assembled from its configuration.
 *
 * Four of these five objects are shared process-wide, keyed by what they actually depend on — see
 * `SharedRegistry` for why. The runtime is the one place that resolves those keys, so a client
 * never has to know which of its collaborators it owns and which it borrows.
 */
export class ClientRuntime {
  readonly config: ResolvedConfig;

  /** The endpoint rotation, shared by every client with the same endpoint list. */
  readonly pool: CamusEndpointPool;

  /** The bearer token, shared by every client presenting the same identity to this deployment. */
  readonly auth: CamusTokenProvider;

  /** The wire transport, shared by deployment, identity, and stream tuning. */
  readonly transport: CamusTransport;

  /** Which statements to prepare, shared by deployment and prepare settings. */
  readonly preparedStatements: CamusPreparedStatementPolicy;

  /** Learned routing, or `undefined` when routing is off — which is the default. */
  readonly router: CamusStatementRouter | undefined;

  /** The database statements run against. `changeDatabase` moves it. */
  database: string;

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.database = config.database;

    this.pool = CamusEndpointPool.forEndpoints(config.endpointList);

    const deployment = deploymentKey(config);

    this.auth = CamusTokenProvider.forKey(
      CamusTokenProvider.sharingKey(config.credentials, deployment),
      () =>
        new CamusTokenProvider({
          credentials: config.credentials,
          resolveLoginClient: () => this.loginClient(),
          resolveEndpoint: () => this.pool.next(),
          resolveTimeoutSeconds: () => config.timeoutSeconds,
          lifetimeMs: config.tokenLifetimeMs,
        }),
    );

    this.transport = CamusTransportPool.forKey(transportKey(config, deployment), () => {
      const inner: CamusTransport =
        config.protocol === CamusProtocol.Grpc
          ? new GrpcTransport(this.pool, this.auth, config.batch)
          : new RestTransport(this.pool, this.auth);

      // Wrapped unconditionally. With no credentials configured the wrapper is inert, and wrapping
      // every transport means a client that authenticates later is covered too.
      return new AuthenticatingTransport(inner, this.auth);
    });

    this.preparedStatements = CamusPreparedStatementPolicy.forKey(
      `${deployment}|${config.database}|${String(config.maxAutoPrepare)}|${String(config.autoPrepareMinUsages)}`,
      () => new CamusPreparedStatementPolicy(config.maxAutoPrepare, config.autoPrepareMinUsages),
    );

    this.router = this.buildRouter(deployment);
  }

  /** The request timeout in seconds. */
  get timeoutSeconds(): number {
    return this.config.timeoutSeconds;
  }

  /** The next endpoint in the rotation. */
  nextEndpoint(): string {
    return this.pool.next();
  }

  /** Where the backup admin API lives for this client. */
  backupEndpoint(): string {
    return resolveBackupEndpoint(this.config, this.pool);
  }

  /**
   * Who performs the credential exchange.
   *
   * A gRPC client uses the `CamusAuth` service on the transport's own channel; a REST client posts
   * to `/login`. Either way the token is obtained over the same protocol and endpoint that carries
   * the statements: there is no second port to configure and no hop between protocols.
   */
  private loginClient(): CamusLoginClient {
    const transport = this.transport;
    const inner = transport instanceof AuthenticatingTransport ? transport.inner : transport;

    return isLoginClient(inner) ? inner : new RestLoginClient();
  }

  /**
   * The router for this configuration, or `undefined` when routing is off.
   *
   * `learned` needs at least one mapped endpoint. `auto` — the default — needs at least two
   * distinct ones, because one destination is not a routing decision. So a configuration with no
   * trust map behaves exactly as `off`, and its requests are identical to a pre-routing driver's.
   */
  private buildRouter(deployment: string): CamusStatementRouter | undefined {
    const mode = this.config.routingMode;

    if (mode === CamusRoutingMode.Off) return undefined;

    const nodes = this.config.routingNodes;

    const enabled =
      mode === CamusRoutingMode.Learned
        ? nodes.size > 0
        : new Set([...nodes.values()].map((address) => address.toLowerCase())).size >= 2;

    if (!enabled) return undefined;

    const maxHintAge = this.config.routingMaxHintAgeMs;

    const routerKey = [
      deployment,
      mode,
      String(maxHintAge),
      [...nodes]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([nodeId, address]) => `${nodeId}=${address}`)
        .join(','),
    ].join('|');

    return CamusStatementRouter.forKey(
      routerKey,
      () => new CamusStatementRouter(nodes, this.pool, maxHintAge),
    );
  }
}

/**
 * Which transport a configuration may share: the deployment and the identity presented to it, so a
 * transport is never reused across servers, protocols, or users, plus the stream tuning, which
 * sizes a gRPC transport's pool and so cannot be applied to one that already exists.
 *
 * The credentials are hashed by the token provider's own key function rather than held in a
 * long-lived map key.
 */
function transportKey(config: ResolvedConfig, deployment: string): string {
  return [
    CamusTokenProvider.sharingKey(config.credentials, deployment),
    String(config.batch.channelPoolSize),
    String(config.batch.coalescingThreshold),
    String(config.batch.coalescingDelayMs),
  ].join('|');
}

function isLoginClient(value: unknown): value is CamusLoginClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CamusLoginClient).login === 'function' &&
    typeof (value as CamusLoginClient).logout === 'function'
  );
}
