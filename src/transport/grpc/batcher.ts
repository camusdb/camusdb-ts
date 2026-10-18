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
import { FRAME_MAX_BYTES, FRAME_MAX_ITEMS, FRAME_PIPELINE_VERSION, frameCost } from './batch-frames.js';
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

  /**
   * The output columns of a write with `RETURNING`, or `undefined` for a statement without
   * `RETURNING` and for a request that set `discardReturningRows`.
   */
  readonly returningSchema: GrpcResultSchema | undefined;

  /** The `RETURNING` rows, aligned to `returningSchema`. Empty when the schema is `undefined`. */
  readonly returningRows: GrpcResultRow[];
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

/**
 * One operation of a pipeline handed to `enqueuePipeline`, before the batcher gives it a request
 * id. `expectedTransportId` is the stream that a prepared execution's handle lives on, as for a
 * lone operation.
 */
export interface PipelineOp {
  readonly kind: GrpcBatchStatementKind;
  readonly request: GrpcSqlRequest;
  readonly expectedTransportId?: number | undefined;
}

/**
 * Raised on every operation of a pipeline that the batcher refused to write as one frame, before
 * any of it was written. The causes are a server that announced a contract version below
 * `FRAME_PIPELINE_VERSION`, frames that are off, or a pipeline that does not fit one frame.
 * Nothing ran, so the caller can run the same operations one exchange at a time.
 */
export class PipelineUnsupportedError extends Error {
  override readonly name = 'PipelineUnsupportedError';

  readonly reason: string;

  constructor(reason: string) {
    super(`The pipeline cannot be written as one frame on this stream: ${reason}.`);
    this.reason = reason;
  }
}

/** One `BatchExecute` duplex call, behind an interface a test can substitute for. */
export interface BatchStream {
  /** Identifies this stream. A handle registered on it is invalid on any other. */
  readonly id: number;

  /**
   * The frame contract version this stream's server announced, or 0 while it announced nothing.
   *
   * It never blocks, and it never goes down. It is 0 until the announcement arrives, and it stays
   * 0 against a server that makes none. It belongs to one stream, so a rebuilt stream negotiates
   * again on its own. Version 1 lets the batcher write frames. `FRAME_PIPELINE_VERSION` lets it
   * write a whole transaction as one frame.
   */
  readonly announcedVersion: number;

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
  readonly kind: GrpcBatchStatementKind;

  /**
   * The transaction this operation belongs to, keyed from the handle it carries. It is undefined
   * for an autocommit operation, and for a start, whose handle does not exist until it is
   * answered.
   */
  readonly transaction: string | undefined;

  /**
   * For an operation of a pipeline that names its start instead of a handle: that start. Its
   * `mintedHandle` is the transaction this operation belongs to. The start is always answered
   * before this operation's own answer arrives.
   */
  startRef?: PendingOp | undefined;

  /** The handle key a start was answered with, so the operations that named it find it. */
  mintedHandle?: string | undefined;

  resolve: Resolver;
  reject: (error: Error) => void;
  settled: boolean;
  transportId: number;

  /** The stream this operation was written to, held until the operation ends. */
  lease: StreamLease | undefined;

  schema?: GrpcResultSchema | undefined;
  rows?: GrpcResultRow[] | undefined;
  onAbort?: (() => void) | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * One stream, the credential it opened under, and what still rides on it — which is what decides
 * when a retired stream may be closed.
 */
interface StreamLease {
  readonly slot: Slot;
  readonly stream: BatchStream;

  /** What the credential stamp read when this stream opened. It is compared, never inspected. */
  readonly stamp: unknown;

  /** Operations written to this stream that have not ended yet. */
  inFlight: number;

  /** Transactions that began on this stream and that the server has not finalized. */
  openTransactions: number;

  /** True once the slot moved on to a newer stream. From then on the stream only drains. */
  retired: boolean;

  /** True once the stream is closed, from either end. */
  closed: boolean;

