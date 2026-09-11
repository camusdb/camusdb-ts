/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * The shapes `@grpc/proto-loader` builds from `camus_sql.proto`.
 *
 * The loader constructs these at run time, so they carry no types of their own. Writing them out
 * here is what keeps the rest of the gRPC transport type-checked: a renamed field is then a
 * compile error in one file rather than an `undefined` at run time.
 *
 * Two loader settings shape every declaration below. A 64-bit field arrives as a decimal string,
 * because a JavaScript number cannot name every 64-bit integer. A `oneof` adds a discriminator
 * field naming the branch that is set.
 */

/** A 64-bit field on the wire. The loader writes one as a decimal string. */
export type Int64Wire = string;

export const GrpcColumnType = {
  Null: 0,
  Id: 1,
  Integer64: 2,
  String: 3,
  Bool: 4,
  Float64: 5,
  Float32: 6,
  Bytes: 7,
  Date: 8,
  DateTime: 9,
  Array: 10,
  Uuid: 11,
} as const;

export const GrpcIsolationLevel = {
  Unspecified: 0,
  ReadCommitted: 1,
  Serializable: 2,
} as const;

export const GrpcTransactionMode = {
  Unspecified: 0,
  ReadWrite: 1,
  ReadOnly: 2,
} as const;

export const GrpcLockingMode = {
  Unspecified: 0,
  Pessimistic: 1,
  Optimistic: 2,
} as const;

export const GrpcRoutingDisposition = {
  Unspecified: 0,
  Prefer: 1,
  Clear: 2,
} as const;

export const GrpcRoutingReuseScope = {
  Unspecified: 0,
  StatementParametersIndependent: 1,
} as const;

/** Which branch of `Value.kind` is set. It is the field name, as the loader spells it. */
export type ValueKind =
  | 'nullValue'
  | 'idValue'
  | 'int64Value'
  | 'stringValue'
  | 'boolValue'
  | 'float64Value'
  | 'float32Value'
  | 'bytesValue'
  | 'dateValue'
  | 'datetimeValue'
  | 'arrayValue'
  | 'uuidValue';

export interface GrpcValue {
  kind?: ValueKind | undefined;
  nullValue?: number;
  idValue?: string;
  int64Value?: Int64Wire;
  stringValue?: string;
  boolValue?: boolean;
  float64Value?: number;
  float32Value?: number;
  bytesValue?: Buffer;
  dateValue?: Int64Wire;
  datetimeValue?: Int64Wire;
  arrayValue?: GrpcArrayValue;
  uuidValue?: Buffer;
}

export interface GrpcArrayValue {
  elementType: number;
  items: GrpcValue[];
}

export interface GrpcColumnSchema {
  name: string;
  type: number;
}

export interface GrpcResultSchema {
  columns: GrpcColumnSchema[];
}

export interface GrpcResultRow {
  values: GrpcValue[];
}

export interface GrpcHlcTimestamp {
  l: Int64Wire;
  c: number;
}

export interface GrpcCacheMetadata {
  status: string;
  bypassReason: string;
  name: string;
  cachedAtHlc?: GrpcHlcTimestamp | null;
  ageMs?: Int64Wire | null;
}

export interface GrpcRoutingAdviceMessage {
  version: number;
  disposition: number;
  preferredNodeId: string;
  reuseScope: number;
  dependencyToken: string;
  maxAgeMs: number;
  provenance: string;
  reason: string;
}

export interface GrpcTxnHandle {
  txnIdPt: Int64Wire;
  txnIdCounter: number;
  causalTokenN: number;
  causalTokenL: Int64Wire;
  causalTokenC: Int64Wire;
}

export interface GrpcSqlRequest {
  database?: string;
  sql?: string;
  parameters?: Record<string, GrpcValue>;
  txnHandle?: GrpcTxnHandle | null;
  isolationLevel?: number;
  transactionMode?: number;
  locking?: number;
  causalTokenL?: Int64Wire;
  causalTokenC?: Int64Wire;
  causalTokenN?: number;
  statementId?: number;
  positionalParameters?: GrpcValue[];
  priority?: number;
  routingAcceptVersion?: number;
}

export interface GrpcNonQueryReply {
  affectedRows: number;
  causalTokenL: Int64Wire;
  causalTokenC: Int64Wire;
  causalTokenN: number;
  warning: string;
  routing?: GrpcRoutingAdviceMessage | null;
}

export interface GrpcDdlReply {
  causalTokenL: Int64Wire;
  causalTokenC: Int64Wire;
  causalTokenN: number;
  affectedRows: number;
  warning: string;
}

export interface GrpcCommitReply {
  causalTokenL: Int64Wire;
  causalTokenC: Int64Wire;
  causalTokenN: number;
}

export interface GrpcPrepareReply {
  statementId: number;
  parameterNames: string[];
}

export interface GrpcQueryComplete {
  total: Int64Wire;
  causalTokenL: Int64Wire;
  causalTokenC: Int64Wire;
  causalTokenN: number;
  cacheMetadata?: GrpcCacheMetadata | null;
  routing?: GrpcRoutingAdviceMessage | null;
}

export interface GrpcBatchError {
  code: string;
  message: string;
}

/** The statement kinds `BatchExecute` multiplexes over one stream. */
export const GrpcBatchStatementKind = {
  Unspecified: 0,
  Query: 1,
  NonQuery: 2,
  Start: 3,
  Commit: 4,
  Rollback: 5,
  Prepare: 6,
  Close: 7,
} as const;

export type GrpcBatchStatementKind = (typeof GrpcBatchStatementKind)[keyof typeof GrpcBatchStatementKind];

export interface GrpcBatchExecuteRequest {
  requestId: number;
  kind: GrpcBatchStatementKind;
  request: GrpcSqlRequest;
}

/** Which branch of `BatchExecuteResponse.payload` is set. */
export type BatchPayloadCase =
  | 'schema'
  | 'row'
  | 'queryComplete'
  | 'nonQuery'
  | 'error'
  | 'startReply'
  | 'commitReply'
  | 'rollbackReply'
  | 'prepareReply'
  | 'closeReply';

export interface GrpcBatchExecuteResponse {
  requestId: number;
  payload?: BatchPayloadCase | undefined;
  schema?: GrpcResultSchema;
  row?: GrpcResultRow;
  queryComplete?: GrpcQueryComplete;
  nonQuery?: GrpcNonQueryReply;
  error?: GrpcBatchError;
  startReply?: GrpcTxnHandle;
  commitReply?: GrpcCommitReply;
  rollbackReply?: Record<string, never>;
  prepareReply?: GrpcPrepareReply;
  closeReply?: Record<string, never>;
}

export interface GrpcLoginReply {
  token: string;
  expiresAtUnixMs: Int64Wire;
  expiresInSeconds: Int64Wire;
}

export interface GrpcPingReply {
  message: string;
}

export interface GrpcInsertRowRequest {
  database: string;
  table: string;
  values: Record<string, GrpcValue>;
  txnHandle?: GrpcTxnHandle | null;
  causalTokenL?: Int64Wire;
  causalTokenC?: Int64Wire;
  causalTokenN?: number;
  locking?: number;
  priority?: number;
}
