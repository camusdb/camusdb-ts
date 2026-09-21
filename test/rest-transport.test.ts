import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NO_CREDENTIALS, credentialsFromPassword } from '../src/auth/credentials.js';
import { CamusTokenProvider } from '../src/auth/token-provider.js';
import { ColumnType } from '../src/column-type.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusError } from '../src/errors.js';
import { CamusIsolationLevel, CamusLocking, CamusTransactionMode } from '../src/options.js';
import { RestTransport } from '../src/transport/rest-transport.js';
import type { TransportSqlRequest } from '../src/transport/transport.js';
import { stringifyLossless } from '../src/json.js';
import { dateToTicks } from '../src/values/ticks.js';
import { uuidToHalves } from '../src/values/uuid.js';
import { FakeCamusServer, respondJson, respondNdjson } from './support/fake-server.js';

let server: FakeCamusServer;

beforeAll(async () => {
  server = await FakeCamusServer.start();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  server.reset();
  CamusEndpointPool.resetShared();
  CamusTokenProvider.resetShared();
});

function unauthenticated(): { transport: RestTransport; pool: CamusEndpointPool } {
  const pool = new CamusEndpointPool(server.endpoint);

  const auth = new CamusTokenProvider({
    credentials: NO_CREDENTIALS,
    resolveLoginClient: () => {
      throw new Error('no login expected');
    },
    resolveEndpoint: () => server.endpoint,
    resolveTimeoutSeconds: () => 5,
  });

  return { transport: new RestTransport(pool, auth), pool };
}

function sqlRequest(overrides: Partial<TransportSqlRequest> = {}): TransportSqlRequest {
  return {
    endpoint: server.endpoint,
    database: 'test',
    sql: 'SELECT 1',
    timeoutSeconds: 5,
    prepared: false,
    routingAcceptVersion: 0,
    ...overrides,
  };
}