  /** The timer that bounds the drain of a retired stream. */
  drainTimer: ReturnType<typeof setTimeout> | undefined;
}

interface QueuedItem {
  readonly request: GrpcBatchExecuteRequest;
  readonly op: PendingOp;
  readonly expectedTransportId: number | undefined;

  /**
   * The pipeline this operation belongs to. The inbox holds one entry for a whole pipeline, and
   * each operation of it carries the group too, so the flush keeps them together.
   */
  readonly group?: PipelineGroup | undefined;
}

/** The operations of one `enqueuePipeline` call, staged and written together. */
interface PipelineGroup {
  readonly items: QueuedItem[];

  /** The one signal that covers the whole pipeline. */
  readonly signal: AbortSignal | undefined;

  /**
   * True when the group holds a start that its followers name, or a conditional commit. Such a
   * group can only be written as one frame, to a server of `FRAME_PIPELINE_VERSION` or higher.
   */
  needsPipelineContract: boolean;

  /**
   * Set by the flush when one operation of the group was cancelled after it was staged. The rest
   * are then left out and faulted too. Only the slot's pump touches it.
   */
  broken: boolean;
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

  /**
   * The items staged for the next stream message, all bound for `runStream`. Only the slot's own
   * pump touches this field and the two below it.
   */
  readonly run: QueuedItem[];

  runLease: StreamLease | undefined;

  /**
   * The estimated size of `run` as frame items, or -1 while it holds one item that nothing had a
   * reason to measure.
   */
  runBytes: number;

  pumping: boolean;

  /** True while a pump start waits on the microtask queue. See `schedule`. */
  scheduled: boolean;

  /**
   * The stream new work is written to, or undefined after it ended and before an operation has
   * needed the slot again.
   */
  current: StreamLease | undefined;

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
 * Operations that wait together travel together. The pump writes the operations it drained for one
 * stream as a single stream message — a frame — when that stream's server announced that it reads
 * one, and it reads a response frame at any time. A frame never waits: it packs only the
 * operations that already sit in the inbox, and a lone operation stays the plain single message it
 * always was. It is a transport optimization alone. It gives no atomicity and no ordering that the
 * stream does not already give.
 *
 * A whole transaction can travel as one frame. `enqueuePipeline` takes the operations of one
 * transaction — a start that its followers name instead of a handle, statements, and a conditional
 * commit — and places them on the inbox together, so they are written as one frame or not at all.
 * The two items that make this possible are contract version 2. A stream whose server announced
 * less gets none of them: the pipeline faults before any byte is written, and the caller runs the
 * same operations one exchange at a time.
 *
 * A stream that faults is rebuilt by the next write, and every operation that was in flight on the
 * old one is failed so its caller can decide whether to replay it. Prepared statements are scoped
 * to the stream that registered them, and a handle from a stream that is gone is refused at the
 * last moment before it would be written.
 *
 * A stream is rotated when the credential it opened under is superseded. A stream presents its
 * bearer token once, in its opening metadata, and then outlives it: the provider renews the token
 * every few minutes, and the stream is meant to last a session. Whether the server tolerates that
 * is the server's decision, and a server that re-checks the opening token per operation ends the
 * stream at that token's expiry, with every transaction on it. The client does not rely on it.
 *
 * When the next unbound operation of a slot finds the credential changed, the slot opens a fresh
 * stream under the new token, and the old one is retired. A retired stream takes no new work. It
 * keeps serving the transactions that began on it, because a transaction cannot change streams,
 * and the server rolls a transaction back when its stream closes. It is closed as soon as the last
 * of them ends, or after `streamDrainTimeoutMs`. Rotation happens on the write path, so an idle
 * client rotates on its first operation after the renewal, before that operation is sent.
 */
export class GrpcBatcher {
  private readonly options: GrpcBatchOptions;

  private readonly streamFactory: (id: number) => BatchStream;

  /**
   * Reports the credential a stream opened now would carry, which in practice is the current
   * bearer token. It is compared, never inspected: a value that differs from the one a stream
   * opened under is what retires that stream. Undefined means that a stream carries no credential
   * that can change, and that nothing is ever rotated.
   */
  private readonly credentialStamp: (() => unknown) | undefined;

