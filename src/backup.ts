/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from './errors.js';
import { CamusErrorCode } from './error-codes.js';
import { asNumber } from './json.js';
import type { ClientRuntime } from './runtime.js';
import { sendJson } from './transport/http.js';

/** One backup in the node's catalog. */
export interface CamusBackupInfo {
  readonly backupId: string;
  readonly formatVersion: number;

  /** `full`, `incremental`, or `coordinated`. */
  readonly type: string;

  readonly createdAtUtc?: string | undefined;

  /** The backup this one builds on. Absent for a full backup. */
  readonly parentBackupId?: string | undefined;

  readonly partitionCount: number;

  readonly clusterSnapshotNode?: number | undefined;
  readonly clusterSnapshotPhysical?: number | undefined;
  readonly clusterSnapshotCounter?: number | undefined;

  /** What the caller asked for, and what the server actually took. */
  readonly requestedKind?: string | undefined;
  readonly actualKind?: string | undefined;

  /** Why the server took a different kind than the one requested. */
  readonly substitutionReason?: string | undefined;

  /** True when the server marked this backup unusable for a restore. */
  readonly isInvalid: boolean;
  readonly invalidReason?: string | undefined;

  /** The window this backup can restore to, in Unix milliseconds. */
  readonly minRecoverablePhysicalMs?: number | undefined;
  readonly maxRecoverablePhysicalMs?: number | undefined;

  readonly clusterId?: string | undefined;
  readonly coordinatorNode?: string | undefined;

  /** True when the server took a different kind of backup than the one requested. */
  readonly wasSubstituted: boolean;
}

/** One backup that retention deleted, or would delete. */
export interface CamusBackupGcDeletion {
  readonly backupId: string;
  readonly type: string;
  readonly createdAtUtc?: string | undefined;
  readonly bytes: number;
  readonly reason: string;
}

/** One file or directory that belongs to no backup. */
export interface CamusBackupGcOrphan {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly reason: string;
}

/** What a retention run did, or would do. */
export interface CamusBackupGcResult {
  /** False for a preview: nothing was deleted. */
  readonly applied: boolean;
  readonly bytesReclaimed: number;
  readonly retentionDeletions: CamusBackupGcDeletion[];
  readonly orphanReclamations: CamusBackupGcOrphan[];
}

interface BackupEnvelope {
  status?: string;
  code?: string;
  message?: string;
  backup?: unknown;
  backups?: unknown[];
  applied?: boolean;
  bytesReclaimed?: number;
  retentionDeletions?: unknown[];
  orphanReclamations?: unknown[];
}

/**
 * The node's online backup administration API: take a full, incremental, or coordinated backup,
 * list the catalog, resolve a restore chain, and run retention.
 *
 * It is server-level and node-wide, not scoped to the client's database. Every database on the
 * server shares one storage node, so a backup captures all of them. It needs a superuser token
 * when authentication is on.
 *
 * Restore is an offline operator procedure and is deliberately not reachable here.
 *
 * The routes are REST and JSON only. They have no SQL form and no gRPC service, so a gRPC client
 * must configure `backupEndpoint` to say where the HTTP port is.
 */
export class CamusBackupClient {
  private readonly runtime: ClientRuntime;

  /** @internal Reach it through `client.backups`. */
  constructor(runtime: ClientRuntime) {
    this.runtime = runtime;
  }

  /** Takes a full backup: a complete copy of the node's base image. */
  takeFullBackup(signal?: AbortSignal): Promise<CamusBackupInfo> {
    return this.takeBackup(['v1', 'backups', 'full'], undefined, 'Take full backup failed', signal);
  }

  /** Takes an incremental backup, relative to `parentBackupId`. */
  takeIncrementalBackup(parentBackupId: string, signal?: AbortSignal): Promise<CamusBackupInfo> {
    return this.takeBackup(
      ['v1', 'backups', 'incremental'],
      { parentBackupId },
      'Take incremental backup failed',
      signal,
    );
  }

  /** Takes a cluster-coordinated backup. It must reach the coordinator node specifically. */
  takeCoordinatedBackup(signal?: AbortSignal): Promise<CamusBackupInfo> {
    return this.takeBackup(
      ['v1', 'backups', 'coordinated'],
      undefined,
      'Take coordinated backup failed',
      signal,
    );
  }

  /** Every backup in the node's catalog. */
  listBackups(signal?: AbortSignal): Promise<CamusBackupInfo[]> {
    return this.list(['v1', 'backups'], 'List backups failed', signal);
  }

  /**
   * The chain of backups a restore of `leafBackupId` needs, from its base full backup to the leaf.
   * Use it to check that every link is present and valid before relying on the leaf.
   */
  getChain(leafBackupId: string, signal?: AbortSignal): Promise<CamusBackupInfo[]> {
    return this.list(['v1', 'backups', leafBackupId, 'chain'], 'Get backup chain failed', signal);
  }

