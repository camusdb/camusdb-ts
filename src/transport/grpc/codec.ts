/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { makeCacheMetadata } from '../../cache.js';
import type { CamusCacheMetadata } from '../../cache.js';
import { ColumnType, isColumnType } from '../../column-type.js';
import type { ColumnValue } from '../../column-value.js';
import { NULL_VALUE } from '../../column-value.js';
import { CamusError } from '../../errors.js';
import { CamusErrorCode } from '../../error-codes.js';
import { CamusResultSet } from '../../result-set.js';
import type { CamusRoutingAdvice } from '../../routing/advice.js';
import { makeRoutingAdvice } from '../../routing/advice.js';
import { bytesToHalves, halvesToBytes, uuidToBytes } from '../../values/uuid.js';
import type {
  GrpcArrayValue,
  GrpcCacheMetadata,
  GrpcResultRow,
  GrpcResultSchema,
  GrpcRoutingAdviceMessage,
  GrpcValue,
  Int64Wire,
  ValueKind,
} from './messages.js';
import { GrpcRoutingDisposition, GrpcRoutingReuseScope } from './messages.js';

/**
 * Converts between a `ColumnValue` and the compact-raw `Value` message.
 *
 * Every 64-bit field crosses as a decimal string, because the proto loader is configured that way,
 * so a `bigint` converts to and from it exactly.
 */

/** The wire message for one value. */
export function encodeValue(value: ColumnValue): GrpcValue {
  switch (value.type) {
    case ColumnType.Null:
      return { nullValue: 0 };

    case ColumnType.Id:
      return { idValue: value.strValue ?? '' };

    case ColumnType.Integer64:
      return { int64Value: toWire(value.longValue) };

    case ColumnType.String:
      return { stringValue: value.strValue ?? '' };

    case ColumnType.Bool:
      return { boolValue: value.boolValue ?? false };

    case ColumnType.Float64:
      return { float64Value: value.floatValue ?? 0 };

    case ColumnType.Float32:
      return { float32Value: value.floatValue ?? 0 };

    case ColumnType.Bytes:
      return { bytesValue: Buffer.from(value.bytesValue ?? new Uint8Array(0)) };

    case ColumnType.Date:
      return { dateValue: toWire(value.longValue) };

    case ColumnType.DateTime:
      return { datetimeValue: toWire(value.longValue) };

    case ColumnType.Uuid:
      return { uuidValue: Buffer.from(encodeUuid(value)) };

    case ColumnType.Array:
      return { arrayValue: encodeArray(value) };

    default:
      throw new CamusError(
        CamusErrorCode.InvalidParameter,
        `Cannot encode the column type ${String(value.type)} for gRPC.`,
      );
  }
}

/**
 * The `ColumnValue` for one wire message.
 *
 * A message the loader decoded carries a `kind` field naming the branch that is set. One this
 * driver built does not, and neither would one from a loader configured without that field, so the
 * branch is inferred from which field is present when `kind` is absent. Only a `oneof` branch that
 * was actually set is ever present on a decoded message, so the inference cannot pick the wrong
 * one.
 */
export function decodeValue(value: GrpcValue): ColumnValue {
  switch (value.kind ?? valueKindOf(value)) {
    case 'idValue':
      return { type: ColumnType.Id, strValue: value.idValue ?? '' };

    case 'int64Value':
      return { type: ColumnType.Integer64, longValue: fromWire(value.int64Value) };

    case 'stringValue':
      return { type: ColumnType.String, strValue: value.stringValue ?? '' };

    case 'boolValue':
      return { type: ColumnType.Bool, boolValue: value.boolValue ?? false };

    case 'float64Value':
      return { type: ColumnType.Float64, floatValue: value.float64Value ?? 0 };

    case 'float32Value':
      return { type: ColumnType.Float32, floatValue: value.float32Value ?? 0 };

    case 'bytesValue':
      return { type: ColumnType.Bytes, bytesValue: toUint8Array(value.bytesValue) };

    case 'dateValue':
      return { type: ColumnType.Date, longValue: fromWire(value.dateValue) };

    case 'datetimeValue':
      return { type: ColumnType.DateTime, longValue: fromWire(value.datetimeValue) };

    case 'uuidValue':
      return decodeUuid(value.uuidValue);

    case 'arrayValue':
      return decodeArray(value.arrayValue);

    default:
      return NULL_VALUE;
  }
}

/** Which branch of a `Value` is set, for a message that carries no discriminator. */
function valueKindOf(value: GrpcValue): ValueKind | undefined {
  for (const kind of VALUE_KINDS) {
    if (value[kind] !== undefined) return kind;
  }

  return undefined;
}

const VALUE_KINDS: readonly ValueKind[] = [
  'idValue',
  'int64Value',
  'stringValue',
  'boolValue',
  'float64Value',
  'float32Value',
  'bytesValue',
  'dateValue',
  'datetimeValue',
  'arrayValue',
  'uuidValue',
  'nullValue',
];

