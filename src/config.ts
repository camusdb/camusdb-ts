/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { CamusCredentials } from './auth/credentials.js';
import {
  NO_CREDENTIALS,
  credentialsFromPassword,
  credentialsFromToken,
  hasCredentials,
} from './auth/credentials.js';
import { parseConnectionString, redactConnectionString } from './connection-string.js';
import type { ConnectionStringSettings } from './connection-string.js';
import { CamusEndpointPool } from './endpoint-pool.js';
import { CamusError } from './errors.js';
import { CamusErrorCode } from './error-codes.js';
import type { CamusTransactionOptions } from './options.js';
import { CamusIsolationLevel, CamusLocking, CamusTransactionMode } from './options.js';
import type { DecodeOptions, Int64Mode } from './values/decode.js';

/** The wire protocol a client speaks. */
export const CamusProtocol = {
  /** The REST and JSON HTTP API. This is the default. */
  Rest: 'rest',
  /** The gRPC API. The endpoint must address the server's gRPC port. */
  Grpc: 'grpc',
} as const;

export type CamusProtocol = (typeof CamusProtocol)[keyof typeof CamusProtocol];

/** How a client uses learned statement routing. */
export const CamusRoutingMode = {
  /** Rotate over the configured endpoints. Never negotiate, never learn. */
  Off: 'off',

  /** Negotiate routing metadata and prefer a learned destination for an unpinned statement. */
  Learned: 'learned',

  /**
   * Behave as `learned` when `routingNodes` maps at least two distinct configured endpoints, and
   * as `off` otherwise. One destination is not a routing decision, and a single load-balancer URL
   * is not a set of routable database nodes. This is the default: the trust map is the opt-in, not
   * a second switch.
   */
  Auto: 'auto',
} as const;

export type CamusRoutingMode = (typeof CamusRoutingMode)[keyof typeof CamusRoutingMode];

/** Tuning for the gRPC batch streams. The REST transport ignores all of it. */
export interface GrpcBatchOptions {
  /**
   * How many long-lived `BatchExecute` streams exist per endpoint. It is **not** a cap on in-flight
   * transactions — many transactions hash onto the same streams and interleave — so the default of
   * 2 suits most workloads. Raise it when many long-running streaming queries per endpoint would
   * otherwise queue behind each other.
   */
  readonly channelPoolSize: number;

  /** How many operations one drain must produce before the pump stops waiting for more. */
  readonly coalescingThreshold: number;

  /**
   * How long the pump waits after a multi-operation drain to accumulate a larger burst, in
   * milliseconds. Zero, the default, turns coalescing off. A single-operation drain never waits.
   */
  readonly coalescingDelayMs: number;
}

export const DEFAULT_BATCH_OPTIONS: GrpcBatchOptions = Object.freeze({
  channelPoolSize: 2,
  coalescingThreshold: 10,
  coalescingDelayMs: 0,
});

/** How many statements a client keeps prepared, and how hot a statement must be first. */
export const DEFAULT_MAX_AUTO_PREPARE = 128;
export const DEFAULT_AUTO_PREPARE_MIN_USAGES = 2;

/** Fallback token lifetime, comfortably inside the server's 15-minute default. */
export const DEFAULT_TOKEN_LIFETIME_MS = 600_000;

/** The backup admin API's own timeout. Taking a full backup routinely outlasts a statement. */
export const DEFAULT_BACKUP_TIMEOUT_SECONDS = 300;

/** The connection-string key that waives the refusal to send credentials in the clear. */
export const ALLOW_INSECURE_CREDENTIALS_KEY = 'AllowInsecureCredentials';

/**
 * How a client is configured, written as an object rather than as a connection string.
 *
 * Every field maps to one connection-string key, and the two forms are interchangeable. Use
 * `CamusClient.fromConnectionString` for the string form.
 */
export interface CamusClientOptions {
  /**
   * The base URL of the CamusDB endpoint, or several to rotate through. When a request fails
   * because an endpoint is unreachable, that endpoint is set aside for 30 seconds.
   */
  readonly endpoint: string | readonly string[];

