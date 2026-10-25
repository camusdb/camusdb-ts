/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { ColumnType } from '../../column-type.js';
import type { ColumnValue } from '../../column-value.js';
import { NULL_VALUE } from '../../column-value.js';
import { CamusError } from '../../errors.js';
import { CamusErrorCode } from '../../error-codes.js';
import type { CamusRowSource } from '../../row-source.js';
import { decodeCell, readResultSchema } from './codec.js';
import type { GrpcQueryStreamMessage, GrpcResultRow } from './messages.js';
import type { GrpcMetadata, GrpcServerStreamCall, GrpcStatusError } from './proto.js';

const GRPC_STATUS_DEADLINE_EXCEEDED = 4;

/** What a `GrpcStreamRowSource` needs from the transport that opened its call. */
export interface GrpcStreamRowSourceOptions {
  /** Bounds each wait for the next message, in seconds. Zero or less waits without a limit. */
  readonly timeoutSeconds: number;

  /** The caller's cancellation. It cancels the call, and the read reports its reason. */
  readonly signal?: AbortSignal | undefined;

  /** Turns a gRPC failure into the `CamusError` a buffered call would have thrown. */
  readonly translate: (error: GrpcStatusError) => CamusError;

  /** Handed the call's trailers once the stream ended cleanly, for the causal token. */
  readonly observeTrailers?: ((trailers: GrpcMetadata) => void) | undefined;
}

/**
 * Rows pulled from the server-streaming `CamusSql.ExecuteQuery` RPC one message at a time, so a
 * large result never fully materializes on this side. The wire order is:
 *
 * ```
 * ResultSchema                      ← exactly one, read by `create`, even for an empty result
 * ResultRow, ResultRow, …           ← one message per row, as the server's cursor produces them
 * CacheMetadata / RoutingAdvice     ← optional, after the last row; a stream does not expose them
 * trailers                          ← the causal token of an autocommit statement, or the error
 * ```
 *
 * The batched path (`BatchExecute`) cannot do this. The batcher completes an operation only once
 * every row has arrived, so a streamed read through it held the whole result in memory. A call of
 * its own also gives HTTP/2 flow control back to the reader: when the caller stops reading, the
 * server's writes wait instead of queueing.
 *
 * Failure: an autocommit statement commits after its last row, so a conflict can surface after
 * rows were already read. The server reports it as the call's status, and the read that reaches
 * the end raises it as a `CamusError`.
 *
 * Timeout: each wait for the next message is bounded by the statement timeout on its own, not the
 * call as a whole. A dump of a large table can take longer than any sensible timeout while the
 * server answers steadily; what the timeout has to catch is a server that stopped answering. The
 * time the caller spends between reads is not counted.
 */
export class GrpcStreamRowSource implements CamusRowSource {
  readonly recordsAffected = -1;

  private names: readonly string[] = [];

  private types: readonly ColumnType[] = [];

  private readonly call: GrpcServerStreamCall<GrpcQueryStreamMessage>;

  private readonly messages: AsyncIterator<GrpcQueryStreamMessage>;

  private readonly options: GrpcStreamRowSourceOptions;

  private readonly onAbort: () => void;

  private trailers: GrpcMetadata | undefined;

  /** The call reported its status, so nothing is left to cancel. */
  private settled = false;

  private finished = false;

  private closed = false;

  private constructor(
    call: GrpcServerStreamCall<GrpcQueryStreamMessage>,
    options: GrpcStreamRowSourceOptions,
  ) {
    this.call = call;
    this.options = options;
    this.messages = call[Symbol.asyncIterator]();
    this.onAbort = () => call.cancel();

    // A call that is cancelled after its iterator let go of it still emits an error. Without a
    // listener of its own, that error would be raised as an uncaught `error` event.
    call.on('error', () => undefined);

    // grpc-js reports the status before the iterator sees the end, so the trailers are here by
    // the time the last read returns.
    call.on('status', (status) => {
      this.settled = true;
      this.trailers = status.metadata;
    });
  }

  /**
   * Reads the schema and reports a source positioned before the first row. It takes ownership of
   * `call`: the call is cancelled here if this fails, and with the source otherwise.
   */
  static async create(
    call: GrpcServerStreamCall<GrpcQueryStreamMessage>,
    options: GrpcStreamRowSourceOptions,
  ): Promise<GrpcStreamRowSource> {
    const source = new GrpcStreamRowSource(call, options);

    try {
      if (options.signal !== undefined) {
        if (options.signal.aborted) throw options.signal.reason;

        options.signal.addEventListener('abort', source.onAbort, { once: true });
      }

      const first = await source.nextMessage();

      if (first === undefined) {
        throw new CamusError(CamusErrorCode.Generic, 'The streaming query response ended before its schema.');
      }

      if (payloadOf(first) !== 'schema') {
        throw new CamusError(
          CamusErrorCode.Generic,
          'The streaming query response did not start with a schema.',
        );
      }

      const { names, types } = readResultSchema(first.schema);

      source.names = names;
      source.types = types;

      return source;
    } catch (error) {
      await source.close();
      throw error;
    }
  }

