/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { GrpcBatchExecuteRequest, GrpcSqlRequest, GrpcValue } from './messages.js';

/**
 * The `BatchExecute` stream frame contract.
 *
 * A frame is one stream message that carries several complete operations, on the request side, or
 * several complete responses, on the response side. The fixed cost of a stream message is then
 * paid once per frame rather than once per operation or per row. A frame gives no atomicity and
 * no ordering that the stream does not already give.
 *
 * The server keeps the same constants. The two must agree, as the two copies of `camus_sql.proto`
 * must.
 */

/**
 * The response header a server writes when a stream opens to say that it reads request frames.
 * The value is the highest contract version the server reads.
 *
 * A server built before frames writes nothing, and runs an unknown kind as a non-query. A client
 * therefore waits for this announcement and never probes for it.
 */
export const FRAME_HEADER = 'camusdb-batch-frames';

/**
 * The request header a client writes when it opens a stream to say that it reads response frames.
 * The value is the highest contract version the client reads.
 *
 * Without it, a server knows the client reads frames only once a request frame arrives. A single
 * caller sends no request frame, so one large read would stay at one message per row. A server
 * built before frames ignores the header.
 */
export const FRAME_ACCEPT_HEADER = 'camusdb-batch-frames-accept';

/** The contract version this client writes, and the highest it reads. */
export const FRAME_VERSION = 1;

/** The most operations one frame carries. A server refuses the operations past it. */
export const FRAME_MAX_ITEMS = 256;

/**
 * The most serialized operation bytes one frame carries.
 *
 * It sits far below the 4 MiB default message limit of gRPC, and on purpose. A message over the
 * limit of the transport is refused before it is parsed, which resets the stream that every other
 * operation shares. The sender must never build one. An operation larger than this budget on its
 * own travels as a plain single message.
 */
export const FRAME_MAX_BYTES = 1024 * 1024;

/**
 * True when a header value announces a contract version this client writes.
 *
 * The whole value must be digits. `Number.parseInt` stops at the first character it cannot read,
 * so it would read `1x` as version 1 and treat a header this client does not understand as an
 * announcement.
 */
export function announcesFrames(value: string | undefined): boolean {
  if (value === undefined) return false;

  const text = value.trim();

  if (!/^\d+$/.test(text)) return false;

  return Number(text) >= FRAME_VERSION;
}

/**
 * An upper bound on the bytes one operation adds to a frame.
 *
 * `@grpc/proto-loader` builds a message as a plain object, which carries no serialized size. An
 * exact figure costs a second serialization of every payload, and a large value now travels this
 * path. The budget sits at a quarter of the message limit, so a generous estimate is the cheaper
 * side of the trade: it fills a frame less than it could, and it never builds one the transport
 * refuses.
 */
export function frameCost(request: GrpcBatchExecuteRequest): number {
  return ENVELOPE_BYTES + MESSAGE_BYTES + sqlRequestCost(request.request);
}

/** What a protobuf tag and a length prefix add around one nested message or one string. */
const ENVELOPE_BYTES = 8;

/** What a message of small scalar fields costs. Generous on purpose. */
const MESSAGE_BYTES = 32;

function sqlRequestCost(request: GrpcSqlRequest | undefined): number {
  if (request === undefined) return 0;

  let cost = MESSAGE_BYTES + textCost(request.database) + textCost(request.sql);

  if (request.parameters !== undefined) {
    for (const [name, value] of Object.entries(request.parameters)) {
      cost += MESSAGE_BYTES + textCost(name) + valueCost(value);
    }
  }

  if (request.positionalParameters !== undefined) {
    for (const value of request.positionalParameters) cost += valueCost(value);
  }

  return cost;
}

function valueCost(value: GrpcValue): number {
  let cost = MESSAGE_BYTES;

  cost += textCost(value.stringValue);
  cost += bytesCost(value.bytesValue);
  cost += bytesCost(value.uuidValue);

  if (value.arrayValue !== undefined) {
    for (const item of value.arrayValue.items) cost += valueCost(item);
  }

  return cost;
}

function textCost(text: string | undefined): number {
  return text === undefined ? 0 : ENVELOPE_BYTES + Buffer.byteLength(text, 'utf8');
}

function bytesCost(bytes: Buffer | undefined): number {
  return bytes === undefined ? 0 : ENVELOPE_BYTES + bytes.length;
}
