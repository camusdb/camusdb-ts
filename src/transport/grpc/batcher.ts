/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { GrpcBatchOptions } from '../../config.js';
import { CamusError } from '../../errors.js';
import { CamusErrorCode } from '../../error-codes.js';
import { sanitizeErrorText } from '../error-text.js';
import { decodeCacheMetadata, decodeRoutingAdvice, fromWire } from './codec.js';
import type {
  GrpcBatchExecuteRequest,
  GrpcBatchExecuteResponse,
  GrpcPrepareReply,
  GrpcResultRow,
  GrpcResultSchema,
  GrpcSqlRequest,
  GrpcTxnHandle,
} from './messages.js';
import { GrpcBatchStatementKind } from './messages.js';
import type { CamusCacheMetadata } from '../../cache.js';
import type { CamusRoutingAdvice } from '../../routing/advice.js';

/** The hybrid-logical-clock token a reply carried. All three components are load-bearing. */
export interface BatchCausalToken {
  readonly n: number;
  readonly l: bigint;
  readonly c: bigint;
}

export const EMPTY_CAUSAL_TOKEN: BatchCausalToken = Object.freeze({ n: 0, l: 0n, c: 0n });

/** One query, decoded from the schema, rows, and terminator that shared a request id. */
export interface BatchQueryResult {
  readonly schema: GrpcResultSchema | undefined;
  readonly rows: GrpcResultRow[];
  readonly token: BatchCausalToken;
  readonly cacheMetadata: CamusCacheMetadata | undefined;
  readonly routing: CamusRoutingAdvice | undefined;
}

/** One write statement's reply. */
export interface BatchNonQueryResult {
  readonly affectedRows: number;
  readonly token: BatchCausalToken;
  readonly routing: CamusRoutingAdvice | undefined;
}

/** A prepared statement registered on one stream: the handle, and which stream minted it. */
export interface PreparedSlotEntry {
  readonly transportId: number;
  readonly statementId: number;
  readonly parameterNames: string[];
}

/**
 * Raised when a prepared execution is about to be written to a stream that is not the one its
 * handle was registered on. The handle died with the stream that minted it, so sending it would
 * only earn an "unknown statement" reply.
 */
export class PreparedStatementStaleError extends Error {
  override readonly name = 'PreparedStatementStaleError';

  constructor() {
    super("The prepared statement's stream was rebuilt before this execution could be written.");
  }
}

/** One `BatchExecute` duplex call, behind an interface a test can substitute for. */
export interface BatchStream {
  /** Identifies this stream. A handle registered on it is invalid on any other. */
  readonly id: number;

  send(request: GrpcBatchExecuteRequest): void;

  /** Registers the callbacks that drive the reader loop. Called once, right after construction. */
  listen(handlers: {
    onMessage: (response: GrpcBatchExecuteResponse) => void;
    onClose: (error: Error) => void;
  }): void;

  close(): void;
}

type Resolver = (value: unknown) => void;

interface PendingOp {
  readonly requestId: number;
  resolve: Resolver;
  reject: (error: Error) => void;
  settled: boolean;
  transportId: number;
  schema?: GrpcResultSchema | undefined;
  rows?: GrpcResultRow[] | undefined;
  onAbort?: (() => void) | undefined;
  signal?: AbortSignal | undefined;
}

interface QueuedItem {
  readonly request: GrpcBatchExecuteRequest;
  readonly op: PendingOp;
  readonly expectedTransportId: number | undefined;
}

/**
 * A registration held on one stream. The resolved entry is kept beside its promise so a caller
 * that must drop a dead handle can do it before its own next lookup — reading the promise instead
 * would defer the drop by a microtask, and the retry would then re-send the handle it discarded.
 */
interface PreparedRegistration {
  readonly pending: Promise<PreparedSlotEntry>;
  resolved: PreparedSlotEntry | undefined;
}

interface Slot {
  readonly index: number;
  readonly inbox: QueuedItem[];
  pumping: boolean;
  stream: BatchStream | undefined;
  readonly prepared: Map<string, PreparedRegistration>;
}

/**
 * Pipelines many statements over a small pool of long-lived `BatchExecute` streams.
 *
 * A unary call per statement costs a round trip per statement, and an application that issues six
 * statements per unit of work pays six. Here every message carries a client-monotonic request id,
 * replies for different ids interleave, and this class demultiplexes them by id. Statements that
 * share a transaction go to one stream, in arrival order, so the server sees them in the order the
 * caller wrote them; autocommit statements are free to use any stream.
 *
 * A stream that faults is rebuilt by the next write, and every operation that was in flight on the
 * old one is failed so its caller can decide whether to replay it. Prepared statements are scoped
 * to the stream that registered them, and a handle from a stream that is gone is refused at the
 * last moment before it would be written.
 */
