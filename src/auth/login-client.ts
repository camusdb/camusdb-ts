/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * A minted bearer token and, when the server reported one, how long it is good for.
 *
 * `expiresInMs` is a duration rather than an instant on purpose: the server measures it when it
 * issues the reply, so a client whose clock disagrees with the server's still renews on time. It
 * is `undefined` against a server that predates the field, in which case the driver falls back to
 * its configured token lifetime.
 */
export interface CamusLoginResult {
  readonly token: string;
  readonly expiresInMs?: number | undefined;
}

/**
 * The credential-exchange half of the protocol.
 *
 * It is kept apart from the statement transport because it is the one exchange reachable without a
 * token: REST serves it at `/login`, gRPC on the dedicated `CamusAuth` service, and each transport
 * implements it against its own endpoint. Keeping it a separate interface makes that
 * unauthenticated surface explicit, and lets the token provider be tested without a server.
 */
export interface CamusLoginClient {
  /**
   * Exchanges a password for a short-lived bearer token.
   *
   * @throws {CamusError} `CADB0516` when the credentials are rejected.
   */
  login(
    endpoint: string,
    user: string,
    password: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CamusLoginResult>;

  /** Revokes a token on the server. */
  logout(endpoint: string, token: string, timeoutSeconds: number, signal?: AbortSignal): Promise<void>;
}