describe('executeQuery', () => {
  it('decodes a schema and its positional rows', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const { high, low } = uuidToHalves(uuid);
    const ticks = dateToTicks(new Date('2024-03-15T12:00:00Z'));

    // Written with the lossless serializer, so the 64-bit halves and the tick count reach the
    // driver exactly as a real server would send them.
    server.json(
      'execute-sql-query',
      stringifyLossless({
        status: 'ok',
        columns: [
          { name: 'id', type: ColumnType.Id },
          { name: 'name', type: ColumnType.String },
          { name: 'year', type: ColumnType.Integer64 },
          { name: 'price', type: ColumnType.Float64 },
          { name: 'enabled', type: ColumnType.Bool },
          { name: 'photo', type: ColumnType.Bytes },
          { name: 'made', type: ColumnType.DateTime },
          { name: 'key', type: ColumnType.Uuid },
          { name: 'tags', type: ColumnType.Array },
        ],
        rows: [
          ['abc', 'r1', 1974, 1.5, true, 'AQID', ticks, [high, low], ['a', 'b']],
          ['def', null, 2, 0.5, false, null, null, null, []],
        ],
      }),
    );

    const { transport } = unauthenticated();
    const result = await transport.executeQuery(sqlRequest());

    expect(result.resultSet.rowCount).toBe(2);
    expect(result.resultSet.columnNames).toEqual([
      'id',
      'name',
      'year',
      'price',
      'enabled',
      'photo',
      'made',
      'key',
      'tags',
    ]);

    expect(result.resultSet.cell(0, 0)).toEqual({ type: ColumnType.Id, strValue: 'abc' });
    expect(result.resultSet.cell(0, 2).longValue).toBe(1974n);
    expect(result.resultSet.cell(0, 3).floatValue).toBe(1.5);
    expect([...result.resultSet.cell(0, 5).bytesValue!]).toEqual([1, 2, 3]);
    expect(result.resultSet.cell(0, 6).longValue).toBe(ticks);
    expect(result.resultSet.cell(0, 7).uuidHigh).toBe(high);
    expect(result.resultSet.cell(0, 7).longValue).toBe(low);
    expect(result.resultSet.cell(0, 8).arrayValues).toHaveLength(2);
    expect(result.resultSet.cell(1, 1).type).toBe(ColumnType.Null);
  });

  it('reports the schema of a result with no rows', async () => {
    server.json('execute-sql-query', {
      status: 'ok',
      columns: [{ name: 'id', type: ColumnType.Id }],
      rows: [],
    });

    const { transport } = unauthenticated();
    const result = await transport.executeQuery(sqlRequest());

    expect(result.resultSet.rowCount).toBe(0);
    expect(result.resultSet.columns).toEqual([{ name: 'id', type: ColumnType.Id, typeName: 'Id' }]);
  });

  it('keeps a 64-bit value exact', async () => {
    server.on('execute-sql-query', (_request, response) => {
      respondJson(
        response,
        200,
        '{"status":"ok","columns":[{"name":"n","type":2}],"rows":[[9223372036854775807]]}',
      );
    });

    const { transport } = unauthenticated();
    const result = await transport.executeQuery(sqlRequest());

    expect(result.resultSet.cell(0, 0).longValue).toBe(9223372036854775807n);
  });

  it('recovers a uuid the server mis-tagged as a string', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const { high, low } = uuidToHalves(uuid);

    server.json(
      'execute-sql-query',
      stringifyLossless({
        status: 'ok',
        columns: [{ name: 'key', type: ColumnType.String }],
        rows: [[[high, low]]],
      }),
    );

    const { transport } = unauthenticated();
    const result = await transport.executeQuery(sqlRequest());

    expect(result.resultSet.cell(0, 0).type).toBe(ColumnType.Uuid);
  });

  it('reads cache metadata and routing advice', async () => {
    server.json('execute-sql-query', {
      status: 'ok',
      columns: [],
      rows: [],
      cacheStatus: 'hit',
      cacheName: 'robots',
      ageMs: 120,
      cachedAtHlc: { l: 17, c: 3 },
      routing: {
        version: 1,
        disposition: 'prefer',
        preferredNodeId: 'camus-a:7070',
        reuseScope: 'statementParametersIndependent',
        maxAgeMs: 1000,
      },
    });

    const { transport } = unauthenticated();
    const result = await transport.executeQuery(sqlRequest());

    expect(result.cacheMetadata?.isHit).toBe(true);
    expect(result.cacheMetadata?.ageMs).toBe(120);
    expect(result.cacheMetadata?.cachedAtHlc).toEqual({ l: 17n, c: 3 });
    expect(result.routing?.preferredNodeId).toBe('camus-a:7070');
  });

  it('sends the transaction handle when one is given', async () => {
    server.json('execute-sql-query', { status: 'ok', columns: [], rows: [] });

    const { transport } = unauthenticated();

    await transport.executeQuery(sqlRequest({ txnIdPT: 12345678901234567890n, txnIdCounter: 7 }));

    const body = server.requestsTo('execute-sql-query')[0]!;

    expect(body.rawBody).toContain('"txnIdPT":12345678901234567890');
    expect((body.body as { txnIdCounter: number }).txnIdCounter).toBe(7);
  });

  it('asks for routing metadata only when it was negotiated', async () => {
    server.json('execute-sql-query', { status: 'ok', columns: [], rows: [] });

    const { transport } = unauthenticated();

    await transport.executeQuery(sqlRequest());
    await transport.executeQuery(sqlRequest({ routingAcceptVersion: 1 }));

    const bodies = server.requestsTo('execute-sql-query').map((r) => r.body as Record<string, unknown>);

    expect(bodies[0]!.routingAcceptVersion).toBeUndefined();
    expect(bodies[1]!.routingAcceptVersion).toBe(1);
  });

  it('reports the server error code', async () => {
    server.json('execute-sql-query', { status: 'failed', code: 'CADB0502', message: 'conflict' }, 409);

    const { transport } = unauthenticated();

    await expect(transport.executeQuery(sqlRequest())).rejects.toMatchObject({
      code: 'CADB0502',
      message: 'conflict',
    });
  });

  it('masks a credential the server echoed into its message', async () => {
    server.json(
      'execute-sql-query',
      { status: 'failed', code: 'CADB0000', message: 'rejected Bearer abc.def for user' },
      400,
    );

    const { transport } = unauthenticated();

    await expect(transport.executeQuery(sqlRequest())).rejects.toMatchObject({
      message: 'rejected Bearer *** for user',
    });
  });

  it('sets an unreachable endpoint aside', async () => {
    const pool = new CamusEndpointPool('http://127.0.0.1:1');
    pool.clock = () => 0;

    const auth = new CamusTokenProvider({
      credentials: NO_CREDENTIALS,
      resolveLoginClient: () => {
        throw new Error('no login expected');
      },
      resolveEndpoint: () => 'http://127.0.0.1:1',
      resolveTimeoutSeconds: () => 5,
    });

    const transport = new RestTransport(pool, auth);

    await expect(transport.executeQuery(sqlRequest({ endpoint: 'http://127.0.0.1:1' }))).rejects.toThrow(
      CamusError,
    );

    expect(pool.isQuarantined('http://127.0.0.1:1')).toBe(true);
  });

  it('re-throws the cancellation the caller asked for, as it is', async () => {
    server.on('execute-sql-query', () => {
      // Never answers, so only the caller's signal can end the request.
    });

    const { transport, pool } = unauthenticated();
    pool.clock = () => 0;

    const controller = new AbortController();
    const pending = transport.executeQuery(sqlRequest({ signal: controller.signal }));

    controller.abort(new Error('caller stopped'));

    await expect(pending).rejects.toThrow('caller stopped');
    expect(pool.isQuarantined(server.endpoint)).toBe(false);
  });

  it('gives up on its own deadline', async () => {
    server.on('execute-sql-query', () => {
      // Never answers.
    });

    const { transport } = unauthenticated();

    await expect(transport.executeQuery(sqlRequest({ timeoutSeconds: 1 }))).rejects.toThrow(CamusError);
  });
});

