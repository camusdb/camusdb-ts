/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusEndpointPool } from '../endpoint-pool.js';
import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';
import { parseLossless, stringifyLossless } from '../json.js';
import { sanitizeErrorText } from './error-text.js';

/** How one HTTP call is made. */
export interface HttpRequestInit {
  /** The base URL of the node to call. */
  readonly endpoint: string;

  /** Path segments appended to the base URL. */
  readonly path: readonly string[];

  readonly method: 'GET' | 'POST';

  /** The body, serialized with `stringifyLossless` so a 64-bit value stays exact. */
  readonly body?: unknown;

  /** Query string values. */
  readonly query?: Readonly<Record<string, string>> | undefined;

  /** The bearer token to present, when the client has one. */
  readonly token?: string | undefined;

  /** The `Accept` header. Defaults to `application/json`. */
  readonly accept?: string | undefined;

  /** How long to wait before giving up. Zero or less means no deadline. */
  readonly timeoutSeconds: number;

  /** The caller's own cancellation. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * An HTTP response whose body has not been read yet, and the deadline of its request.
 *
 * The deadline stays in force until `release` is called, so a body read before then is held to the
 * same timeout as the request. A caller must call `release` once, after the body is read or once it
 * hands the body to a stream reader that has no deadline.
 */
export interface HttpExchange {
  readonly status: number;
  readonly response: Response;

  /** The signal that ends the request, or `undefined` when it has no deadline and no caller signal. */
  readonly signal: AbortSignal | undefined;

  /** Clears the deadline and releases the caller's signal. Safe to call more than once. */
  readonly release: () => void;
}

/** A response with its body read as text. */
export interface HttpTextResponse {
  readonly status: number;
  readonly response: Response;
  readonly text: string;
}

/**
 * Sends one request and reports the response, whatever its status, with the deadline still in
 * force.
 *
 * A failure to reach the node at all — a refused connection, a DNS failure, a deadline — is turned
 * into a `CamusError` here, and the endpoint is set aside in the pool. A non-2xx status is left to
 * the caller, because only the caller knows whether the route treats one as an error.
 *
 * A cancellation the caller asked for is re-thrown as it is. It is not a database failure, the
 * node is not unreachable, and turning it into a `CamusError` would hide the caller's own intent.
 */
export async function openHttp(
  pool: CamusEndpointPool | undefined,
  init: HttpRequestInit,
): Promise<HttpExchange> {
  const url = buildUrl(init.endpoint, init.path, init.query);

  const headers: Record<string, string> = { Accept: init.accept ?? 'application/json' };
  let body: string | undefined;

  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = stringifyLossless(init.body);
  }

  if (init.token !== undefined && init.token.length > 0) {
    headers.Authorization = `Bearer ${init.token}`;
  }

  const { signal, dispose } = combineSignals(init.timeoutSeconds, init.signal);

  try {
    const response = await fetch(url, {
      method: init.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: signal ?? null,
      // A driver must never follow a redirect: a redirected statement would leave the endpoint the
      // operator configured, taking its bearer token with it.
      redirect: 'error',
    });

    return { status: response.status, response, signal, release: dispose };
  } catch (error) {
    dispose();

    // The caller ended the request. That is not a transport failure and the node is fine.
    if (init.signal?.aborted === true) throw error;

    pool?.markUnreachable(init.endpoint);

    throw new CamusError(CamusErrorCode.Generic, describeTransportFailure(url, error), { cause: error });
  }
}

/**
 * Sends one request and reads its whole body as text, whatever the status.
 *
 * The request's deadline covers the body as well as the headers. Without that, a server that
 * sends its headers and then sends the body slowly, or never ends it, would hold the call open
 * with no limit. A body that misses the deadline sets the endpoint aside, as a request that
 * misses it does.
 */
export async function sendHttpText(
  pool: CamusEndpointPool | undefined,
  init: HttpRequestInit,
): Promise<HttpTextResponse> {
  const exchange = await openHttp(pool, init);

  try {
    const text = await readBody(exchange.response, MAX_RESPONSE_BODY_BYTES, exchange.signal);

    return { status: exchange.status, response: exchange.response, text };
  } catch (error) {
    if (exchange.signal?.aborted === true && init.signal?.aborted !== true) {
      pool?.markUnreachable(init.endpoint);
    }

    throw error;
  } finally {
    exchange.release();
  }
}

/**
 * Sends a request and reads a JSON body. A non-2xx status becomes a `CamusError`.
 *
 * `refine`, when given, gets the parsed body and its text, and gives the body to return. A caller
 * uses it to parse again a body whose cells need their source text.
 */
export async function sendJson<T>(
  pool: CamusEndpointPool | undefined,
  init: HttpRequestInit,
  refine?: (parsed: unknown, text: string) => unknown,
): Promise<T> {
  const { response, text } = await sendHttpText(pool, init);

  if (!response.ok) throw translateErrorBody(response.status, text);

  if (text.length === 0) {
    throw new CamusError(CamusErrorCode.Generic, 'Empty result returned');
  }

  try {
    const parsed = parseLossless(text);
    return (refine === undefined ? parsed : refine(parsed, text)) as T;
  } catch (error) {
    // Distinct from the empty body above: something arrived, and it is not JSON. A caller that
    // sees this is looking at a proxy page or a truncated reply, not at a missing result.
    throw new CamusError(CamusErrorCode.Generic, 'The server returned a body that is not valid JSON.', {
      cause: error,
    });
  }
}

