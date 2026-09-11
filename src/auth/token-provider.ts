/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { createHmac, randomBytes } from 'node:crypto';

import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';
import { SharedRegistry } from '../shared-registry.js';
import type { CamusCredentials } from './credentials.js';
import { canRenew, credentialsFromPassword, hasCredentials } from './credentials.js';
import type { CamusLoginClient, CamusLoginResult } from './login-client.js';

/** The fallback token lifetime, comfortably inside the server's 15-minute default. */
export const DEFAULT_TOKEN_LIFETIME_MS = 600_000;

/**
 * Owns a client's bearer token: mints it from the configured credentials on first use, hands the
 * same token to every request until it goes stale, and mints a new one when it does.
 *
 * One provider is shared by every client that presents the same identity to the same deployment,
 * so a pool of clients performs one login rather than one each. Password verification is
 * deliberately expensive on the server — PBKDF2 with 600,000 iterations by default — and rate
 * limited per account, so a login stampede is exactly what must be avoided.
 *
 * **Single flight.** Concurrent callers that find no usable token await one promise; the winner
 * logs in and the rest observe its result instead of issuing their own login.
 *
 * **Renewal.** The login reply reports how long the token is good for, and the provider renews at
 * 80% of that. Against a server that predates the field it falls back to its own conservative
 * lifetime. That proactive renewal is the primary path. `invalidate`, driven by a `CADB0516` from
 * a real request, is the backstop for what a clock cannot predict: a rotated password, a dropped
 * user, a logout from elsewhere, or a server whose token lifetime is shorter than the fallback.
 *
 * A token supplied directly is used as written and never renewed — the driver has no password to
 * mint a replacement with — so a `CADB0516` on that path reaches the caller rather than a retry.
 */
export class CamusTokenProvider {
  private static readonly shared = new SharedRegistry<CamusTokenProvider>();

  /**
   * The process-wide provider for an identity, built on first use. Keyed by credentials rather
   * than by the whole configuration, so clients that differ only in database or timeout share one
   * token.
   */
  static forKey(key: string, factory: () => CamusTokenProvider): CamusTokenProvider {
    return CamusTokenProvider.shared.get(key, factory);
  }

  /** @internal Test hook: drops every shared provider. */
  static resetShared(): void {
    CamusTokenProvider.shared.clear();
  }

  /**
   * A per-process random salt for `sharingKey`.
   *
   * The key lives in a map for the life of the process, and an unsalted hash of a password is an
   * offline verifier for anyone who can read process memory. The key only has to be stable inside
   * one process, so a salt costs nothing.
   */
  private static readonly sharingSalt = randomBytes(32);

  /**
   * A stable, non-reversible identity for a credential set plus a deployment. It is hashed, and
   * salted per process, so a long-lived map key neither holds a plaintext password nor can be
   * tested against a guessed one outside this process.
   */
  static sharingKey(credentials: CamusCredentials, deploymentKey: string): string {
    const material = [
      credentials.user ?? '',
      credentials.password ?? '',
      credentials.accessToken ?? '',
      deploymentKey,
    ].join('\n');

    return createHmac('sha256', CamusTokenProvider.sharingSalt).update(material, 'utf8').digest('hex');
  }

  private credentials: CamusCredentials;

  private token: string | undefined;

  private renewAfter: number;

  private readonly resolveLoginClient: () => CamusLoginClient | Promise<CamusLoginClient>;

  private readonly resolveEndpoint: () => string;

  private readonly resolveTimeoutSeconds: () => number;

  private readonly lifetimeMs: number;

  /** The single login in flight, if any. Every racing caller awaits this same promise. */
  private inFlight: Promise<string> | undefined;

  /** @internal Test hook: the wall clock this provider reads. */
  clock: () => number = () => Date.now();

  constructor(init: {
    credentials: CamusCredentials;
    resolveLoginClient: () => CamusLoginClient | Promise<CamusLoginClient>;
    resolveEndpoint: () => string;
    resolveTimeoutSeconds: () => number;
    lifetimeMs?: number;
  }) {
    this.credentials = init.credentials;
    this.resolveLoginClient = init.resolveLoginClient;
    this.resolveEndpoint = init.resolveEndpoint;
    this.resolveTimeoutSeconds = init.resolveTimeoutSeconds;
    this.lifetimeMs = init.lifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS;

    // A token supplied directly is the cached token, and never ages out on this side.
    this.token = init.credentials.accessToken;
    this.renewAfter = Number.POSITIVE_INFINITY;
  }