describe('executeNonQuery and executeDdl', () => {
  it('reports the affected-row count', async () => {
    server.json('execute-sql-non-query', { status: 'ok', rows: 3 });

    const { transport } = unauthenticated();
    const result = await transport.executeNonQuery(sqlRequest({ sql: 'DELETE FROM robots' }));

    expect(result.affectedRows).toBe(3);
  });

  it('sends the autocommit concurrency knobs, omitting the unset ones', async () => {
    server.json('execute-sql-non-query', { status: 'ok', rows: 0 });

    const { transport } = unauthenticated();

    await transport.executeNonQuery(
      sqlRequest({
        sql: 'DELETE FROM robots',
        autocommitOptions: {
          isolationLevel: CamusIsolationLevel.Serializable,
          locking: CamusLocking.Optimistic,
        },
      }),
    );

    expect(server.requestsTo('execute-sql-non-query')[0]!.body).toMatchObject({
      isolationLevel: 'Serializable',
      locking: 'Optimistic',
    });

    expect(
      (server.requestsTo('execute-sql-non-query')[0]!.body as Record<string, unknown>).transactionMode,
    ).toBeUndefined();
  });

  it('runs a schema statement on the DDL route', async () => {
    server.json('execute-sql-ddl', { status: 'ok' });

    const { transport } = unauthenticated();

    expect(await transport.executeDdl(sqlRequest({ sql: 'CREATE TABLE t (id id)' }))).toBe(true);
    expect(server.requestsTo('execute-sql-ddl')[0]!.body).toMatchObject({
      databaseName: 'test',
      sql: 'CREATE TABLE t (id id)',
    });
  });

  it('inserts a row through the typed route', async () => {
    server.json('insert', { status: 'ok', rows: 1 });

    const { transport } = unauthenticated();

    const affected = await transport.insert({
      endpoint: server.endpoint,
      database: 'test',
      table: 'robots',
      values: new Map([['name', { type: ColumnType.String, strValue: 'r1' }]]),
      timeoutSeconds: 5,
    });

    expect(affected).toBe(1);
    expect(server.requestsTo('insert')[0]!.body).toMatchObject({
      databaseName: 'test',
      tableName: 'robots',
      values: { name: { type: ColumnType.String, strValue: 'r1' } },
    });
  });

  it('reports whether the server answers a ping', async () => {
    server.json('ping', { status: 'ok' });

    const { transport } = unauthenticated();

    expect(await transport.ping(server.endpoint, 5)).toBe(true);
  });
});