export class GrpcBatcher {
  private readonly options: GrpcBatchOptions;

  private readonly streamFactory: (id: number) => BatchStream;

  private readonly slots: Slot[];

  private readonly pending = new Map<number, PendingOp>();

  private requestIdSeq = 0;

  private roundRobin = -1;

  private transportIdSeq = 0;

  private disposed = false;

  constructor(options: GrpcBatchOptions, streamFactory: (id: number) => BatchStream) {
    this.options = options;
    this.streamFactory = streamFactory;

    const poolSize = Math.max(1, options.channelPoolSize);
    this.slots = new Array<Slot>(poolSize);

    for (let i = 0; i < poolSize; i++) {
      this.slots[i] = { index: i, inbox: [], pumping: false, stream: undefined, prepared: new Map() };
    }
  }

  /** Reserves a stream for a transaction, so all of its operations land in one ordering chain. */
  reserveSlot(): number {
    return this.nextRoundRobin();
  }

  // ─── The enqueue surface ──────────────────────────────────────────────────

  enqueueQuery(
    request: GrpcSqlRequest,
    slotIndex: number | undefined,
    signal: AbortSignal | undefined,
    expectedTransportId?: number,
  ): Promise<BatchQueryResult> {
    return this.enqueue<BatchQueryResult>(
      GrpcBatchStatementKind.Query,
      request,
      slotIndex,
      signal,
      expectedTransportId,
    );
  }

  enqueueNonQuery(
    request: GrpcSqlRequest,
    slotIndex: number | undefined,
    signal: AbortSignal | undefined,
    expectedTransportId?: number,
  ): Promise<BatchNonQueryResult> {
    return this.enqueue<BatchNonQueryResult>(
      GrpcBatchStatementKind.NonQuery,
      request,
      slotIndex,
      signal,
      expectedTransportId,
    );
  }

  enqueueStart(
    request: GrpcSqlRequest,
    slotIndex: number,
    signal: AbortSignal | undefined,
  ): Promise<GrpcTxnHandle> {
    return this.enqueue<GrpcTxnHandle>(GrpcBatchStatementKind.Start, request, slotIndex, signal);
  }

  enqueueCommit(
    request: GrpcSqlRequest,
    slotIndex: number,
    signal: AbortSignal | undefined,
  ): Promise<BatchCausalToken> {
    return this.enqueue<BatchCausalToken>(GrpcBatchStatementKind.Commit, request, slotIndex, signal);
  }

  async enqueueRollback(
    request: GrpcSqlRequest,
    slotIndex: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.enqueue<unknown>(GrpcBatchStatementKind.Rollback, request, slotIndex, signal);
  }

  // ─── Prepared statements ──────────────────────────────────────────────────

  /**
   * The registration for a statement on one stream, creating it when there is none.
   *
   * A registration whose stream has since been rebuilt is dropped and made again: the handle died
   * with the stream, and the server would not know it.
   */
  async ensurePrepared(
    slotIndex: number,
    database: string,
    sql: string,
    signal: AbortSignal | undefined,
  ): Promise<PreparedSlotEntry> {
    const slot = this.slots[slotIndex]!;
    const key = statementKey(database, sql);

    for (;;) {
      const existing = slot.prepared.get(key);

      if (existing !== undefined) {
        let entry: PreparedSlotEntry;

        try {
          entry = await existing.pending;
        } catch {
          // Whoever created it already reported the failure to its own caller. Drop the poisoned
          // entry and take a fresh turn rather than failing every later execution.
          forget(slot, key, existing);
          continue;
        }

        if (entry.transportId === slot.stream?.id) return entry;

        // The slot's stream was rebuilt since this was registered, so the handle died with it.
        forget(slot, key, existing);
        continue;
      }

      const pending = this.registerPrepared(slotIndex, database, sql, signal);
      const registration: PreparedRegistration = { pending, resolved: undefined };

      slot.prepared.set(key, registration);

      try {
        const entry = await pending;

        registration.resolved = entry;
        return entry;
      } catch (error) {
        forget(slot, key, registration);
        throw error;
      }
    }
  }

  private async registerPrepared(
    slotIndex: number,
    database: string,
    sql: string,
    signal: AbortSignal | undefined,
  ): Promise<PreparedSlotEntry> {
    const { result, transportId } = await this.enqueueTracked<GrpcPrepareReply>(
      GrpcBatchStatementKind.Prepare,
      { database, sql },
      slotIndex,
      signal,
      undefined,
    );

    return { transportId, statementId: result.statementId, parameterNames: [...result.parameterNames] };
  }