  /**
   * True when this client has anything to authenticate with. When false the driver sends no
   * `Authorization` header, which is what a server with authentication off expects.
   */
  get isEnabled(): boolean {
    return hasCredentials(this.credentials);
  }

  /** True when the provider holds a password and can therefore replace a rejected token. */
  get canRenew(): boolean {
    return canRenew(this.credentials);
  }

  /**
   * The cached token, without triggering a login. The gRPC batch-stream factory reads it, because
   * it builds a stream synchronously; every such call site awaits `getToken` first, so the cache
   * is warm by then.
   */
  get currentToken(): string | undefined {
    return this.token;
  }

  /**
   * A usable bearer token, logging in when there is none or the cached one has aged out. Reports
   * `undefined` when no credentials are configured.
   */
  async getToken(signal?: AbortSignal): Promise<string | undefined> {
    const cached = this.tryGetCached();
    if (cached !== undefined) return cached;
    if (!this.isEnabled) return undefined;

    // A caller that arrives during a login awaits that login rather than issuing its own.
    this.inFlight ??= this.loginOnce(signal).finally(() => {
      this.inFlight = undefined;
    });

    return this.inFlight;
  }

  /**
   * Discards a token so the next `getToken` mints a new one.
   *
   * Comparing against the cached value keeps a late rejection of an already-replaced token from
   * throwing away the good one a concurrent caller just obtained. It does nothing when the token
   * cannot be renewed, so the caller reports the failure instead of looping.
   */
  invalidate(staleToken: string | undefined): void {
    if (staleToken === undefined || staleToken.length === 0) return;
    if (!this.canRenew) return;
    if (this.token !== staleToken) return;

    this.token = undefined;
    this.renewAfter = 0;
  }

  /**
   * Authenticates explicitly, replacing whatever credentials were configured, and reports the
   * minted token. Any cached token is dropped.
   */
  async login(user: string, password: string, signal?: AbortSignal): Promise<string> {
    this.credentials = credentialsFromPassword(user, password);
    this.token = undefined;
    this.renewAfter = 0;

    const pending = this.loginOnce(signal).finally(() => {
      this.inFlight = undefined;
    });

    this.inFlight = pending;
    return pending;
  }

  /**
   * Revokes the cached token on the server and forgets it. The configured credentials are kept, so
   * a later statement authenticates again on its own: this ends a session, it does not switch
   * authentication off. It does nothing when no token has been minted.
   */
  async logout(signal?: AbortSignal): Promise<void> {
    const revoked = this.token;

    this.token = undefined;
    this.renewAfter = 0;

    if (revoked === undefined || revoked.length === 0) return;

    const client = await this.resolveLoginClient();
    await client.logout(this.resolveEndpoint(), revoked, this.resolveTimeoutSeconds(), signal);
  }

  private tryGetCached(): string | undefined {
    if (!this.isEnabled) return undefined;
    if (this.token === undefined) return undefined;

    return this.clock() < this.renewAfter ? this.token : undefined;
  }

  private async loginOnce(signal: AbortSignal | undefined): Promise<string> {
    // Re-checked inside the single-flight gate: the caller that queued behind the winner finds the
    // token it minted.
    const cached = this.tryGetCached();
    if (cached !== undefined) return cached;

    if (!this.canRenew) {
      throw new CamusError(
        CamusErrorCode.AuthenticationFailed,
        'The supplied access token was rejected and this client has no credentials to obtain a new one.',
      );
    }

    const client = await this.resolveLoginClient();

    const minted: CamusLoginResult = await client.login(
      this.resolveEndpoint(),
      this.credentials.user!,
      this.credentials.password!,
      this.resolveTimeoutSeconds(),
      signal,
    );

    this.token = minted.token;
    this.renewAfter = this.clock() + this.renewalDelayMs(minted.expiresInMs);

    return minted.token;
  }

  /**
   * When to mint the next token.
   *
   * The server's reported lifetime is authoritative — its own setting is configurable and may be
   * shorter than any value the driver defaults to — so the provider renews at 80% of it, leaving
   * headroom for the request that carries the token to finish. Without a reported value it falls
   * back to the configured lifetime, which is already conservative.
   */
  private renewalDelayMs(reported: number | undefined): number {
    if (reported === undefined) return this.lifetimeMs;

    const renewal = reported * 0.8;
    return renewal > 0 ? renewal : 1000;
  }
}