  private readonly slots: Slot[];

  private readonly pending = new Map<number, PendingOp>();

  /**
   * The stream each open transaction began on, by handle. An entry is written when a start is
   * answered, and removed when the server answers the commit or the rollback, or when that stream
   * ends. It is what lets a transaction keep its stream across a rotation of its slot.
   */
  private readonly openTransactions = new Map<string, StreamLease>();

  /**
   * Retired streams that still drain, so disposal can reach them: a slot references its current
   * stream alone.
   */
  private readonly retiring = new Set<StreamLease>();

  private requestIdSeq = 0;

  private roundRobin = -1;

  private transportIdSeq = 0;

  private disposed = false;

  constructor(
    options: GrpcBatchOptions,
    streamFactory: (id: number) => BatchStream,
    credentialStamp?: () => unknown,
  ) {
    this.options = options;
    this.streamFactory = streamFactory;
    this.credentialStamp = credentialStamp;

    const poolSize = Math.max(1, options.channelPoolSize);
    this.slots = new Array<Slot>(poolSize);

    for (let i = 0; i < poolSize; i++) {
      this.slots[i] = {
        index: i,
        inbox: [],
        run: [],
        runLease: undefined,
        runBytes: -1,
        pumping: false,
        scheduled: false,
        current: undefined,
        prepared: new Map(),
      };
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

  /**
   * Enqueues the operations of one transaction so that they travel as one frame, in the given
   * order: an optional start at the head, statements, and an optional conditional commit at the
   * end. Every operation after a start names it by `txnStartRef`, because its handle does not
   * exist yet.
   *
   * It returns one promise per operation. Each one settles with that operation's own answer — a
   * `GrpcTxnHandle`, a `BatchQueryResult`, a `BatchNonQueryResult`, or a `BatchCausalToken` — or
   * with its own error, as a lone operation's does.
   *
   * The operations go on the slot's inbox together, so no other operation of the same transaction
   * can come between them. They are written together or not at all. A named start and a
   * conditional commit are contract version 2. So on a stream whose server announced less, with
   * frames off, or when the pipeline does not fit one frame, nothing is written and every promise
   * rejects with `PipelineUnsupportedError`. A pipeline of plain statements on a known handle needs
   * no version, and is staged as those operations would be alone, still in order.
   *
   * One signal covers the whole pipeline. A pipeline with a cancelled member is left out whole,
   * because to write the rest could commit a transaction that is missing one of its statements.
   */
  enqueuePipeline(
    ops: readonly PipelineOp[],
    slotIndex: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown>[] {
    if (ops.length === 0) return [];

    if (this.disposed) {
      const closed = new CamusError(CamusErrorCode.Generic, 'This gRPC transport is closed.');
      return ops.map(() => Promise.reject(closed));
    }

    if (signal?.aborted === true) {
      return ops.map(() => Promise.reject(signal.reason as Error));
    }

    const items: QueuedItem[] = [];
    const promises: Promise<unknown>[] = [];
    const group: PipelineGroup = { items, signal, needsPipelineContract: false, broken: false };

    let start: PendingOp | undefined;
    let conditionalCommit = false;

    for (let i = 0; i < ops.length; i++) {
      const source = ops[i]!;
      const requestId = ++this.requestIdSeq;
      const wire: GrpcBatchExecuteRequest = { requestId, kind: source.kind, request: source.request };

      let op!: PendingOp;

      promises.push(
        new Promise<unknown>((resolve, reject) => {
          op = {
            requestId,
            kind: source.kind,
            transaction: handleKey(source.request.txnHandle),
            settled: false,
            transportId: 0,
            lease: undefined,
            resolve,
            reject,
          };
        }),
      );

      if (i === 0 && source.kind === GrpcBatchStatementKind.Start) {
        start = op;
      } else if (start !== undefined) {
        // Named by request id: the start mints the handle after this is written.
        op.startRef = start;
        wire.txnStartRef = start.requestId;
      }

      conditionalCommit ||= source.kind === GrpcBatchStatementKind.CommitIfOk;

      if (signal !== undefined) {
        const pending = op;

        op.signal = signal;
        op.onAbort = () => this.fault(pending, signal.reason as Error);
        signal.addEventListener('abort', op.onAbort, { once: true });
      }

      this.pending.set(requestId, op);
      items.push({ request: wire, op, expectedTransportId: source.expectedTransportId, group });
    }

    // A lone start, or a run of statements by handle with no conditional commit, is ordinary work.
    group.needsPipelineContract = (start !== undefined && ops.length > 1) || conditionalCommit;

    const slot = this.slots[slotIndex]!;

    slot.inbox.push(items[0]!);
    this.schedule(slot);

    return promises;
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

        if (entry.transportId === slot.current?.stream.id) return entry;

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
        kind,
        transaction: handleKey(request.txnHandle),
        settled: false,
        transportId: 0,
        lease: undefined,
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
      this.schedule(slot);
    });
  }

  /**
   * Starts the slot's pump after the current turn, and not inside it.
   *
   * A caller that issues several statements at once — one `Promise.all` over six of them — queues
   * them all in one synchronous turn. A pump that ran inside `enqueue` would write the first
   * before the second was queued, and every operation would then travel alone. One microtask of
   * delay costs no round trip, and it lets the operations that were issued together share a frame.
   */
  private schedule(slot: Slot): void {
    if (slot.pumping || slot.scheduled) return;

    slot.scheduled = true;

    queueMicrotask(() => {
      slot.scheduled = false;
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

          if (item.group !== undefined) this.stageGroup(slot, item.group);
          else this.stage(slot, item);

          drained++;
        }

        this.flush(slot);

        // Coalescing: after writing a small burst, pause briefly so more operations accumulate
        // before the next drain writes them together. It applies only after a drain of two or
        // more. A one-item drain is a request-and-reply exchange — one caller, whose next
        // statement cannot arrive until this one is answered — and a pause there would add the
        // whole delay to every round trip for nothing. Operations that wait together already share
        // a frame without any pause, so the pause only makes the next frame fuller.
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
    } catch (error) {
      // Staging and flushing report their own failures per operation, so this is not expected. An
      // item left in the run would otherwise wait for an answer to a message nothing ever wrote.
      const failure = toError(error);

      for (const item of slot.run.splice(0)) this.fault(item.op, failure);

      slot.runLease = undefined;
      slot.runBytes = -1;
    } finally {
      slot.pumping = false;

      // An item queued while the pump was finishing must not be left waiting for the next caller.
      if (slot.inbox.length > 0 && !this.disposed) void this.pump(slot);
    }
  }

  /**
   * Prepares one operation for the wire, then either writes it alone or adds it to the slot's run.
   *
   * A run is the set of operations that will share the next stream message. It holds consecutive
   * operations bound for one stream. The operations of one drain can belong to different streams,
   * so an operation for another stream flushes the run first. Operations are never reordered to
   * fill a frame: the server chains the operations of a transaction by arrival order, and inbox
   * order is the only order the callers gave.
   */
  private stage(slot: Slot, item: QueuedItem): void {
    // Cancelled while it sat in the inbox: it holds nothing yet, so it is simply left out.
    if (!this.mustStillBeWritten(item)) return;

    let lease: StreamLease;

    try {
      lease = this.route(slot, item.op);

      // A prepared execution names a handle that exists only on the stream that registered it.
      // This is the last moment the two can be compared — check any earlier and the stream could
      // still be rebuilt in between — so refuse here rather than send an operation the server can
      // only answer with "unknown statement".
      if (item.expectedTransportId !== undefined && lease.stream.id !== item.expectedTransportId) {
        throw new PreparedStatementStaleError();
      }

      item.op.transportId = lease.stream.id;

      // The hold this operation keeps on its stream, so a retired stream is not closed under it.
      lease.inFlight++;
      item.op.lease = lease;
    } catch (error) {
      this.fault(item.op, toError(error));
      return;
    }

    this.place(slot, item, lease);
  }

  /** Writes a routed operation alone, or adds it to the slot's run so it shares the next frame. */
  private place(slot: Slot, item: QueuedItem, lease: StreamLease): void {
    // A frame goes only to a server that announced one on this very stream. The announcement is
    // read, never awaited: until it arrives, and for good against a server that makes none, every
    // operation is its own message.
    const framed = this.options.requestFrames && lease.stream.announcedVersion >= 1;

    if (slot.run.length > 0 && (!framed || slot.runLease !== lease)) this.flush(slot);

    if (!framed) {
      this.send(lease.stream, item.request, item.op);
      return;
    }

    if (slot.run.length === 0) {
      // A lone operation is never measured. It travels as the plain message whatever its size.
      slot.run.push(item);
      slot.runLease = lease;
      slot.runBytes = -1;
      return;
    }

    if (slot.runBytes < 0) slot.runBytes = frameCost(slot.run[0]!.request);

    const cost = frameCost(item.request);

    // Both limits are the sender's duty, and the byte budget most of all. A message over the limit
    // of the transport is refused before the server parses it, which resets the stream that every
    // other operation shares. An operation over the budget ends up alone in its run, and so travels
    // as a single message.
    if (slot.run.length >= FRAME_MAX_ITEMS || slot.runBytes + cost > FRAME_MAX_BYTES) {
      this.flush(slot);

      slot.run.push(item);
      slot.runLease = lease;
      slot.runBytes = cost;
      return;
    }

    slot.run.push(item);
    slot.runBytes += cost;
  }

  /**
   * Stages a pipeline.
   *
   * The group is routed as one, because its operations are one transaction and so use one stream,
   * and that stream is held for every operation. A group that needs the pipeline contract goes into
   * the slot's run whole. The run is flushed first when it is for another stream or has no room for
   * the whole group. A group that needs no contract version is placed one operation at a time, as
   * lone operations are, still in order. A group that cannot be written as one frame faults whole,
   * before anything is held or written.
   */
  private stageGroup(slot: Slot, group: PipelineGroup): void {
    const items = group.items;
    let lease: StreamLease;
    let cost = 0;

    try {
      // All or nothing, before anything is held. A group with a cancelled member is left out
      // whole, because to write the rest could commit a transaction that is missing a statement.
      if (items.some((item) => !this.mustStillBeWritten(item))) throw cancelledError(group.signal);

      lease = this.route(slot, items[0]!.op);

      for (const item of items) {
        if (item.expectedTransportId !== undefined && lease.stream.id !== item.expectedTransportId) {
          throw new PreparedStatementStaleError();
        }
      }

      if (group.needsPipelineContract) {
        const announced = lease.stream.announcedVersion;

        if (!this.options.requestFrames) throw new PipelineUnsupportedError('request frames are off');

        if (announced < FRAME_PIPELINE_VERSION) {
          throw new PipelineUnsupportedError(
            `the server announced frame contract version ${String(announced)}, below ${String(FRAME_PIPELINE_VERSION)}`,
          );
        }

        if (items.length > FRAME_MAX_ITEMS) {
          throw new PipelineUnsupportedError(
            `${String(items.length)} operations exceed the ${String(FRAME_MAX_ITEMS)}-item frame limit`,
          );
        }

        for (const item of items) cost += frameCost(item.request);

        if (cost > FRAME_MAX_BYTES) {
          throw new PipelineUnsupportedError(
            `${String(cost)} bytes exceed the ${String(FRAME_MAX_BYTES)}-byte frame limit`,
          );
        }
      }

      for (const item of items) {
        item.op.transportId = lease.stream.id;
        lease.inFlight++;
        item.op.lease = lease;
      }
    } catch (error) {
      const failure = toError(error);

      for (const item of items) this.fault(item.op, failure);
      return;
    }

    if (!group.needsPipelineContract) {
      for (const item of items) this.place(slot, item, lease);
      return;
    }

    if (slot.run.length > 0) {
      if (slot.runBytes < 0) slot.runBytes = frameCost(slot.run[0]!.request);

      if (
        slot.runLease !== lease ||
        slot.run.length + items.length > FRAME_MAX_ITEMS ||
        slot.runBytes + cost > FRAME_MAX_BYTES
      ) {
        this.flush(slot);
      }
    }

    if (slot.run.length === 0) {
      slot.runLease = lease;
      slot.runBytes = 0;
    }

    slot.run.push(...items);
    slot.runBytes += cost;
  }

  /**
   * Writes the slot's run: one frame, or the plain single message when one operation is left in
   * it, so a quiet stream stays byte-identical to a stream without frames.
   *
   * A frame is never resent. A frame whose write failed may or may not have reached the server,
   * which is true of every operation in it, so every one of them faults with the transport error.
   * The retry contract above the batcher then decides, exactly as it does for the operations of a
   * stream that faulted.
   */
  private flush(slot: Slot): void {
    const run = slot.run.splice(0);
    const lease = slot.runLease;

    slot.runLease = undefined;
    slot.runBytes = -1;

    if (run.length === 0 || lease === undefined) return;

    // A pipeline travels whole or not at all. When one of its operations was cancelled after it
    // was staged, the others are left out too, and faulted, so a conditional commit never commits
    // a transaction that is missing a statement.
    for (const item of run) {
      if (item.group !== undefined && !item.group.broken && !this.mustStillBeWritten(item)) {
        item.group.broken = true;
      }
    }

    const items: GrpcBatchExecuteRequest[] = [];

    for (const item of run) {
      // Cancelled since it was staged: nothing awaits an answer, so leave it out.
      if (item.group?.broken === true) this.fault(item.op, cancelledError(item.group.signal));
      else if (this.mustStillBeWritten(item)) items.push(item.request);
    }

    if (items.length === 0) return;

    try {
      if (items.length === 1) {
        lease.stream.send(items[0]!);
        return;
      }

      lease.stream.send({ requestId: 0, kind: GrpcBatchStatementKind.Frame, items });
    } catch (error) {
      const failure = toError(error);

      for (const item of run) this.fault(item.op, failure);
    }
  }

  private send(stream: BatchStream, request: GrpcBatchExecuteRequest, op: PendingOp): void {
    try {
      stream.send(request);
    } catch (error) {
      this.fault(op, toError(error));
    }
  }

  /**
   * False for an operation whose caller left — it was cancelled, or it timed out — before the
   * operation was written. The server is never asked to run it.
   *
   * A rollback and a close are written whatever happens. Each one only releases what the server
   * holds, which is a transaction's locks or a statement handle, and nothing else would.
   */
  private mustStillBeWritten(item: QueuedItem): boolean {
    const kind = item.request.kind;

    return (
      kind === GrpcBatchStatementKind.Rollback ||
      kind === GrpcBatchStatementKind.Close ||
      this.pending.has(item.op.requestId)
    );
  }

  /**
   * The stream one operation belongs on.
   *
   * A transaction stays on the stream it began on, whatever the slot has moved to since. Anything
   * else takes the slot's current stream, and that is where a credential change is noticed.
   */
  private route(slot: Slot, op: PendingOp): StreamLease {
    if (op.transaction !== undefined && op.kind !== GrpcBatchStatementKind.Start) {
      const home = this.openTransactions.get(op.transaction);

      if (home !== undefined) return home;
    }

    const current = slot.current;

    if (current === undefined) return this.connect(slot);

    // An undefined stamp is "no token right now": one was invalidated and its replacement is not
    // minted yet. That is no reason to trade a working stream for one opened with no credential.
    const stamp = this.credentialStamp?.();

    if (stamp !== undefined && stamp !== current.stamp) {
      this.retire(current);
      return this.connect(slot);
    }

    return current;
  }

  /**
   * Opens a fresh stream for a slot and makes it the current one.
   *
   * The stamp is read before the factory reads the credential itself. If the credential is renewed
   * in between, the stream is stamped older than it is, and it rotates once more than it needs to.
   * Read afterwards, it could be stamped newer than it is, and would never rotate at all.
   */
  private connect(slot: Slot): StreamLease {
    const stamp = this.credentialStamp?.();
    const stream = this.streamFactory(++this.transportIdSeq);

    const lease: StreamLease = {
      slot,
      stream,
      stamp,
      inFlight: 0,
      openTransactions: 0,
      retired: false,
      closed: false,
      drainTimer: undefined,
    };

    slot.current = lease;

    stream.listen({
      onMessage: (response) => this.demux(response),
      onClose: (error) => this.close(lease, error),
    });

    return lease;
  }

  /**
   * Takes a stream out of rotation.
   *
   * It stays open for the transactions that began on it, and it closes when the last one ends — or
   * after `streamDrainTimeoutMs`, because a transaction its caller abandoned would otherwise hold
   * the stream, and its locks, open for good. Closing the stream is what makes the server roll
   * such a transaction back.
   */
  private retire(lease: StreamLease): void {
    lease.retired = true;
    this.retiring.add(lease);

    this.closeIfDrained(lease);

    if (lease.closed) return;

    lease.drainTimer = setTimeout(() => this.close(lease), Math.max(0, this.options.streamDrainTimeoutMs));

    lease.drainTimer.unref?.();
  }

  private closeIfDrained(lease: StreamLease): void {
    if (lease.retired && lease.inFlight <= 0 && lease.openTransactions <= 0) this.close(lease);
  }

  /**
   * Closes a stream once, and forgets everything that was riding on it.
   *
   * It runs whichever end closes the stream first: this client, when a retired stream has drained,
   * or the server, through the stream's own close event.
   */
  private close(lease: StreamLease, error?: Error): void {
    if (lease.closed) return;

    lease.closed = true;

    if (lease.drainTimer !== undefined) {
      clearTimeout(lease.drainTimer);
      lease.drainTimer = undefined;
    }

    // Only when it is still the slot's stream: a retired one was replaced long before it ended.
    if (lease.slot.current === lease) lease.slot.current = undefined;

    this.retiring.delete(lease);

    // The server rolls back a transaction whose stream closed, so none of these is open any more.
    for (const [handle, home] of this.openTransactions) {
      if (home === lease) this.openTransactions.delete(handle);
    }

    try {
      lease.stream.close();
    } catch {
      // Best effort: the stream may already be broken.
    }

    this.failStreamPending(lease.stream.id, error ?? streamClosedError());
  }

  /** Drops an operation's hold on its stream, once however many paths race to do it. */
  private release(op: PendingOp): void {
    const lease = op.lease;

    if (lease === undefined) return;

    op.lease = undefined;
    lease.inFlight--;

    if (lease.inFlight <= 0) this.closeIfDrained(lease);
  }

  private transactionBegan(handle: string, lease: StreamLease | undefined): void {
    // A handle is unique, so one is never counted twice.
    if (lease === undefined || this.openTransactions.has(handle)) return;

    this.openTransactions.set(handle, lease);
    lease.openTransactions++;
  }

  private transactionEnded(handle: string | undefined): void {
    if (handle === undefined) return;

    const lease = this.openTransactions.get(handle);

    if (lease === undefined) return;

    this.openTransactions.delete(handle);
    lease.openTransactions--;

    if (lease.openTransactions <= 0) this.closeIfDrained(lease);
  }

  /**
   * True when a transaction began on a stream that was rotated out, and is finishing there.
   *
   * Such a transaction must not run prepared. A slot keeps one registration per statement, and
   * that registration belongs to the slot's current stream, where this transaction does not write.
   * To register the statement on the retired stream instead would evict the entry every autocommit
   * caller is using, and the two would re-prepare against each other until the old stream closes.
   * To run the statement inline is always correct, and the window is short.
   */
  isBoundToRetiredStream(txnIdPT: bigint, txnIdCounter: number): boolean {
    return this.openTransactions.get(transactionKey(txnIdPT, txnIdCounter))?.retired === true;
  }

  // ─── Demultiplex ──────────────────────────────────────────────────────────

  private demux(response: GrpcBatchExecuteResponse): void {
    // A response frame. Each item is handled exactly as if it had arrived alone, in order, so the
    // messages of one request id keep theirs. A frame inside a frame is dropped, never followed.
    if (response.payload === 'frame') {
      for (const item of response.frame?.items ?? []) {
        if (item.payload !== 'frame') this.demux(item);
      }

      return;
    }

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
          // returning_schema is a message field, so "unset" (no RETURNING, or count only) and "set
          // with no rows" (a RETURNING that wrote nothing) stay distinct.
          returningSchema: reply.returningSchema ?? undefined,
          returningRows: reply.returningRows ?? [],
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

    // Before the operation lets go of its stream: a start that was just answered is the only thing
    // that holds a retired stream open until its transaction is on the books.
    if (op.kind === GrpcBatchStatementKind.Start) {
      const handle = result as GrpcTxnHandle | undefined;

      if (handle !== undefined) {
        op.mintedHandle = handleKey(handle)!;
        this.transactionBegan(op.mintedHandle, op.lease);
      }
    } else if (this.finalizesTransaction(op)) {
      this.transactionEnded(transactionOf(op));
    }

    this.release(op);
    op.resolve(result);
  }

  private fault(op: PendingOp, error: Error): void {
    if (!this.settle(op)) return;

    // Only an answer from the server ends a transaction. A commit that timed out, or that its
    // caller cancelled, may still be open there, and the rollback that usually follows it must
    // find its stream.
    if (CamusError.is(error) && this.finalizesTransaction(op)) this.transactionEnded(transactionOf(op));

    this.release(op);
    op.reject(error);
  }

  private finalizesTransaction(op: PendingOp): boolean {
    return (
      op.kind === GrpcBatchStatementKind.Commit ||
      op.kind === GrpcBatchStatementKind.CommitIfOk ||
      op.kind === GrpcBatchStatementKind.Rollback
    );
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

    const leases: StreamLease[] = [...this.retiring];

    for (const slot of this.slots) {
      if (slot.current !== undefined) leases.push(slot.current);

      slot.current = undefined;
      slot.inbox.length = 0;
      slot.run.length = 0;
      slot.runLease = undefined;
      slot.runBytes = -1;
    }

    const closed = new CamusError(CamusErrorCode.Generic, 'This gRPC transport is closed.');

    for (const lease of leases) this.close(lease, closed);

    this.retiring.clear();
    this.openTransactions.clear();

    for (const op of [...this.pending.values()]) this.fault(op, closed);

    await Promise.resolve();
  }
}

/** The key one transaction is booked under. A handle is a pair, so both parts are in the key. */
function transactionKey(txnIdPT: bigint | string, txnIdCounter: number): string {
  return `${txnIdPT}:${txnIdCounter}`;
}

function handleKey(handle: GrpcTxnHandle | null | undefined): string | undefined {
  return handle === null || handle === undefined
    ? undefined
    : transactionKey(handle.txnIdPt, handle.txnIdCounter);
}

/** The transaction an operation finishes: by the handle it carries, or by the start it names. */
function transactionOf(op: PendingOp): string | undefined {
  return op.transaction ?? op.startRef?.mintedHandle;
}

function streamClosedError(): CamusError {
  return new CamusError(CamusErrorCode.Generic, 'The gRPC batch stream closed.');
}

/** The failure of a pipeline operation that was left out because another one was cancelled. */
function cancelledError(signal: AbortSignal | undefined): Error {
  if (signal?.aborted === true) return toError(signal.reason);

  return new CamusError(CamusErrorCode.Generic, 'The pipeline was cancelled before it was written.');
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