describe('transactions', () => {
  it('begins and reports the minted handle exactly', async () => {
    server.on('start-transaction', (_request, response) => {
      respondJson(response, 200, '{"status":"ok","txnIdPT":638765432109876543,"txnIdCounter":9}');
    });

    const { transport } = unauthenticated();

    const result = await transport.startTransaction(
      server.endpoint,
      'test',
      { isolationLevel: CamusIsolationLevel.Serializable, mode: CamusTransactionMode.ReadOnly },
      5,
    );

    expect(result.txnIdPT).toBe(638765432109876543n);
    expect(result.txnIdCounter).toBe(9);

    expect(server.requestsTo('start-transaction')[0]!.body).toMatchObject({
      databaseName: 'test',
      isolationLevel: 'Serializable',
      transactionMode: 'ReadOnly',
    });
  });

  it('commits and rolls back on their own routes', async () => {
    server.json('commit-transaction', { status: 'ok' });
    server.json('rollback-transaction', { status: 'ok' });

    const { transport } = unauthenticated();

    await transport.finalizeTransaction(true, server.endpoint, 'test', 1n, 2, undefined, 5);
    await transport.finalizeTransaction(false, server.endpoint, 'test', 1n, 2, undefined, 5);

    expect(server.callCount('commit-transaction')).toBe(1);
    expect(server.callCount('rollback-transaction')).toBe(1);
  });

  it('reports a failed begin', async () => {
    server.json('start-transaction', { status: 'failed', code: 'CADB0505', message: 'MustRetry' });

    const { transport } = unauthenticated();

    await expect(transport.startTransaction(server.endpoint, 'test', {}, 5)).rejects.toMatchObject({
      code: 'CADB0505',
    });
  });
});

describe('database administration', () => {
  it('creates and drops a database on its own route', async () => {
    server.json('create-db', { status: 'ok' });
    server.json('drop-db', { status: 'ok' });

    const { transport } = unauthenticated();

    await transport.createDatabase(server.endpoint, 'test', true, 5);
    await transport.dropDatabase(server.endpoint, 'test', 5);

    expect(server.requestsTo('create-db')[0]!.body).toMatchObject({
      databaseName: 'test',
      ifNotExists: true,
    });
  });

  it('reports a refused creation with its code', async () => {
    server.json('create-db', { status: 'failed', code: 'CADB0012', message: 'already registered' });

    const { transport } = unauthenticated();

    await expect(transport.createDatabase(server.endpoint, 'test', false, 5)).rejects.toMatchObject({
      code: 'CADB0012',
    });
  });

  // Branching has no REST route of its own: the server implements it only as SQL, so the statement
  // goes down the ordinary DDL and query routes.
  it('creates a branch as a composed DDL statement', async () => {
    server.json('execute-sql-ddl', { status: 'ok' });

    const { transport } = unauthenticated();

    await transport.createBranchDatabase(server.endpoint, 'child', 'root', false, 5);

    expect((server.requestsTo('execute-sql-ddl')[0]!.body as Record<string, unknown>).sql).toBe(
      'CREATE DATABASE `child` BRANCH FROM `root`',
    );

    await transport.createBranchDatabase(server.endpoint, 'child', 'root', true, 5);

    expect((server.requestsTo('execute-sql-ddl')[1]!.body as Record<string, unknown>).sql).toBe(
      'CREATE DATABASE IF NOT EXISTS `child` BRANCH FROM `root`',
    );
  });

  it('lists branches and ancestors as composed queries', async () => {
    server.on('execute-sql-query', (request, response) => {
      const sql = (request.body as { sql?: string }).sql ?? '';

      if (sql.startsWith('SHOW BRANCHES')) {
        respondJson(response, 200, {
          status: 'ok',
          columns: [
            { name: 'database', type: ColumnType.String },
            { name: 'id', type: ColumnType.String },
            { name: 'depth', type: ColumnType.Integer64 },
            { name: 'parent', type: ColumnType.String },
            { name: 'fork_timestamp', type: ColumnType.String },
          ],
          rows: [['child', 'abc', 1, 'root', 'HLC(1:17:3)']],
        });
        return;
      }

      // SHOW ANCESTORS emits the same shape without a parent column.
      respondJson(response, 200, {
        status: 'ok',
        columns: [
          { name: 'database', type: ColumnType.String },
          { name: 'depth', type: ColumnType.Integer64 },
        ],
        rows: [['root', 1]],
      });
    });

    const { transport } = unauthenticated();

    expect(await transport.showBranches(server.endpoint, 'root', 5)).toEqual([
      { database: 'child', id: 'abc', depth: 1, parent: 'root', forkTimestamp: 'HLC(1:17:3)' },
    ]);

    expect(await transport.showAncestors(server.endpoint, 'child', 5)).toEqual([
      { database: 'root', id: undefined, depth: 1, parent: undefined, forkTimestamp: undefined },
    ]);

    expect((server.requestsTo('execute-sql-query')[0]!.body as Record<string, unknown>).sql).toBe(
      'SHOW BRANCHES FROM `root`',
    );

    expect((server.requestsTo('execute-sql-query')[1]!.body as Record<string, unknown>).sql).toBe(
      'SHOW ANCESTORS FROM `child`',
    );
  });

  it('refuses a database name it cannot delimit', async () => {
    const { transport } = unauthenticated();

    await expect(transport.createBranchDatabase(server.endpoint, 'ba`d', 'root', false, 5)).rejects.toThrow(
      TypeError,
    );

    await expect(transport.showBranches(server.endpoint, 'ba`d', 5)).rejects.toThrow(TypeError);
  });
});