  /** Drops a registration the server no longer honours, but only if it is still the current one. */
  invalidatePrepared(slotIndex: number, database: string, sql: string, stale: PreparedSlotEntry): void {
    const slot = this.slots[slotIndex]!;
    const key = statementKey(database, sql);
    const existing = slot.prepared.get(key);

    if (
      existing?.resolved?.statementId === stale.statementId &&
      existing.resolved.transportId === stale.transportId
    ) {
      forget(slot, key, existing);
    }
  }

  /** Removes and reports every stream's registration of one statement, so each can be released. */
  async takePrepared(
    database: string,
    sql: string,
  ): Promise<{ slotIndex: number; entry: PreparedSlotEntry }[]> {
    const key = statementKey(database, sql);
    const taken: { slotIndex: number; entry: PreparedSlotEntry }[] = [];

    for (const slot of this.slots) {
      const registration = slot.prepared.get(key);
      if (registration === undefined) continue;

      slot.prepared.delete(key);

      try {
        taken.push({ slotIndex: slot.index, entry: await registration.pending });
      } catch {
        // A registration that never succeeded has no handle to release.
      }
    }

    return taken;
  }

  /** Releases one registration on the stream that minted it. Best-effort. */
  async closePrepared(
    slotIndex: number,
    entry: PreparedSlotEntry,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      await this.enqueue<unknown>(
        GrpcBatchStatementKind.Close,
        { statementId: entry.statementId },
        slotIndex,
        signal,
        entry.transportId,
      );
    } catch {
      // The stream is already gone, and the handle was released with it.
    }
  }

  // ─── Enqueue and pump ─────────────────────────────────────────────────────

  private async enqueue<T>(
    kind: GrpcBatchStatementKind,
    request: GrpcSqlRequest,
    slotIndex: number | undefined,
    signal: AbortSignal | undefined,
    expectedTransportId?: number,
  ): Promise<T> {
    const { result } = await this.enqueueTracked<T>(kind, request, slotIndex, signal, expectedTransportId);
    return result;
  }

  private enqueueTracked<T>(
    kind: GrpcBatchStatementKind,
    request: GrpcSqlRequest,
    slotIndex: number | undefined,
    signal: AbortSignal | undefined,
    expectedTransportId: number | undefined,
  ): Promise<{ result: T; transportId: number }> {
    if (this.disposed) {
      return Promise.reject(new CamusError(CamusErrorCode.Generic, 'This gRPC transport is closed.'));
    }

    const slot = this.slots[slotIndex ?? this.nextRoundRobin()]!;
    const requestId = ++this.requestIdSeq;

    return new Promise<{ result: T; transportId: number }>((resolve, reject) => {
      const op: PendingOp = {
        requestId,
        settled: false,
        transportId: 0,
        resolve: (value) => resolve({ result: value as T, transportId: op.transportId }),
        reject,
      };

      if (signal !== undefined) {
        if (signal.aborted) {
          reject(signal.reason as Error);
          return;
        }

        op.signal = signal;
        op.onAbort = () => this.fault(op, signal.reason as Error);
        signal.addEventListener('abort', op.onAbort, { once: true });
      }

      this.pending.set(requestId, op);

      slot.inbox.push({ request: { requestId, kind, request }, op, expectedTransportId });
      void this.pump(slot);
    });
  }

  /**
   * Drains one slot's queue onto its stream.
   *
   * Only one pump runs per slot, so the slot's stream has exactly one writer and needs no lock.
   */
  private async pump(slot: Slot): Promise<void> {
    if (slot.pumping) return;

    slot.pumping = true;

    try {
      for (;;) {
        let drained = 0;

        for (;;) {
          const item = slot.inbox.shift();
          if (item === undefined) break;

          this.writeItem(slot, item);
          drained++;
        }

        // Coalescing: after writing a small burst, pause briefly so more operations accumulate
        // before the next drain writes them together. It applies only after a drain of two or
        // more. A one-item drain is a request-and-reply exchange — one caller, whose next
        // statement cannot arrive until this one is answered — and sleeping there would add the
        // whole delay to every round trip while gaining nothing.
        if (
          drained >= 2 &&
          this.options.coalescingThreshold > 1 &&
          drained < this.options.coalescingThreshold &&
          this.options.coalescingDelayMs > 0
        ) {
          await sleep(this.options.coalescingDelayMs);
        }

        if (slot.inbox.length === 0) return;
      }
    } finally {
      slot.pumping = false;

      // An item queued while the pump was finishing must not be left waiting for the next caller.
      if (slot.inbox.length > 0 && !this.disposed) void this.pump(slot);
    }
  }

  private writeItem(slot: Slot, item: QueuedItem): void {
    try {
      const stream = slot.stream ?? this.reconnect(slot);

      // A prepared execution names a handle that exists only on the stream that registered it.
      // This is the last moment the two can be compared — check any earlier and the stream could
      // still be rebuilt in between — so refuse here rather than send an operation the server can
      // only answer with "unknown statement".
      if (item.expectedTransportId !== undefined && stream.id !== item.expectedTransportId) {
        throw new PreparedStatementStaleError();
      }

      item.op.transportId = stream.id;
      stream.send(item.request);
    } catch (error) {
      this.fault(item.op, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private reconnect(slot: Slot): BatchStream {
    const stream = this.streamFactory(++this.transportIdSeq);

    slot.stream = stream;

    stream.listen({
      onMessage: (response) => this.demux(response),
      onClose: (error) => {
        // Only clear the slot when this stream is still the current one: a later reconnect must
        // not be undone by an older stream's close event.
        if (slot.stream === stream) slot.stream = undefined;

        this.failStreamPending(stream.id, error);
      },
    });

    return stream;
  }

  // ─── Demultiplex ──────────────────────────────────────────────────────────

  private demux(response: GrpcBatchExecuteResponse): void {
    const op = this.pending.get(response.requestId);

    // Cancelled, timed out, or already settled. Drop it.
    if (op === undefined) return;

    switch (response.payload) {
      case 'schema':
        op.schema = response.schema;
        return;

      case 'row':
        (op.rows ??= []).push(response.row!);
        return;

      case 'queryComplete': {
        const complete = response.queryComplete!;

        this.complete(op, {
          schema: op.schema,
          rows: op.rows ?? [],
          token: {
            n: complete.causalTokenN,
            l: fromWire(complete.causalTokenL),
            c: fromWire(complete.causalTokenC),
          },
          cacheMetadata: decodeCacheMetadata(complete.cacheMetadata),
          routing: decodeRoutingAdvice(complete.routing),
        } satisfies BatchQueryResult);
        return;
      }

      case 'nonQuery': {
        const reply = response.nonQuery!;

        this.complete(op, {
          affectedRows: reply.affectedRows,
          token: {
            n: reply.causalTokenN,
            l: fromWire(reply.causalTokenL),
            c: fromWire(reply.causalTokenC),
          },
          routing: decodeRoutingAdvice(reply.routing),
        } satisfies BatchNonQueryResult);
        return;
      }

      case 'startReply':
        this.complete(op, response.startReply);
        return;

      case 'commitReply': {
        const reply = response.commitReply!;

        this.complete(op, {
          n: reply.causalTokenN,
          l: fromWire(reply.causalTokenL),
          c: fromWire(reply.causalTokenC),
        } satisfies BatchCausalToken);
        return;
      }

      case 'prepareReply':
        this.complete(op, response.prepareReply);
        return;

      case 'rollbackReply':
      case 'closeReply':
        this.complete(op, undefined);
        return;

      case 'error':
        this.fault(op, new CamusError(response.error!.code, sanitizeErrorText(response.error!.message)));
        return;

      default:
        return;
    }
  }

  private complete(op: PendingOp, result: unknown): void {
    if (!this.settle(op)) return;

    op.resolve(result);
  }

  private fault(op: PendingOp, error: Error): void {
    if (!this.settle(op)) return;

    op.reject(error);
  }

  private settle(op: PendingOp): boolean {
    if (op.settled) return false;

    op.settled = true;
    this.pending.delete(op.requestId);

    if (op.onAbort !== undefined) op.signal?.removeEventListener('abort', op.onAbort);

    return true;
  }

  /** Fails every operation still in flight on a stream that closed, so its caller can replay. */
  private failStreamPending(transportId: number, error: Error): void {
    for (const op of [...this.pending.values()]) {
      if (op.transportId === transportId) this.fault(op, error);
    }
  }

  private nextRoundRobin(): number {
    this.roundRobin = (this.roundRobin + 1) % this.slots.length;
    return this.roundRobin;
  }

  /** Closes every stream and fails everything still in flight. */
  async dispose(): Promise<void> {
    if (this.disposed) return;

    this.disposed = true;

    for (const slot of this.slots) {
      const stream = slot.stream;
      slot.stream = undefined;
      slot.inbox.length = 0;

      try {
        stream?.close();
      } catch {
        // Best effort: the stream may already be broken.
      }
    }

    const closed = new CamusError(CamusErrorCode.Generic, 'This gRPC transport is closed.');

    for (const op of [...this.pending.values()]) this.fault(op, closed);

    await Promise.resolve();
  }
}

function forget(slot: Slot, key: string, expected: PreparedRegistration): void {
  if (slot.prepared.get(key) === expected) slot.prepared.delete(key);
}

// A newline cannot appear in a database name, so it separates the two parts without ambiguity.
function statementKey(database: string, sql: string): string {
  return `${database}\n${sql}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