  /** The database name sent with every request. */
  readonly database: string;

  /** The request timeout in seconds. Default 10. */
  readonly timeoutSeconds?: number;

  /** The wire protocol. Default `rest`. */
  readonly protocol?: CamusProtocol;

  /** The user to authenticate as. */
  readonly user?: string;

  /** That user's password. */
  readonly password?: string;

  /** A bearer token obtained elsewhere, used as written instead of logging in. */
  readonly accessToken?: string;

  /** Fallback seconds to reuse a token when the server reports no expiry. Default 600. */
  readonly tokenLifetimeSeconds?: number;

  /** How many statements to keep prepared. Default 128. Zero turns automatic preparation off. */
  readonly maxAutoPrepare?: number;

  /** Executions of the same SQL before it is prepared. Default 2. */
  readonly autoPrepareMinUsages?: number;

  /** gRPC only: long-lived `BatchExecute` streams per endpoint. Default 2. */
  readonly channelPoolSize?: number;

  /** gRPC only: operations one drain must produce before the pump stops waiting. Default 10. */
  readonly coalescingThreshold?: number;

  /** gRPC only: milliseconds the pump waits after a multi-operation drain. Default 0. */
  readonly coalescingDelayMs?: number;

  /** The HTTP endpoint for the backup admin API. It is required when `protocol` is `grpc`. */
  readonly backupEndpoint?: string;

  /** The backup admin request timeout in seconds. Default 300. */
  readonly backupTimeoutSeconds?: number;

  /** True waives the refusal to send credentials to a remote plaintext endpoint. */
  readonly allowInsecureCredentials?: boolean;

  /** Learned statement routing. Default `auto`. */
  readonly routingMode?: CamusRoutingMode;

  /**
   * The trust map from server node identities to endpoint pool members, as
   * `{ 'camus-a:7070': 'http://a:5095' }` or as the connection-string form
   * `'camus-a:7070=http://a:5095,camus-b:7070=http://b:5095'`.
   */
  readonly routingNodes?: Readonly<Record<string, string>> | string;

  /** The ceiling in milliseconds on how long a learned route may be reused. Default 5000. */
  readonly routingMaxHintAgeMs?: number;

  /** Concurrency defaults for every transaction and autocommit statement this client runs. */
  readonly defaultTransactionOptions?: CamusTransactionOptions;

  /** How an `int64` column reaches a caller. Default `auto`. */
  readonly int64?: Int64Mode;
}

/** The settings a client actually runs on, after both input forms are resolved. */
export interface ResolvedConfig {
  readonly endpointList: string;
  readonly database: string;
  readonly timeoutSeconds: number;
  readonly protocol: CamusProtocol;
  readonly credentials: CamusCredentials;
  readonly tokenLifetimeMs: number;
  readonly maxAutoPrepare: number;
  readonly autoPrepareMinUsages: number;
  readonly batch: GrpcBatchOptions;
  readonly backupEndpoint: string | undefined;
  readonly backupTimeoutSeconds: number;
  readonly allowInsecureCredentials: boolean;
  readonly routingMode: CamusRoutingMode;
  readonly routingNodes: ReadonlyMap<string, string>;
  readonly routingMaxHintAgeMs: number;
  readonly defaultTransactionOptions: CamusTransactionOptions;
  readonly decode: DecodeOptions;

  /** The connection string as written, when the client was built from one. */
  readonly connectionString: string | undefined;
}

