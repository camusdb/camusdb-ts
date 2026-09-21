/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';
import { asNumber, parseLossless } from '../json.js';
import { readBody, sendHttp, translateErrorBody } from '../transport/http.js';
import type { CamusLoginClient, CamusLoginResult } from './login-client.js';

interface LoginResponseBody {
  status?: string;
  token?: string;
  expiresAtUnixMs?: number | bigint;
  expiresInSeconds?: number | bigint;
  code?: string;
  message?: string;
}

/**
 * The login client over the server's HTTP `/login` and `/logout` routes — the only routes exempt
 * from the server's own authentication middleware, and the only place a password is ever put on
 * the wire.
 */
export class RestLoginClient implements CamusLoginClient {
  async login(
    endpoint: string,
    user: string,
    password: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CamusLoginResult> {
    const { response } = await sendHttp(undefined, {
      endpoint,
      path: ['login'],
      method: 'POST',
      body: { user, password },
      timeoutSeconds,
      signal,
    });

    const text = await readBody(response);

    if (!response.ok) throw translateErrorBody(response.status, text);

    if (text.length === 0) {
      // A 200 with nothing in it is a broken reply, not a rejected credential. Reporting it as
      // `AuthenticationFailed` would make the provider throw away a token the server never
      // refused.
      throw new CamusError(CamusErrorCode.Generic, 'The login endpoint returned an empty body.');
    }

    let body: LoginResponseBody | null;

    try {
      body = parseLossless(text) as LoginResponseBody | null;
    } catch (error) {
      throw new CamusError(
        CamusErrorCode.Generic,
        'The login endpoint returned a body that is not valid JSON.',
        {
          cause: error,
        },
      );
    }

    if (body === null || body.status !== 'ok' || body.token === undefined || body.token.length === 0) {
      throw new CamusError(
        body?.code ?? CamusErrorCode.AuthenticationFailed,
        body?.message ?? 'Authentication failed',
      );
    }

    return { token: body.token, expiresInMs: readExpiryMs(body) };
  }

  async logout(endpoint: string, token: string, timeoutSeconds: number, signal?: AbortSignal): Promise<void> {
    const { response } = await sendHttp(undefined, {
      endpoint,
      path: ['logout'],
      method: 'POST',
      token,
      timeoutSeconds,
      signal,
    });

    if (!response.ok) throw translateErrorBody(response.status, await readBody(response));

    // The body carries nothing this driver reads, but it must be drained so the connection returns
    // to the pool instead of staying half-read.
    await readBody(response);
  }
}

/**
 * How long a minted token is good for.
 *
 * The server-measured duration is preferred, because it is immune to clock skew between client and
 * server. The absolute instant is the fallback, and it is not. A server that reports neither leaves
 * the driver on its configured fallback lifetime. A value that is not positive is treated as
 * absent rather than as an already-dead token.
 */
function readExpiryMs(body: LoginResponseBody): number | undefined {
  const seconds = asNumber(body.expiresInSeconds, 0);

  if (seconds > 0) return seconds * 1000;

  const expiresAt = asNumber(body.expiresAtUnixMs, 0);

  if (expiresAt > 0) {
    const remaining = expiresAt - Date.now();
    if (remaining > 0) return remaining;
  }

  return undefined;
}