  /** Reports what retention would delete, without deleting anything. */
  previewGarbageCollection(signal?: AbortSignal): Promise<CamusBackupGcResult> {
    return this.collect(true, signal);
  }

  /** Runs retention: deletes the backups its policy has aged out, and reclaims orphaned files. */
  collectGarbage(signal?: AbortSignal): Promise<CamusBackupGcResult> {
    return this.collect(false, signal);
  }

  private async takeBackup(
    path: readonly string[],
    body: unknown,
    failureMessage: string,
    signal: AbortSignal | undefined,
  ): Promise<CamusBackupInfo> {
    const reply = await this.send(path, 'POST', body, undefined, signal);

    if (reply.status !== 'ok' || reply.backup === undefined || reply.backup === null) {
      throw new CamusError(reply.code ?? CamusErrorCode.Generic, reply.message ?? failureMessage);
    }

    return readBackupInfo(reply.backup);
  }

  private async list(
    path: readonly string[],
    failureMessage: string,
    signal: AbortSignal | undefined,
  ): Promise<CamusBackupInfo[]> {
    const reply = await this.send(path, 'GET', undefined, undefined, signal);

    if (reply.status !== 'ok') {
      throw new CamusError(reply.code ?? CamusErrorCode.Generic, reply.message ?? failureMessage);
    }

    return (reply.backups ?? []).map(readBackupInfo);
  }

  private async collect(dryRun: boolean, signal: AbortSignal | undefined): Promise<CamusBackupGcResult> {
    const reply = await this.send(
      ['v1', 'backups', 'gc'],
      'POST',
      undefined,
      { dryRun: dryRun ? 'true' : 'false' },
      signal,
    );

    if (reply.status !== 'ok') {
      throw new CamusError(
        reply.code ?? CamusErrorCode.Generic,
        reply.message ?? 'Backup garbage collection failed',
      );
    }

    return {
      applied: reply.applied === true,
      bytesReclaimed: asNumber(reply.bytesReclaimed),
      retentionDeletions: (reply.retentionDeletions ?? []).map(readDeletion),
      orphanReclamations: (reply.orphanReclamations ?? []).map(readOrphan),
    };
  }

  private async send(
    path: readonly string[],
    method: 'GET' | 'POST',
    body: unknown,
    query: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<BackupEnvelope> {
    const endpoint = this.runtime.backupEndpoint();

    return sendJson<BackupEnvelope>(this.runtime.pool, {
      endpoint,
      path,
      method,
      body,
      query,
      token: await this.runtime.auth.getToken(signal),
      timeoutSeconds: this.runtime.config.backupTimeoutSeconds,
      signal,
    });
  }
}

function readBackupInfo(value: unknown): CamusBackupInfo {
  const record = (value ?? {}) as Record<string, unknown>;

  const requestedKind = readString(record.requestedKind);
  const actualKind = readString(record.actualKind);

  return {
    backupId: readString(record.backupId) ?? '',
    formatVersion: asNumber(record.formatVersion),
    type: readString(record.type) ?? '',
    createdAtUtc: readString(record.createdAtUtc),
    parentBackupId: readString(record.parentBackupId),
    partitionCount: asNumber(record.partitionCount),
    clusterSnapshotNode: readOptionalNumber(record.clusterSnapshotNode),
    clusterSnapshotPhysical: readOptionalNumber(record.clusterSnapshotPhysical),
    clusterSnapshotCounter: readOptionalNumber(record.clusterSnapshotCounter),
    requestedKind,
    actualKind,
    substitutionReason: readString(record.substitutionReason),
    isInvalid: record.isInvalid === true,
    invalidReason: readString(record.invalidReason),
    minRecoverablePhysicalMs: readOptionalNumber(record.minRecoverablePhysicalMs),
    maxRecoverablePhysicalMs: readOptionalNumber(record.maxRecoverablePhysicalMs),
    clusterId: readString(record.clusterId),
    coordinatorNode: readString(record.coordinatorNode),
    wasSubstituted: requestedKind !== undefined && actualKind !== undefined && requestedKind !== actualKind,
  };
}

function readDeletion(value: unknown): CamusBackupGcDeletion {
  const record = (value ?? {}) as Record<string, unknown>;

  return {
    backupId: readString(record.backupId) ?? '',
    type: readString(record.type) ?? '',
    createdAtUtc: readString(record.createdAtUtc),
    bytes: asNumber(record.bytes),
    reason: readString(record.reason) ?? '',
  };
}

function readOrphan(value: unknown): CamusBackupGcOrphan {
  const record = (value ?? {}) as Record<string, unknown>;

  return {
    name: readString(record.name) ?? '',
    isDirectory: record.isDirectory === true,
    reason: readString(record.reason) ?? '',
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;

  return asNumber(value);
}