/**
 * Turns a failed HTTP call into a `CamusError`.
 *
 * The server's `{status, code, message}` body is preferred — it carries the `CADBxxxx` code the
 * client layer keys its retry and refresh decisions off — falling back to the raw response text
 * and finally to the status line. Every message the far end supplied goes through
 * `sanitizeErrorText` first: the text ends in an exception that applications log verbatim, and
 * none of it is this driver's.
 */
export function translateErrorBody(status: number, text: string): CamusError {
  if (text.length > 0) {
    try {
      const body = parseLossless(text);

      if (typeof body === 'object' && body !== null) {
        const record = body as { code?: unknown; message?: unknown };

        if (typeof record.code === 'string' || typeof record.message === 'string') {
          return new CamusError(
            typeof record.code === 'string' ? record.code : CamusErrorCode.Generic,
            sanitizeErrorText(typeof record.message === 'string' ? record.message : ''),
          );
        }
      }
    } catch {
      // Not a JSON error envelope. The raw text is the next best diagnosis.
    }

    return new CamusError(CamusErrorCode.Generic, sanitizeErrorText(text));
  }

  return new CamusError(CamusErrorCode.Generic, `The server answered HTTP ${String(status)} with no body.`);
}

/**
 * The largest response body read into memory. Every byte of a server's body is the far end's
 * choice, so without a limit a hostile or broken server could make the client allocate until the
 * process fails. A result larger than this belongs on the streaming query route.
 */
export const MAX_RESPONSE_BODY_BYTES = 256 * 1024 * 1024;

/**
 * Reads a body as text, reporting an empty string when it cannot be read.
 *
 * `signal` is the signal of the request. When it ended the read, its reason is thrown rather than
 * an empty body: the timeout's `CamusError`, or the caller's own cancellation as it is.
 *
 * @throws {CamusError} when the body is larger than `limit` bytes. The read stops at the limit and
 * the rest of the body is discarded.
 */
export async function readBody(
  response: Response,
  limit = MAX_RESPONSE_BODY_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);

  if (Number.isFinite(declared) && declared > limit) {
    await discard(response.body as ReadableStream<Uint8Array> | null);
    throw bodyTooLarge(limit);
  }

  if (response.body === null) return '';

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      received += value.byteLength;

      if (received > limit) break;

      chunks.push(value);
    }
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? error;
    return '';
  } finally {
    if (received > limit) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (received > limit) throw bodyTooLarge(limit);

  return decodeUtf8(chunks, received);
}

function bodyTooLarge(limit: number): CamusError {
  return new CamusError(
    CamusErrorCode.Generic,
    `The server returned a body larger than ${String(limit)} bytes, which this client does not read ` +
      'into memory. Read a large result with the streaming query API.',
  );
}

async function discard(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The stream is already gone. Nothing is left to release.
  }
}

/** Decodes the chunks as one UTF-8 text, as `Response.text()` does. */
function decodeUtf8(chunks: readonly Uint8Array[], length: number): string {
  if (chunks.length === 1) return new TextDecoder('utf-8').decode(chunks[0]);

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder('utf-8').decode(bytes);
}

function buildUrl(
  endpoint: string,
  path: readonly string[],
  query: Readonly<Record<string, string>> | undefined,
): string {
  let base = endpoint.trim();
  if (!base.endsWith('/')) base += '/';

  const url = new URL(path.map((segment) => encodeURIComponent(segment)).join('/'), base);

  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  }

  return url.toString();
}

/**
 * One signal that ends the request when either the deadline passes or the caller cancels.
 *
 * `AbortSignal.any` keeps a strong reference to its inputs, and a timeout signal keeps a timer
 * alive, so both are released once the request settles.
 */
function combineSignals(
  timeoutSeconds: number,
  callerSignal: AbortSignal | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  const hasTimeout = timeoutSeconds > 0;

  if (!hasTimeout) return { signal: callerSignal, dispose: () => undefined };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new CamusError(CamusErrorCode.Generic, `The request timed out after ${String(timeoutSeconds)}s.`),
    );
  }, timeoutSeconds * 1000);

  // Node keeps the process alive for a pending timer; a driver's deadline must not do that.
  timer.unref?.();

  if (callerSignal === undefined) {
    return { signal: controller.signal, dispose: () => clearTimeout(timer) };
  }

  const onAbort = (): void => controller.abort(callerSignal.reason);

  if (callerSignal.aborted) onAbort();
  else callerSignal.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal.removeEventListener('abort', onAbort);
    },
  };
}

function describeTransportFailure(url: string, error: unknown): string {
  // The URL is this driver's own, not the far end's, so it is safe to name. The error text is not:
  // fetch puts the request URL, and sometimes headers, in its own message.
  const detail = error instanceof Error ? sanitizeErrorText(error.message) : '';
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause?.code;

  const host = safeHost(url);

  if (cause !== undefined) return `Cannot reach ${host}: ${cause}`;

  return detail.length > 0 ? `Cannot reach ${host}: ${detail}` : `Cannot reach ${host}.`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'the CamusDB endpoint';
  }
}
