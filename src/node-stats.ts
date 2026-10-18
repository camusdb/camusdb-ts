/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { asNumber } from './json.js';

/** The `role` of a disk volume. */
export const CamusDiskVolumeRole = {
  /** The volume that holds the node's data directory. The write gate watches this one. */
  Data: 'data',

  /** A Raft WAL directory on a volume of its own. */
  Wal: 'wal',
} as const;

/**
 * One node's disk, CPU, and memory, as `CamusClient.nodeStats` returns them.
 *
 * The server sends the same fields over gRPC (`GetNodeStats`) and over REST (`GET /v1/admin/stats`),
 * so this shape is the same for both protocols.
 *
 * **The -1 rule.** Every size is in bytes. A value that the node could not read is `-1`, never `0`,
 * and `errors` names the field and the reason. A value that the server did not send, for example
 * from an older server, also reads as `-1`.
 *
 * **One node.** The answer is for the node that received the call, which `address` names, and not
 * for the cluster. To monitor a cluster, make one call for each endpoint in `CamusClient.endpoints`.
 */
export interface CamusNodeStats {
  /** The configured endpoint that this answer came from. The driver sets it; the server does not send it. */
  readonly address: string;

  readonly node: CamusNodeIdentity;

  /** The data volume first. A `wal` entry follows only when the WAL is on its own volume. */
  readonly disks: readonly CamusDiskVolumeStats[];

  readonly cpu: CamusCpuStats;

  readonly memory: CamusMemoryStats;

  /** One entry for each value reported as -1. */
  readonly errors: readonly CamusNodeStatsError[];

  /**
   * The volume that holds the node's data directory, which the write gate watches. It is
   * `undefined` when the server sent none.
   */
  readonly dataVolume: CamusDiskVolumeStats | undefined;
}

/** Which node answered, and when. */
export interface CamusNodeIdentity {
  /** The node's Raft node id. It is empty early in boot. */
  readonly nodeId: string;

  /** The node's Raft endpoint (`host:port`). It is empty early in boot. */
  readonly endpoint: string;

  readonly version: string;
  readonly clusterMode: boolean;
  readonly uptimeSeconds: number;

  /** When the server built the answer, in Unix epoch milliseconds (UTC). */
  readonly sampledAtUnixMs: number;
}

/** One volume that the engine writes to. */
export interface CamusDiskVolumeStats {
  /** `data` or `wal`. See `CamusDiskVolumeRole`. */
  readonly role: string;

  readonly path: string;

  /** The mount point that holds `path`. It is empty when it is not known yet. */
  readonly mountPoint: string;

  readonly totalBytes: number;
  readonly freeBytes: number;

  /** The free space that the server can still write. The watermark compares this value. */
  readonly availableBytes: number;

  readonly usedBytes: number;

  /** The write-admission watermark (`min_free_disk_bytes`). It is 0 on a `wal` entry, which the gate does not watch. */
  readonly minFreeDiskBytes: number;

  /** True while the node refuses writes because this volume is too full (`CADB0536`). */
  readonly belowWatermark: boolean;

  /** The bytes of the storage engine's own files on this volume. */
  readonly engineBytes: number;
}

/** The CPU of the server process and of its host. */
export interface CamusCpuStats {
  /** The process CPU as a share of the whole node (all `processorCount` processors), 0 to 100. */
  readonly processCpuPercent: number;

  /** The window that `processCpuPercent` is averaged over, in milliseconds. */
  readonly processCpuWindowMs: number;

  readonly processorCount: number;

  /** The host load averages. They are -1 on a host that has none. */
  readonly loadAverage1m: number;
  readonly loadAverage5m: number;
  readonly loadAverage15m: number;
}

/** The memory of the server process, of its managed heap, and of its host. */
export interface CamusMemoryStats {
  readonly processWorkingSetBytes: number;
  readonly gcHeapBytes: number;
  readonly gcCommittedBytes: number;

  /** The managed heap limit in force. `0` means that no limit is in force. */
  readonly gcMemoryLimitBytes: number;

  /** The cgroup memory limit when one applies, and the host's physical memory if not. */
  readonly hostTotalBytes: number;

  readonly hostAvailableBytes: number;
}

/** Why one value is -1. `field` is the value's path, for example `cpu.load_average_1m`. */
export interface CamusNodeStatsError {
  readonly field: string;
  readonly message: string;
}

type WireRecord = Record<string, unknown>;

/**
 * Builds the model from a REST body or a gRPC reply.
 *
 * The two use the same camelCase names, with one exception: the gRPC loader spells
 * `load_average_1m` as `loadAverage_1m`, and REST spells it `loadAverage1m`. Both are read. A part
 * that the reply does not carry keeps the -1 defaults, so an older server's gap does not read as
 * zero.
 *
 * @internal
 */
export function nodeStatsFromWire(address: string, wire: unknown): CamusNodeStats {
  const body = asRecord(wire) ?? {};
  const node = asRecord(body.node);
  const cpu = asRecord(body.cpu);
  const memory = asRecord(body.memory);

  const disks = asArray(body.disks).map((entry) => {
    const disk = asRecord(entry) ?? {};

    return {
      role: asText(disk.role),
      path: asText(disk.path),
      mountPoint: asText(disk.mountPoint),
      totalBytes: asNumber(disk.totalBytes, -1),
      freeBytes: asNumber(disk.freeBytes, -1),
      availableBytes: asNumber(disk.availableBytes, -1),
      usedBytes: asNumber(disk.usedBytes, -1),
      minFreeDiskBytes: asNumber(disk.minFreeDiskBytes, -1),
      belowWatermark: disk.belowWatermark === true,
      engineBytes: asNumber(disk.engineBytes, -1),
    } satisfies CamusDiskVolumeStats;
  });

  return {
    address,
    node: {
      nodeId: asText(node?.nodeId),
      endpoint: asText(node?.endpoint),
      version: asText(node?.version),
      clusterMode: node?.clusterMode === true,
      uptimeSeconds: asNumber(node?.uptimeSeconds, -1),
      sampledAtUnixMs: asNumber(node?.sampledAtUnixMs, -1),
    },
    disks,
    cpu: {
      processCpuPercent: asNumber(cpu?.processCpuPercent, -1),
      processCpuWindowMs: asNumber(cpu?.processCpuWindowMs, -1),
      processorCount: asNumber(cpu?.processorCount, -1),
      loadAverage1m: asNumber(cpu?.loadAverage1m ?? cpu?.loadAverage_1m, -1),
      loadAverage5m: asNumber(cpu?.loadAverage5m ?? cpu?.loadAverage_5m, -1),
      loadAverage15m: asNumber(cpu?.loadAverage15m ?? cpu?.loadAverage_15m, -1),
    },
    memory: {
      processWorkingSetBytes: asNumber(memory?.processWorkingSetBytes, -1),
      gcHeapBytes: asNumber(memory?.gcHeapBytes, -1),
      gcCommittedBytes: asNumber(memory?.gcCommittedBytes, -1),
      gcMemoryLimitBytes: asNumber(memory?.gcMemoryLimitBytes, -1),
      hostTotalBytes: asNumber(memory?.hostTotalBytes, -1),
      hostAvailableBytes: asNumber(memory?.hostAvailableBytes, -1),
    },
    errors: asArray(body.errors).map((entry) => {
      const error = asRecord(entry) ?? {};
      return { field: asText(error.field), message: asText(error.message) };
    }),
    dataVolume: disks.find((disk) => disk.role === CamusDiskVolumeRole.Data),
  };
}

function asRecord(value: unknown): WireRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as WireRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