/** A whole query result, from the schema message and the rows that followed it. */
export function buildResultSet(
  schema: GrpcResultSchema | undefined,
  rows: readonly GrpcResultRow[],
): CamusResultSet {
  const columns = schema?.columns ?? [];
  const columnCount = columns.length;

  const names: string[] = new Array<string>(columnCount);
  const types: ColumnType[] = new Array<ColumnType>(columnCount);

  for (let i = 0; i < columnCount; i++) {
    const column = columns[i]!;
    names[i] = column.name;
    types[i] = isColumnType(column.type) ? column.type : ColumnType.Null;
  }

  const cells: ColumnValue[] = new Array<ColumnValue>(rows.length * columnCount).fill(NULL_VALUE);

  for (let r = 0; r < rows.length; r++) {
    const values = rows[r]!.values;
    const base = r * columnCount;
    const limit = Math.min(columnCount, values.length);

    for (let c = 0; c < limit; c++) cells[base + c] = decodeValue(values[c]!);
  }

  return new CamusResultSet(names, types, cells, rows.length);
}

/** The cache verdict a query terminator carried, or `undefined` when the statement was unhinted. */
export function decodeCacheMetadata(
  metadata: GrpcCacheMetadata | null | undefined,
): CamusCacheMetadata | undefined {
  if (metadata === null || metadata === undefined) return undefined;

  const hlc = metadata.cachedAtHlc;

  return makeCacheMetadata({
    rawStatus: metadata.status.length > 0 ? metadata.status : undefined,
    bypassReason: metadata.bypassReason.length > 0 ? metadata.bypassReason : undefined,
    name: metadata.name.length > 0 ? metadata.name : undefined,
    cachedAtHlc: hlc ? { l: fromWire(hlc.l), c: hlc.c } : undefined,
    ageMs:
      metadata.ageMs === null || metadata.ageMs === undefined ? undefined : Number(fromWire(metadata.ageMs)),
  });
}

/** The routing advice a reply carried, or `undefined` when it carried none. */
export function decodeRoutingAdvice(
  advice: GrpcRoutingAdviceMessage | null | undefined,
): CamusRoutingAdvice | undefined {
  if (advice === null || advice === undefined) return undefined;

  return makeRoutingAdvice({
    version: advice.version,
    disposition: dispositionName(advice.disposition),
    preferredNodeId: advice.preferredNodeId.length > 0 ? advice.preferredNodeId : undefined,
    reuseScope:
      advice.reuseScope === GrpcRoutingReuseScope.StatementParametersIndependent
        ? 'statementParametersIndependent'
        : undefined,
    dependencyToken: advice.dependencyToken.length > 0 ? advice.dependencyToken : undefined,
    maxAgeMs: advice.maxAgeMs,
    reason: advice.reason.length > 0 ? advice.reason : undefined,
  });
}

/** A 64-bit value as the wire carries it. */
export function toWire(value: bigint | undefined): Int64Wire {
  return (value ?? 0n).toString();
}

/** A 64-bit wire value as a `bigint`. It reads a number too, in case a loader setting changes. */
export function fromWire(value: Int64Wire | number | undefined | null): bigint {
  if (value === undefined || value === null) return 0n;
  if (typeof value === 'number') return BigInt(Math.trunc(value));

  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function dispositionName(disposition: number): string | undefined {
  switch (disposition) {
    case GrpcRoutingDisposition.Prefer:
      return 'prefer';
    case GrpcRoutingDisposition.Clear:
      return 'clear';
    default:
      return undefined;
  }
}

function encodeArray(value: ColumnValue): GrpcArrayValue {
  return {
    elementType: value.arrayElementType ?? ColumnType.Null,
    items: (value.arrayValues ?? []).map(encodeValue),
  };
}

function decodeArray(array: GrpcArrayValue | undefined): ColumnValue {
  const elementType = array?.elementType ?? ColumnType.Null;

  return {
    type: ColumnType.Array,
    arrayValues: (array?.items ?? []).map(decodeValue),
    arrayElementType: isColumnType(elementType) ? elementType : ColumnType.Null,
  };
}

/**
 * The 16 big-endian bytes of a UUID parameter.
 *
 * A parameter reaches here with the raw halves filled in, which is how the encoder builds one, or
 * as a canonical string, which a hand-built value may hold. Both collapse to the same bytes; the
 * halves path writes them directly, with no string to parse. All-zero halves fall through to the
 * string forms, so a zero UUID carried only as a string still encodes correctly.
 */
function encodeUuid(value: ColumnValue): Uint8Array {
  const high = value.uuidHigh ?? 0n;
  const low = value.longValue ?? 0n;

  if (high !== 0n || low !== 0n) return halvesToBytes(high, low);

  const text = value.strValue ?? value.uuidValue;

  return text !== undefined && text !== null && text.length > 0 ? uuidToBytes(text) : halvesToBytes(0n, 0n);
}

function decodeUuid(uuid: Buffer | undefined): ColumnValue {
  if (uuid === undefined || uuid.length !== 16) {
    throw new CamusError(
      CamusErrorCode.Generic,
      `A UUID value must be 16 bytes; got ${String(uuid?.length ?? 0)}.`,
    );
  }

  const { high, low } = bytesToHalves(toUint8Array(uuid));

  return { type: ColumnType.Uuid, uuidHigh: high, longValue: low };
}

function toUint8Array(buffer: Buffer | Uint8Array | undefined): Uint8Array {
  if (buffer === undefined) return new Uint8Array(0);

  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
