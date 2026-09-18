/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * The CamusDB connector for Node.js.
 *
 * ```ts
 * import { CamusClient } from 'camusdb';
 *
 * const client = new CamusClient({ endpoint: 'http://localhost:8082', database: 'test' });
 *
 * const { rows } = await client.query<Robot>('SELECT * FROM robots WHERE year = @year', { year: 1974 });
 * ```
 */

// ─── The client ─────────────────────────────────────────────────────────────

export { CamusClient } from './client.js';
export type {
  AutocommitStatementOptions,
  ExecuteResult,
  QueryResult,
  StatementOptions,
  TransactionRunOptions,
} from './client.js';

export { CamusTransaction } from './transaction.js';
export { CamusQueryStream } from './query-stream.js';
export { CamusBackupClient } from './backup.js';
export type {
  CamusBackupGcDeletion,
  CamusBackupGcOrphan,
  CamusBackupGcResult,
  CamusBackupInfo,
} from './backup.js';

// ─── Configuration ──────────────────────────────────────────────────────────

export { CamusProtocol, CamusRoutingMode, DEFAULT_BATCH_OPTIONS } from './config.js';
export type { CamusClientOptions, GrpcBatchOptions, ResolvedConfig } from './config.js';

export { parseConnectionString, redactConnectionString } from './connection-string.js';

export {
  CamusIsolationLevel,
  CamusLocking,
  CamusTransactionMode,
  DEFAULT_TRANSACTION_OPTIONS,
  OPTIMISTIC_TRANSACTION_OPTIONS,
  SNAPSHOT_TRANSACTION_OPTIONS,
} from './options.js';
export type { CamusTransactionOptions } from './options.js';

// ─── Errors and retries ─────────────────────────────────────────────────────

export { CamusError } from './errors.js';
export { CamusErrorCode } from './error-codes.js';
export { computeDelayMs, isRetryable, withRetry } from './retry.js';
export type { RetryOptions } from './retry.js';

// ─── Values ─────────────────────────────────────────────────────────────────

export { ColumnType, columnTypeName, isColumnType } from './column-type.js';
export type { ColumnValue } from './column-value.js';
export { camus } from './values/typed.js';
export type { TypedParameter } from './values/typed.js';
export type { Parameters, ParameterValue } from './values/encode.js';
export type { DecodeOptions, Int64Mode } from './values/decode.js';
export { decodeValue } from './values/decode.js';

export {
  CamusColumnStorage,
  isColumnStorage,
  rewriteStorageStatement,
  setColumnStorageStatement,
} from './column-storage.js';

export { CamusObjectId } from './object-id.js';
export { CamusVector } from './vector.js';

export {
  TICKS_PER_DAY,
  TICKS_PER_MILLISECOND,
  UNIX_EPOCH_TICKS,
  dateToDayTicks,
  dateToTicks,
  ticksToDate,
} from './values/ticks.js';

export { bytesToUuid, isUuid, uuidToBytes } from './values/uuid.js';

// ─── Results ────────────────────────────────────────────────────────────────

export { CamusResultSet } from './result-set.js';
export type { CamusColumn } from './result-set.js';
export type { CamusBranchRow } from './transport/transport.js';

// ─── The query result cache ─────────────────────────────────────────────────

export { CamusCacheStatus, cacheHint, evictAllCacheStatement, evictCacheStatement } from './cache.js';
export type { CamusCacheMetadata } from './cache.js';

// ─── Learned routing ────────────────────────────────────────────────────────

export { CamusRoutingDisposition, ROUTING_ACCEPT_VERSION } from './routing/advice.js';
export type { CamusRoutingAdvice } from './routing/advice.js';

// ─── Clocks ─────────────────────────────────────────────────────────────────

export { formatHlc } from './hlc.js';
export type { CamusHlcTimestamp } from './hlc.js';

// ─── Process lifetime ───────────────────────────────────────────────────────

export { CamusTransportPool } from './transport/transport-pool.js';

// ─── SQL text helpers ───────────────────────────────────────────────────────

export {
  delimitIdentifier,
  sqlLiteral,
  validateBareName,
  validateIdentifier,
  validateSqlLiteral,
} from './sql-syntax.js';