describe('prepared statements', () => {
  function prepareRoute(): void {
    server.json('prepare-sql-statement', {
      status: 'ok',
      statementId: 'stmt-1',
      parameterNames: ['@year', '@name'],
    });
  }

  it('registers once and then sends only the handle and the values', async () => {
    prepareRoute();
    server.json('execute-sql-query', { status: 'ok', columns: [], rows: [] });

    const { transport } = unauthenticated();

    const parameters = new Map([
      ['@name', { type: ColumnType.String, strValue: 'r1' }],
      ['@year', { type: ColumnType.Integer64, longValue: 1974n }],
    ]);

    await transport.executeQuery(sqlRequest({ prepared: true, parameters }));
    await transport.executeQuery(sqlRequest({ prepared: true, parameters }));

    expect(server.callCount('prepare-sql-statement')).toBe(1);

    const body = server.requestsTo('execute-sql-query')[0]!.body as Record<string, unknown>;

    expect(body.statementId).toBe('stmt-1');
    expect(body.sql).toBeUndefined();

    // The values arrive in the order the server published, not the order they were bound.
    expect(body.positionalParameters).toEqual([
      { type: ColumnType.Integer64, longValue: 1974 },
      { type: ColumnType.String, strValue: 'r1' },
    ]);
  });

  it('runs inline when the server will not register the statement', async () => {
    server.json('prepare-sql-statement', { status: 'failed', code: 'CADB0521', message: 'cap full' });
    server.json('execute-sql-query', { status: 'ok', columns: [], rows: [] });

    const { transport } = unauthenticated();

    await transport.executeQuery(sqlRequest({ prepared: true }));

    expect((server.requestsTo('execute-sql-query')[0]!.body as Record<string, unknown>).sql).toBe('SELECT 1');
  });

  it('runs inline when a placeholder has no bound value', async () => {
    prepareRoute();
    server.json('execute-sql-query', { status: 'ok', columns: [], rows: [] });

    const { transport } = unauthenticated();

    await transport.executeQuery(
      sqlRequest({
        prepared: true,
        parameters: new Map([['@year', { type: ColumnType.Integer64, longValue: 1n }]]),
      }),
    );

    expect((server.requestsTo('execute-sql-query')[0]!.body as Record<string, unknown>).sql).toBe('SELECT 1');
  });

  it('sends a parameter named __proto__ as a parameter of its own', async () => {
    server.json('execute-sql-query', { status: 'ok', columns: [], rows: [] });

    const { transport } = unauthenticated();

    await transport.executeQuery(
      sqlRequest({
        sql: 'INSERT INTO t (__proto__) VALUES (@a)',
        parameters: new Map([['__proto__', { type: ColumnType.String, strValue: 'x' }]]),
      }),
    );

    const body = server.requestsTo('execute-sql-query')[0]!.body as Record<string, unknown>;
    const parameters = body.parameters as Record<string, unknown>;

    // Plain assignment would have set the record's prototype and dropped the column.
    expect(Object.hasOwn(parameters, '__proto__')).toBe(true);
  });

  it('registers again and replays once when the handle is gone', async () => {
    let statementNumber = 0;

    server.on('prepare-sql-statement', (_request, response) => {
      statementNumber++;
      respondJson(response, 200, {
        status: 'ok',
        statementId: `stmt-${String(statementNumber)}`,
        parameterNames: [],
      });
    });

    server.on('execute-sql-query', (_request, response, callNumber) => {
      if (callNumber === 1) {
        respondJson(response, 400, { status: 'failed', code: 'CADB0520', message: 'unknown statement' });
        return;
      }

      respondJson(response, 200, { status: 'ok', columns: [], rows: [] });
    });

    const { transport } = unauthenticated();

    await transport.executeQuery(sqlRequest({ prepared: true }));

    expect(server.callCount('prepare-sql-statement')).toBe(2);
    expect(server.callCount('execute-sql-query')).toBe(2);
  });

  it('reports the failure when a second execution is refused the same way', async () => {
    server.json('prepare-sql-statement', { status: 'ok', statementId: 'stmt-1', parameterNames: [] });
    server.json('execute-sql-query', { status: 'failed', code: 'CADB0520', message: 'unknown' }, 400);

    const { transport } = unauthenticated();

    await expect(transport.executeQuery(sqlRequest({ prepared: true }))).rejects.toMatchObject({
      code: 'CADB0520',
    });

    expect(server.callCount('execute-sql-query')).toBe(2);
  });

  it('shares one registration between concurrent first calls', async () => {
    prepareRoute();
    server.json('execute-sql-query', { status: 'ok', columns: [], rows: [] });

    const { transport } = unauthenticated();

    await Promise.all([
      transport.executeQuery(sqlRequest({ prepared: true })),
      transport.executeQuery(sqlRequest({ prepared: true })),
      transport.executeQuery(sqlRequest({ prepared: true })),
    ]);

    expect(server.callCount('prepare-sql-statement')).toBe(1);
  });

  it('reports the binding order to a caller that prepares explicitly', async () => {
    prepareRoute();

    const { transport } = unauthenticated();
    const info = await transport.prepare(server.endpoint, 'test', 'SELECT 1', 5);

    expect(info.parameterNames).toEqual(['@year', '@name']);
  });

  it('releases a registration on the node that minted it', async () => {
    prepareRoute();
    server.json('close-sql-statement', { status: 'ok' });

    const { transport } = unauthenticated();

    await transport.prepare(server.endpoint, 'test', 'SELECT 1', 5);
    await transport.closePrepared(server.endpoint, 'test', 'SELECT 1');

    expect(server.requestsTo('close-sql-statement')[0]!.body).toEqual({ statementId: 'stmt-1' });

    // The second close has nothing left to release.
    await transport.closePrepared(server.endpoint, 'test', 'SELECT 1');
    expect(server.callCount('close-sql-statement')).toBe(1);
  });
});

