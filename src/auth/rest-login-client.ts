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

    const body = (text.length > 0 ? parseLossless(text) : null) as LoginResponseBody | null;

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