/** Resolves an options object. */
export function resolveOptions(options: CamusClientOptions): ResolvedConfig {
  const endpointList = Array.isArray(options.endpoint)
    ? options.endpoint.join(',')
    : (options.endpoint as string);

  if (typeof endpointList !== 'string' || endpointList.trim().length === 0) {
    throw new CamusError(CamusErrorCode.Generic, 'Endpoint is required.');
  }

  if (typeof options.database !== 'string' || options.database.trim().length === 0) {
    throw new CamusError(CamusErrorCode.Generic, 'Database is required.');
  }

  const config: ResolvedConfig = {
    endpointList,
    database: options.database,
    timeoutSeconds: positiveOr(options.timeoutSeconds, 10),
    protocol: options.protocol ?? CamusProtocol.Rest,
    credentials: resolveCredentials(options),
    tokenLifetimeMs: positiveOr(options.tokenLifetimeSeconds, 0) * 1000 || DEFAULT_TOKEN_LIFETIME_MS,
    maxAutoPrepare: nonNegativeOr(options.maxAutoPrepare, DEFAULT_MAX_AUTO_PREPARE),
    autoPrepareMinUsages: positiveOr(options.autoPrepareMinUsages, DEFAULT_AUTO_PREPARE_MIN_USAGES),
    batch: {
      channelPoolSize: atLeastOr(options.channelPoolSize, 1, DEFAULT_BATCH_OPTIONS.channelPoolSize),
      coalescingThreshold: atLeastOr(
        options.coalescingThreshold,
        1,
        DEFAULT_BATCH_OPTIONS.coalescingThreshold,
      ),
      coalescingDelayMs: atLeastOr(options.coalescingDelayMs, 0, DEFAULT_BATCH_OPTIONS.coalescingDelayMs),
    },
    backupEndpoint: options.backupEndpoint,
    backupTimeoutSeconds: positiveOr(options.backupTimeoutSeconds, DEFAULT_BACKUP_TIMEOUT_SECONDS),
    allowInsecureCredentials: options.allowInsecureCredentials === true,
    routingMode: options.routingMode ?? CamusRoutingMode.Auto,
    routingNodes: resolveRoutingNodes(options.routingNodes, endpointList),
    routingMaxHintAgeMs: atLeastOr(options.routingMaxHintAgeMs, 1, 5000),
    defaultTransactionOptions: options.defaultTransactionOptions ?? {},
    decode: { int64: options.int64 ?? 'auto' },
    connectionString: undefined,
  };

  ensureCredentialsAreNotSentInClear(config);

  return config;
}

/** Resolves a connection string. */
export function resolveConnectionString(connectionString: string): ResolvedConfig {
  const settings = parseConnectionString(connectionString);

  const endpointList = settings.get('Endpoint');

  if (endpointList === undefined || endpointList.trim().length === 0) {
    throw new CamusError(CamusErrorCode.Generic, 'Endpoint is required.');
  }

  const database = settings.get('Database');

  if (database === undefined) {
    throw new CamusError(CamusErrorCode.Generic, 'Database is required.');
  }

  const config: ResolvedConfig = {
    endpointList,
    database,
    timeoutSeconds: parsePositiveInt(settings.get('Timeout'), 10),
    protocol: parseEnum(settings.get('Protocol'), CamusProtocol, CamusProtocol.Rest),
    credentials: credentialsFromSettings(settings),
    tokenLifetimeMs: parsePositiveInt(settings.get('TokenLifetime'), 0) * 1000 || DEFAULT_TOKEN_LIFETIME_MS,
    maxAutoPrepare: parseNonNegativeInt(settings.get('MaxAutoPrepare'), DEFAULT_MAX_AUTO_PREPARE),
    autoPrepareMinUsages: parsePositiveInt(
      settings.get('AutoPrepareMinUsages'),
      DEFAULT_AUTO_PREPARE_MIN_USAGES,
    ),
    batch: {
      channelPoolSize: parseIntAtLeast(
        settings.get('ChannelPoolSize'),
        1,
        DEFAULT_BATCH_OPTIONS.channelPoolSize,
      ),
      coalescingThreshold: parseIntAtLeast(
        settings.get('CoalescingThreshold'),
        1,
        DEFAULT_BATCH_OPTIONS.coalescingThreshold,
      ),
      coalescingDelayMs: parseIntAtLeast(
        settings.get('CoalescingDelay'),
        0,
        DEFAULT_BATCH_OPTIONS.coalescingDelayMs,
      ),
    },
    backupEndpoint: settings.first('BackupEndpoint'),
    backupTimeoutSeconds: parsePositiveInt(settings.get('BackupTimeout'), DEFAULT_BACKUP_TIMEOUT_SECONDS),
    allowInsecureCredentials: settings.get(ALLOW_INSECURE_CREDENTIALS_KEY)?.toLowerCase() === 'true',
    routingMode: parseEnum(settings.get('RoutingMode'), CamusRoutingMode, CamusRoutingMode.Auto),
    routingNodes: resolveRoutingNodes(settings.get('RoutingNodes'), endpointList),
    routingMaxHintAgeMs: parseIntAtLeast(settings.get('RoutingMaxHintAge'), 1, 5000),
    defaultTransactionOptions: {
      isolationLevel: parseEnum(settings.get('IsolationLevel'), CamusIsolationLevel, undefined),
      mode: parseEnum(settings.get('TransactionMode'), CamusTransactionMode, undefined),
      locking: parseEnum(settings.get('Locking'), CamusLocking, undefined),
    },
    decode: { int64: parseInt64Mode(settings.get('Int64')) },
    connectionString,
  };

  ensureCredentialsAreNotSentInClear(config);

  return config;
}