describe('executeQueryStream', () => {
  it('reads the header, then every row', async () => {
    server.on('execute-sql-query-stream', (_request, response) => {
      respondNdjson(response, [
        { status: 'ok', columns: [{ name: 'n', type: ColumnType.Integer64 }] },
        [1],
        [2],
        [3],
        { status: 'ok', total: 3 },
      ]);
    });

    const { transport } = unauthenticated();
    const source = await transport.executeQueryStream(sqlRequest());

    expect(source.columnNames).toEqual(['n']);

    const values: bigint[] = [];

    for (;;) {
      const cells = await source.next();
      if (cells === undefined) break;

      values.push(cells[0]!.longValue!);
    }

    expect(values).toEqual([1n, 2n, 3n]);

    await source.close();
  });

  it('raises the failure a trailer reports after rows already arrived', async () => {
    server.on('execute-sql-query-stream', (_request, response) => {
      respondNdjson(response, [
        { status: 'ok', columns: [{ name: 'n', type: ColumnType.Integer64 }] },
        [1],
        { status: 'failed', code: 'CADB0502', message: 'conflict' },
      ]);
    });

    const { transport } = unauthenticated();
    const source = await transport.executeQueryStream(sqlRequest());

    expect(await source.next()).toBeDefined();

    await expect(source.next()).rejects.toMatchObject({ code: 'CADB0502' });

    await source.close();
  });

  it('reports a setup failure before the first line', async () => {
    server.json(
      'execute-sql-query-stream',
      { status: 'failed', code: 'CADB0000', message: 'unknown table' },
      400,
    );

    const { transport } = unauthenticated();

    await expect(transport.executeQueryStream(sqlRequest())).rejects.toMatchObject({
      message: 'unknown table',
    });
  });

  it('reports a body that ends before its header', async () => {
    server.on('execute-sql-query-stream', (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.end();
    });

    const { transport } = unauthenticated();

    await expect(transport.executeQueryStream(sqlRequest())).rejects.toThrow(CamusError);
  });

  it('wraps a row line that is not valid JSON', async () => {
    server.on('execute-sql-query-stream', (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write('{"status":"ok","columns":[{"name":"s","type":3}]}\n');
      response.write('["abc"]\n');
      response.write('[not json]\n');
      response.end();
    });

    const { transport } = unauthenticated();
    const source = await transport.executeQueryStream(sqlRequest());

    expect((await source.next())![0]!.strValue).toBe('abc');

    // The header's parse is wrapped the same way; a row must not escape as a raw SyntaxError.
    await expect(source.next()).rejects.toThrow(CamusError);

    await source.close();
  });

  it('refuses a line that is neither a row nor a trailer', async () => {
    server.on('execute-sql-query-stream', (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write('{"status":"ok","columns":[{"name":"s","type":3}]}\n');
      response.write('42\n');
      response.end();
    });

    const { transport } = unauthenticated();
    const source = await transport.executeQueryStream(sqlRequest());

    // Reading it as the end of the stream would report a truncated result as a complete one.
    await expect(source.next()).rejects.toThrow(CamusError);

    await source.close();
  });

  it('reads a row that arrived split across several network reads', async () => {
    server.on('execute-sql-query-stream', async (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write('{"status":"ok","columns":[{"name":"s","type":3}]}\n');
      response.write('["abc');
      await new Promise((resolve) => setTimeout(resolve, 10));
      response.write('def"]\n');
      response.write('{"status":"ok"}\n');
      response.end();
    });

    const { transport } = unauthenticated();
    const source = await transport.executeQueryStream(sqlRequest());

    expect((await source.next())![0]!.strValue).toBe('abcdef');

    await source.close();
  });
});

