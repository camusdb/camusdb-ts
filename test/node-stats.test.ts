import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CamusTokenProvider } from '../src/auth/token-provider.js';
import { CamusClient } from '../src/client.js';
import { CamusProtocol } from '../src/config.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusDiskVolumeRole, nodeStatsFromWire } from '../src/node-stats.js';
import { CamusTransportPool } from '../src/transport/transport-pool.js';
import { loadGrpc } from '../src/transport/grpc/proto.js';
import { FakeCamusServer } from './support/fake-server.js';

/** A REST body as the server writes it, with the envelope beside the fields. */
const REST_BODY = {
  status: 'ok',
  node: {
    nodeId: 'n1',
    endpoint: '10.0.0.1:7070',
    version: '0.15.4',
    clusterMode: true,
    uptimeSeconds: 3600,
    sampledAtUnixMs: 1_760_000_000_000,
  },
  disks: [
    {
      role: 'data',
      path: '/var/lib/camusdb',
      mountPoint: '/',
      totalBytes: 1_000_000_000_000,
      freeBytes: 400_000_000_000,
      availableBytes: 350_000_000_000,
      usedBytes: 600_000_000_000,
      minFreeDiskBytes: 1_073_741_824,
      belowWatermark: false,
      engineBytes: 12_345_678,
    },
    {
      role: 'wal',
      path: '/wal',
      mountPoint: '/wal',
      totalBytes: 100,
      freeBytes: 50,
      availableBytes: 40,
      usedBytes: 50,
      minFreeDiskBytes: 0,
      belowWatermark: false,
      engineBytes: 10,
    },
  ],
  cpu: {
    processCpuPercent: 12.5,
    processCpuWindowMs: 60_000,
    processorCount: 8,
    loadAverage1m: 1.25,
    loadAverage5m: 1.5,
    loadAverage15m: -1,
  },
  memory: {
    processWorkingSetBytes: 500_000_000,
    gcHeapBytes: 200_000_000,
    gcCommittedBytes: 250_000_000,
    gcMemoryLimitBytes: 0,
    hostTotalBytes: 16_000_000_000,
    hostAvailableBytes: 8_000_000_000,
  },
  errors: [{ field: 'cpu.load_average_15m', message: 'not available on this host' }],
};

let http: FakeCamusServer;

beforeAll(async () => {
  http = await FakeCamusServer.start();
});

afterAll(async () => {
  await http.stop();
});

beforeEach(() => {
  http.reset();
  CamusEndpointPool.resetShared();
  CamusTokenProvider.resetShared();
  CamusTransportPool.resetShared();
});

describe('node stats over REST', () => {
  it('reads GET /v1/admin/stats into the model', async () => {
    http.json('v1/admin/stats', REST_BODY);

    const client = new CamusClient({ endpoint: http.endpoint, database: 'stats', timeoutSeconds: 5 });
    const stats = await client.nodeStats();

    expect(http.requestsTo('v1/admin/stats')[0]!.method).toBe('GET');
    expect(stats.address).toBe(http.endpoint);
    expect(stats.node).toMatchObject({ nodeId: 'n1', clusterMode: true, uptimeSeconds: 3600 });
    expect(stats.disks).toHaveLength(2);
    expect(stats.dataVolume?.availableBytes).toBe(350_000_000_000);
    expect(stats.cpu).toMatchObject({ processorCount: 8, loadAverage1m: 1.25, loadAverage15m: -1 });
    expect(stats.memory.gcMemoryLimitBytes).toBe(0);
    expect(stats.errors).toEqual([{ field: 'cpu.load_average_15m', message: 'not available on this host' }]);
  });

  it('reports the server error code', async () => {
    http.json('v1/admin/stats', { status: 'error', code: 'CADB0517', message: 'MONITOR required' }, 403);

    const client = new CamusClient({ endpoint: http.endpoint, database: 'stats', timeoutSeconds: 5 });

    await expect(client.nodeStats()).rejects.toMatchObject({ code: 'CADB0517' });
  });

  it('asks a given endpoint, and refuses one the client was not configured with', async () => {
    http.json('v1/admin/stats', REST_BODY);

    const other = 'http://127.0.0.1:9';
    const client = new CamusClient({
      endpoint: [other, http.endpoint],
      database: 'stats',
      timeoutSeconds: 5,
    });

    expect(client.endpoints).toEqual([other, http.endpoint]);
    expect((await client.nodeStats(http.endpoint)).address).toBe(http.endpoint);
    expect(() => client.nodeStats('http://evil.example')).toThrow(TypeError);
  });
});

describe('the node stats model', () => {
  it('keeps -1 for every part an older server did not send', () => {
    const stats = nodeStatsFromWire('http://a', { status: 'ok' });

    expect(stats.node.uptimeSeconds).toBe(-1);
    expect(stats.cpu.processCpuPercent).toBe(-1);
    expect(stats.memory.hostTotalBytes).toBe(-1);
    expect(stats.disks).toEqual([]);
    expect(stats.dataVolume).toBeUndefined();
  });

  it('reads a size given as a bigint or a decimal string', () => {
    const stats = nodeStatsFromWire('http://a', {
      disks: [{ role: CamusDiskVolumeRole.Data, totalBytes: 2n ** 40n, freeBytes: '1099511627776' }],
    });

    expect(stats.dataVolume?.totalBytes).toBe(2 ** 40);
    expect(stats.dataVolume?.freeBytes).toBe(2 ** 40);
  });
});

describe('node stats over gRPC', () => {
  let server: grpc.Server;
  let endpoint: string;
  let presented: string | undefined;

  beforeAll(async () => {
    const { definition } = await loadGrpc();
    const service = (definition.CamusSql as { service: grpc.ServiceDefinition }).service;

    server = new grpc.Server();

    server.addService(service, {
      getNodeStats: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        presented = call.metadata.get('authorization')[0] as string | undefined;

        callback(null, {
          node: { nodeId: 'n2', endpoint: '10.0.0.2:7070', version: '0.15.4', uptimeSeconds: '7200' },
          disks: [
            {
              role: 'data',
              path: '/data',
              totalBytes: '1000000000000',
              availableBytes: '1',
              belowWatermark: true,
              minFreeDiskBytes: '1073741824',
            },
          ],
          cpu: { processCpuPercent: 3.5, processorCount: 4, loadAverage_1m: 0.75, loadAverage_15m: -1 },
          errors: [],
        });
      },
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, bound) => {
        if (error !== null) reject(error);
        else resolve(bound);
      });
    });

    endpoint = `http://127.0.0.1:${String(port)}`;
  });

  afterAll(async () => {
    await CamusTransportPool.closeAll();
    server.forceShutdown();
  });

  it('calls GetNodeStats and reads the reply into the same model', async () => {
    const client = new CamusClient({
      endpoint,
      database: 'stats',
      protocol: CamusProtocol.Grpc,
      timeoutSeconds: 5,
      accessToken: 'monitor-token',
    });

    const stats = await client.nodeStats();

    expect(presented).toBe('Bearer monitor-token');
    expect(stats.address).toBe(endpoint);
    expect(stats.node).toMatchObject({ nodeId: 'n2', uptimeSeconds: 7200 });
    expect(stats.dataVolume).toMatchObject({ totalBytes: 1_000_000_000_000, belowWatermark: true });
    expect(stats.cpu).toMatchObject({ processCpuPercent: 3.5, loadAverage1m: 0.75, loadAverage15m: -1 });

    // The memory message was not sent, so it keeps -1 and does not read as zeros.
    expect(stats.memory.hostTotalBytes).toBe(-1);
  });
});