  get columnNames(): readonly string[] {
    return this.names;
  }

  get columnTypes(): readonly ColumnType[] {
    return this.types;
  }

  async next(): Promise<readonly ColumnValue[] | undefined> {
    if (this.finished) return undefined;

    try {
      for (;;) {
        const message = await this.nextMessage();

        if (message === undefined) {
          this.finish();

          if (this.trailers !== undefined) this.options.observeTrailers?.(this.trailers);

          return undefined;
        }

        switch (payloadOf(message)) {
          case 'row':
            return this.decode(message.row);

          case 'schema':
            throw new CamusError(
              CamusErrorCode.Generic,
              'The streaming query response sent a second schema.',
            );

          // The cache verdict and the routing advice: a stream exposes neither, on either
          // transport.
          default:
            continue;
        }
      }
    } catch (error) {
      // The stream is over after a failure. A further read reports the end instead of reading again.
      await this.close();
      throw error;
    }
  }

  /**
   * Cancels the call when it did not end yet, which is how a stream closed early tells the server
   * to stop: an autocommit read is rolled back rather than left holding its snapshot.
   */
  async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    this.finish();

    if (!this.settled) this.call.cancel();

    try {
      await this.messages.return?.();
    } catch {
      // The call is already gone. Nothing is left to release.
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private finish(): void {
    this.finished = true;
    this.options.signal?.removeEventListener('abort', this.onAbort);
  }

  /**
   * Advances the call by one message, with a timer armed only while the read actually waits. A
   * message already received is read with no timer, and most rows of a large result are.
   */
  private async nextMessage(): Promise<GrpcQueryStreamMessage | undefined> {
    const { signal, timeoutSeconds, translate } = this.options;

    // An aborted call can still hold rows it received. They are not handed out.
    if (signal?.aborted === true) throw signal.reason;

    const pending = this.messages.next();

    // An object, so the checks after the wait see what the timer callback wrote.
    const wait = { timedOut: false };
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutSeconds > 0 && this.call.readableLength === 0) {
      timer = setTimeout(() => {
        wait.timedOut = true;
        this.call.cancel();
      }, timeoutSeconds * 1000);
    }

    let result: IteratorResult<GrpcQueryStreamMessage>;

    try {
      result = await pending;
    } catch (error) {
      // Read again, not narrowed: the caller can abort while the read waits.
      if (this.options.signal?.aborted === true) throw this.options.signal.reason;
      if (wait.timedOut) throw translate(deadlineExceeded(timeoutSeconds));

      // The call failed on its own, so its status is in.
      this.settled = true;

      if (CamusError.is(error)) throw error;

      throw translate(error as GrpcStatusError);
    } finally {
      clearTimeout(timer);
    }

    // A message can arrive in the moment the timer cancels the call. The call is gone all the same.
    if (wait.timedOut) throw translate(deadlineExceeded(timeoutSeconds));

    if (result.done === true) {
      this.settled = true;
      return undefined;
    }

    return result.value;
  }

  private decode(row: GrpcResultRow | undefined): ColumnValue[] {
    const types = this.types;
    const values = row?.values ?? [];
    const cells: ColumnValue[] = new Array<ColumnValue>(types.length).fill(NULL_VALUE);
    const limit = Math.min(cells.length, values.length);

    // A row shorter than the schema reads as null in the missing columns, as on the buffered path.
    for (let c = 0; c < limit; c++) cells[c] = decodeCell(values[c]!, types[c]!);

    return cells;
  }
}

/**
 * Which branch of the message is set. A loader configured without the `oneof` field leaves no
 * discriminator, so the branch is then inferred from the field that is present.
 */
function payloadOf(message: GrpcQueryStreamMessage): GrpcQueryStreamMessage['payload'] {
  if (message.payload !== undefined) return message.payload;
  if (message.schema !== undefined && message.schema !== null) return 'schema';
  if (message.row !== undefined && message.row !== null) return 'row';

  return undefined;
}

function deadlineExceeded(timeoutSeconds: number): GrpcStatusError {
  const details = `No response arrived within ${String(timeoutSeconds)} s while streaming the query.`;

  return Object.assign(new Error(details), { code: GRPC_STATUS_DEADLINE_EXCEEDED, details });
}