/**
 * Where the backup admin API lives.
 *
 * The backup routes are REST and JSON only — they have no SQL form and no gRPC service — so a gRPC
 * client, whose endpoint addresses the gRPC port, must say where the HTTP port is. Rather than
 * send HTTP at a gRPC port and fail obscurely, that case is refused with a message naming the
 * setting to fill in.
 *
 * A configured backup endpoint is used as written, with no rotation: backups are node-level, and a
 * coordinated backup must reach the coordinator specifically.
 */
export function resolveBackupEndpoint(config: ResolvedConfig, pool: CamusEndpointPool): string {
  if (config.backupEndpoint !== undefined && config.backupEndpoint.trim().length > 0) {
    return config.backupEndpoint;
  }

  if (config.protocol !== CamusProtocol.Rest) {
    throw new CamusError(
      CamusErrorCode.Generic,
      'The backup admin API is REST-only; a gRPC client must set backupEndpoint to the server’s HTTP endpoint.',
    );
  }

  return pool.next();
}

/**
 * Identifies the deployment when deciding which clients may share a token or a transport: the
 * endpoint list plus the protocol. The same credentials against two different servers never share
 * a token, and a REST client and a gRPC client each hold the token their own transport minted.
 */
export function deploymentKey(config: ResolvedConfig): string {
  return `${config.endpointList}|${config.protocol}`;
}

/** The connection string with every secret masked, or a rebuilt summary for an options object. */
export function describeConfig(config: ResolvedConfig): string {
  if (config.connectionString !== undefined) return redactConnectionString(config.connectionString);

  const parts = [`Endpoint=${config.endpointList}`, `Database=${config.database}`];

  if (config.protocol !== CamusProtocol.Rest) parts.push(`Protocol=${config.protocol}`);
  if (config.credentials.user !== undefined) parts.push(`User=${config.credentials.user};Password=***`);
  if (config.credentials.accessToken !== undefined) parts.push('AccessToken=***');

  return parts.join(';');
}

/**
 * Refuses to carry credentials to an endpoint that cannot protect them.
 *
 * A password is posted to `/login` and a bearer token rides every later request. On an `http://`
 * endpoint both cross the network in the clear, and the server's own `CADB0519` check — which a
 * deployment can switch off — only fires after the password has already been sent. So the client
 * refuses first, before anything leaves the process.
 *
 * A loopback endpoint is allowed: the traffic never reaches a network, and that is how the
 * documented local examples and the test suite connect. Everything else must be `https://`, unless
 * `allowInsecureCredentials` is set — for a deployment reached over a private link that terminates
 * TLS elsewhere.
 *
 * The backup endpoint is held to the same rule, and deliberately: the token it receives is the
 * client's own, which the backup admin API requires to be superuser-grade.
 */