describe('authentication', () => {
  it('presents the bearer token on every route', async () => {
    server.json('login', { status: 'ok', token: 'token-1', expiresInSeconds: 900 });
    server.json('execute-sql-query', { status: 'ok', columns: [], rows: [] });

    const pool = new CamusEndpointPool(server.endpoint);

    const { RestLoginClient } = await import('../src/auth/rest-login-client.js');

    const auth = new CamusTokenProvider({
      credentials: credentialsFromPassword('app', 'secret'),
      resolveLoginClient: () => new RestLoginClient(),
      resolveEndpoint: () => server.endpoint,
      resolveTimeoutSeconds: () => 5,
    });

    const transport = new RestTransport(pool, auth);

    await transport.executeQuery(sqlRequest());
    await transport.executeQuery(sqlRequest());

    expect(server.callCount('login')).toBe(1);

    for (const request of server.requestsTo('execute-sql-query')) {
      expect(request.headers.authorization).toBe('Bearer token-1');
    }
  });

  it('sends no Authorization header when nothing is configured', async () => {
    server.json('execute-sql-query', { status: 'ok', columns: [], rows: [] });

    const { transport } = unauthenticated();

    await transport.executeQuery(sqlRequest());

    expect(server.requestsTo('execute-sql-query')[0]!.headers.authorization).toBeUndefined();
  });
});
