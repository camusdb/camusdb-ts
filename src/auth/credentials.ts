/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * What the driver was given to authenticate with.
 *
 * Either a user and password pair, which the driver exchanges for a short-lived bearer token and
 * re-exchanges when the token expires, or a token the caller obtained elsewhere and hands over as
 * written. A value with neither is `NO_CREDENTIALS`: the driver sends no `Authorization` header at
 * all, which is correct against a server with authentication off — the default.
 */
export interface CamusCredentials {
  /** The user to authenticate as, or undefined when a token was supplied directly. */
  readonly user?: string | undefined;

  /** The user's password. It is only ever sent to `/login`, never with an ordinary statement. */
  readonly password?: string | undefined;

  /** A token obtained elsewhere, used as written. It excludes `user`. */
  readonly accessToken?: string | undefined;
}

export const NO_CREDENTIALS: CamusCredentials = Object.freeze({});

export function credentialsFromPassword(user: string, password: string): CamusCredentials {
  return { user, password };
}

export function credentialsFromToken(accessToken: string): CamusCredentials {
  return { accessToken };
}

/** True when there is anything to authenticate with. */
export function hasCredentials(credentials: CamusCredentials): boolean {
  return (
    (credentials.user !== undefined && credentials.user.length > 0) ||
    (credentials.accessToken !== undefined && credentials.accessToken.length > 0)
  );
}

/** True when the driver can mint a fresh token on its own, because it holds the password. */
export function canRenew(credentials: CamusCredentials): boolean {
  return credentials.user !== undefined && credentials.user.length > 0 && credentials.password !== undefined;
}