export function ensureCredentialsAreNotSentInClear(config: ResolvedConfig): void {
  if (!hasCredentials(config.credentials)) return;
  if (config.allowInsecureCredentials) return;

  for (const endpoint of config.endpointList.split(',')) {
    const trimmed = endpoint.trim();
    if (trimmed.length > 0) ensureEndpointIsSecure(trimmed, 'Endpoint');
  }

  if (config.backupEndpoint !== undefined && config.backupEndpoint.trim().length > 0) {
    ensureEndpointIsSecure(config.backupEndpoint.trim(), 'BackupEndpoint');
  }
}

function ensureEndpointIsSecure(endpoint: string, key: string): void {
  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    throw new CamusError(CamusErrorCode.Generic, `The ${key} '${endpoint}' is not an absolute URL.`);
  }

  if (url.protocol === 'https:' || isLoopback(url.hostname)) return;

  throw new CamusError(
    CamusErrorCode.InsecureTransport,
    `This configuration sends credentials to the ${key} '${endpoint}', which is neither https nor loopback. ` +
      'The password and the bearer token would cross the network in the clear. Use https, or set ' +
      `${ALLOW_INSECURE_CREDENTIALS_KEY} when the endpoint is reached over a link that protects them.`,
  );
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127\./.test(host);
}

function resolveCredentials(options: CamusClientOptions): CamusCredentials {
  if (options.accessToken !== undefined && options.accessToken.length > 0) {
    return credentialsFromToken(options.accessToken);
  }

  if (options.user !== undefined && options.user.length > 0) {
    return credentialsFromPassword(options.user, options.password ?? '');
  }

  return NO_CREDENTIALS;
}

function credentialsFromSettings(settings: ConnectionStringSettings): CamusCredentials {
  const token = settings.first('AccessToken');
  if (token !== undefined) return credentialsFromToken(token);

  const user = settings.first('User', 'UserId', 'Uid', 'Username');

  if (user !== undefined) {
    return credentialsFromPassword(user, settings.get('Password') ?? settings.get('Pwd') ?? '');
  }

  return NO_CREDENTIALS;
}

/**
 * The trust map, filtered to addresses the endpoint pool actually lists.
 *
 * Advice becomes a destination only through this map, and only when the mapped address is a member
 * of the endpoint pool. An entry naming any other address is dropped, so a response can never
 * steer traffic at an address the operator did not list. Malformed entries are skipped rather than
 * thrown on, the way the other tuning settings treat unusable input.
 */
function resolveRoutingNodes(
  nodes: Readonly<Record<string, string>> | string | undefined,
  endpointList: string,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();

  if (nodes === undefined) return map;

  const pool = CamusEndpointPool.forEndpoints(endpointList);
  const pairs: [string, string][] = [];

  if (typeof nodes === 'string') {
    for (const entry of nodes.split(',')) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;

      // The node identity is `host:port` and the address is a URL, so the first '=' is the only
      // separator that is not ambiguous.
      const separator = trimmed.indexOf('=');
      if (separator <= 0 || separator === trimmed.length - 1) continue;

      pairs.push([trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim()]);
    }
  } else {
    for (const [nodeId, address] of Object.entries(nodes)) {
      pairs.push([nodeId.trim(), address.trim()]);
    }
  }

  for (const [nodeId, address] of pairs) {
    if (nodeId.length > 0 && pool.contains(address)) map.set(nodeId, address);
  }

  return map;
}

function parseEnum<T extends Record<string, string>, D>(
  raw: string | undefined,
  members: T,
  fallback: D,
): T[keyof T] | D {
  if (raw === undefined) return fallback;

  const wanted = raw.trim().toLowerCase();

  for (const value of Object.values(members)) {
    if (value.toLowerCase() === wanted) return value as T[keyof T];
  }

  return fallback;
}

function parseInt64Mode(raw: string | undefined): Int64Mode {
  switch (raw?.trim().toLowerCase()) {
    case 'number':
      return 'number';
    case 'bigint':
      return 'bigint';
    default:
      return 'auto';
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseIntAtLeast(raw: string | undefined, minimum: number, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function atLeastOr(value: number | undefined, minimum: number, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
}
