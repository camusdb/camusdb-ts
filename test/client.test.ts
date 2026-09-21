import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CamusClient } from '../src/client.js';
import { ColumnType } from '../src/column-type.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusError } from '../src/errors.js';
import { stringifyLossless } from '../src/json.js';
import { CamusLocking } from '../src/options.js';
import { CamusPreparedStatementPolicy } from '../src/prepared/policy.js';
import { CamusStatementRouter } from '../src/routing/router.js';
import { CamusTokenProvider } from '../src/auth/token-provider.js';
import { CamusTransportPool } from '../src/transport/transport-pool.js';
import { camus } from '../src/values/typed.js';
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

let suffix = 0;

beforeEach(() => {
  server.reset();
  CamusEndpointPool.resetShared();
  CamusTokenProvider.resetShared();
  CamusTransportPool.resetShared();
  CamusPreparedStatementPolicy.resetShared();
  CamusStatementRouter.resetShared();
  suffix++;
});

/**
 * A client whose shared state is unique to this test.
 *
 * The transport, the prepare policy, and the token are shared per deployment and identity by
 * design. Giving each test its own database name keys them apart, so one test's prepared
 * statements never decide what another test sends.
 */
function client(overrides: Record<string, unknown> = {}): CamusClient {
  return new CamusClient({
    endpoint: server.endpoint,
    database: `test-${String(suffix)}`,
    timeoutSeconds: 5,
    ...overrides,
  });
}

function queryRoute(columns: { name: string; type: ColumnType }[], rows: unknown[][]): void {
  server.json('execute-sql-query', { status: 'ok', columns, rows });
}

describe('query', () => {
  it('maps rows to objects keyed by column name', async () => {
    queryRoute(
      [
        { name: 'id', type: ColumnType.Id },
        { name: 'name', type: ColumnType.String },
        { name: 'year', type: ColumnType.Integer64 },
      ],
      [
        ['abc', 'r1', 1974],
        ['def', 'r2', 1984],
      ],
    );

    interface Robot {
      id: string;
      name: string;
      year: number;
    }

    const result = await client().query<Robot>('SELECT id, name, year FROM robots');

    expect(result.rows).toEqual([
      { id: 'abc', name: 'r1', year: 1974 },
      { id: 'def', name: 'r2', year: 1984 },
    ]);

    expect(result.rowCount).toBe(2);
    expect(result.columns.map((column) => column.typeName)).toEqual(['Id', 'String', 'Integer64']);
  });

  it('maps every column type to its JavaScript value', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const { high, low } = uuidToHalves(uuid);
    const ticks = dateToTicks(new Date('2024-03-15T12:00:00Z'));

    server.json(
      'execute-sql-query',
      stringifyLossless({
        status: 'ok',
        columns: [
          { name: 'flag', type: ColumnType.Bool },
          { name: 'price', type: ColumnType.Float64 },
          { name: 'photo', type: ColumnType.Bytes },
          { name: 'made', type: ColumnType.DateTime },
          { name: 'key', type: ColumnType.Uuid },
          { name: 'tags', type: ColumnType.Array },
          { name: 'nothing', type: ColumnType.String },
        ],
        rows: [[true, 1.5, 'AQID', ticks, [high, low], ['a', 'b'], null]],
      }),
    );

    const row = (await client().queryOne('SELECT * FROM robots'))!;

    expect(row).toMatchObject({
      flag: true,
      price: 1.5,
      key: uuid,
      tags: ['a', 'b'],
      nothing: null,
    });

    expect([...(row.photo as Uint8Array)]).toEqual([1, 2, 3]);
    expect((row.made as Date).toISOString()).toBe('2024-03-15T12:00:00.000Z');
  });

  it('reads a 64-bit column exactly', async () => {
    server.json(
      'execute-sql-query',
      '{"status":"ok","columns":[{"name":"n","type":2}],"rows":[[9223372036854775807],[5]]}',
    );

    const result = await client().query<{ n: number | bigint }>('SELECT n FROM big');

    expect(result.rows[0]!.n).toBe(9223372036854775807n);
    expect(result.rows[1]!.n).toBe(5);
  });

  it('honours an int64 mode set for one statement', async () => {
    queryRoute([{ name: 'n', type: ColumnType.Integer64 }], [[5]]);

    expect((await client().queryOne<{ n: bigint }>('SELECT n', undefined, { int64: 'bigint' }))!.n).toBe(5n);
  });

  it('keeps every column when a projection repeats a name', async () => {
    queryRoute(
      [
        { name: 'id', type: ColumnType.String },
        { name: 'id', type: ColumnType.String },
      ],
      [['a', 'b']],
    );

    expect(await client().queryOne('SELECT a.id, b.id FROM a JOIN b')).toEqual({ id: 'a', id_2: 'b' });
  });

  it('reads the first row and the first value', async () => {
    queryRoute([{ name: 'total', type: ColumnType.Integer64 }], [[7]]);

    const subject = client();

    expect(await subject.queryOne('SELECT COUNT(*) AS total FROM robots')).toEqual({ total: 7 });
    expect(await subject.scalar<number>('SELECT COUNT(*) AS total FROM robots')).toBe(7);
  });

  it('reports nothing for a result with no rows', async () => {
    queryRoute([{ name: 'id', type: ColumnType.Id }], []);

    const subject = client();

    expect(await subject.queryOne('SELECT id FROM robots')).toBeUndefined();
    expect(await subject.scalar('SELECT id FROM robots')).toBeUndefined();

    const result = await subject.query('SELECT id FROM robots');

    expect(result.rows).toEqual([]);
    expect(result.columns).toHaveLength(1);
  });

  it('binds parameters by name, with or without a leading marker', async () => {
    queryRoute([], []);

    await client().query('SELECT * FROM robots WHERE year = @year AND name = @name', {
      year: 1974,
      '@name': 'r1',
    });

    expect((server.requestsTo('execute-sql-query')[0]!.body as Record<string, unknown>).parameters).toEqual({
      '@year': { type: ColumnType.Integer64, longValue: 1974 },
      '@name': { type: ColumnType.String, strValue: 'r1' },
    });
  });

  it('binds a value whose type the caller stated', async () => {
    queryRoute([], []);

    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    await client().query('SELECT * FROM robots WHERE key = @key', { key: camus.uuid(uuid) });

    const parameters = (
      server.requestsTo('execute-sql-query')[0]!.body as Record<string, Record<string, unknown>>
    ).parameters as Record<string, Record<string, unknown>>;

    expect(parameters['@key']!.type).toBe(ColumnType.Uuid);
    expect(parameters['@key']!.strValue).toBe(uuid);
  });

  it('reports the cache verdict for a hinted statement', async () => {
    server.json('execute-sql-query', {
      status: 'ok',
      columns: [],
      rows: [],
      cacheStatus: 'hit',
      cacheName: 'robots',
    });

    const result = await client().query('SELECT {cache=robots} * FROM robots');

    expect(result.cacheMetadata?.isHit).toBe(true);
    expect(result.cacheMetadata?.name).toBe('robots');
  });
});

describe('execute', () => {
  it('reports how many rows a write changed', async () => {
    server.json('execute-sql-non-query', { status: 'ok', rows: 2 });

    const result = await client().execute('DELETE FROM robots WHERE year < @year', { year: 1980 });

    expect(result.affectedRows).toBe(2);
  });

  it('sends a schema statement to the DDL route', async () => {
    server.json('execute-sql-ddl', { status: 'ok' });

    const result = await client().execute('CREATE TABLE robots (id id PRIMARY KEY)');

    expect(result.affectedRows).toBe(0);
    expect(server.callCount('execute-sql-ddl')).toBe(1);
    expect(server.callCount('execute-sql-non-query')).toBe(0);
  });

  it('carries the concurrency knobs of an autocommit statement', async () => {
    server.json('execute-sql-non-query', { status: 'ok', rows: 0 });

    await client({ defaultTransactionOptions: { locking: CamusLocking.Optimistic } }).execute(
      'UPDATE robots SET year = 1',
    );

    expect(server.requestsTo('execute-sql-non-query')[0]!.body).toMatchObject({ locking: 'Optimistic' });
  });

  it('inserts a row through the typed route, with no marker on a column name', async () => {
    server.json('insert', { status: 'ok', rows: 1 });

    expect(await client().insert('robots', { name: 'r1', year: 1974 })).toBe(1);

    expect((server.requestsTo('insert')[0]!.body as Record<string, unknown>).values).toEqual({
      name: { type: ColumnType.String, strValue: 'r1' },
      year: { type: ColumnType.Integer64, longValue: 1974 },
    });
  });

  it('refuses TRUNCATE inside an explicit transaction, before any round trip', async () => {
    server.json('start-transaction', { status: 'ok', txnIdPT: 1, txnIdCounter: 1 });

    const subject = client();
    const transaction = await subject.beginTransaction();

    await expect(subject.executeDdl('TRUNCATE robots', { transaction })).rejects.toMatchObject({
      code: 'CADB0538',
    });

    expect(server.callCount('execute-sql-ddl')).toBe(0);
  });

  it("rewrites a table's storage through the DDL route, with no transaction", async () => {
    server.json('execute-sql-ddl', { status: 'ok' });

    const subject = client();

    await subject.rewriteStorage('docs');
    await subject.rewriteStorage('docs', { inline: true, timeoutSeconds: 3600 });

    const bodies = server.requestsTo('execute-sql-ddl').map((r) => r.body as Record<string, unknown>);

    expect(bodies.map((body) => body.sql)).toEqual([
      'ALTER TABLE `docs` REWRITE STORAGE',
      'ALTER TABLE `docs` REWRITE STORAGE INLINE',
    ]);
    expect(bodies[0]!.txnIdPT).toBeUndefined();
  });

  it('refuses a table name that cannot be delimited, before any round trip', async () => {
    await expect(client().rewriteStorage('do`cs')).rejects.toThrow(TypeError);

    expect(server.callCount('execute-sql-ddl')).toBe(0);
  });
});

describe('queryStream', () => {
  function streamRoute(): void {
    server.on('execute-sql-query-stream', (_request, response) => {
      respondNdjson(response, [
        { status: 'ok', columns: [{ name: 'n', type: ColumnType.Integer64 }] },
        [1],
        [2],
        [3],
        { status: 'ok', total: 3 },
      ]);
    });
  }

  it('reports rows one at a time', async () => {
    streamRoute();

    const stream = await client().queryStream<{ n: number }>('SELECT n FROM numbers');

    expect(stream.columns).toEqual([{ name: 'n', type: ColumnType.Integer64, typeName: 'Integer64' }]);

    const values: number[] = [];

    for await (const row of stream) values.push(row.n);

    expect(values).toEqual([1, 2, 3]);
  });

  it('reads every row into an array', async () => {
    streamRoute();

    expect(await (await client().queryStream('SELECT n FROM numbers')).toArray()).toHaveLength(3);
  });

  it('releases the response when the caller leaves early', async () => {
    streamRoute();

    const stream = await client().queryStream<{ n: number }>('SELECT n FROM numbers');

    for await (const row of stream) {
      expect(row.n).toBe(1);
      break;
    }

    // A second pass is refused rather than silently reporting nothing.
    await expect(async () => {
      for await (const row of stream) {
        throw new Error(`the iteration must not start, but it reported ${JSON.stringify(row)}`);
      }
    }).rejects.toThrow();
  });

  it('is released by an await using block', async () => {
    streamRoute();

    {
      await using stream = await client().queryStream('SELECT n FROM numbers');

      expect(stream.columns).toHaveLength(1);
    }
  });
});

describe('transactions', () => {
  function transactionRoutes(): void {
    server.on('start-transaction', (_request, response) => {
      respondJson(response, 200, '{"status":"ok","txnIdPT":638765432109876543,"txnIdCounter":9}');
    });

    server.json('commit-transaction', { status: 'ok' });
    server.json('rollback-transaction', { status: 'ok' });
    server.json('execute-sql-non-query', { status: 'ok', rows: 1 });
  }

  it('begins, runs statements inside, and commits', async () => {
    transactionRoutes();

    const subject = client();
    const result = await subject.transaction(async (transaction) => {
      expect(transaction.isStarted).toBe(true);
      expect(transaction.txnIdPT).toBe(638765432109876543n);

      await subject.execute('UPDATE accounts SET balance = 1', undefined, { transaction });

      return 'done';
    });

    expect(result).toBe('done');
    expect(server.callCount('commit-transaction')).toBe(1);
    expect(server.callCount('rollback-transaction')).toBe(0);

    const body = server.requestsTo('execute-sql-non-query')[0]!;

    expect(body.rawBody).toContain('"txnIdPT":638765432109876543');
  });

  it('rolls back when the work fails', async () => {
    transactionRoutes();

    await expect(
      client().transaction(() => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');

    expect(server.callCount('rollback-transaction')).toBe(1);
    expect(server.callCount('commit-transaction')).toBe(0);
  });

  it('runs the whole unit of work again after a lost conflict', async () => {
    transactionRoutes();

    let attempts = 0;

    await client().transaction(async () => {
      attempts++;
      if (attempts < 3) throw new CamusError('CADB0502', 'conflict');

      await Promise.resolve();
    });

    expect(attempts).toBe(3);
    expect(server.callCount('start-transaction')).toBe(3);
    expect(server.callCount('commit-transaction')).toBe(1);
  });

  it('does not run the work again for a failure that is not retryable', async () => {
    transactionRoutes();

    let attempts = 0;

    await expect(
      client().transaction(() => {
        attempts++;
        throw new CamusError('CADB0517', 'no privilege');
      }),
    ).rejects.toMatchObject({ code: 'CADB0517' });

    expect(attempts).toBe(1);
  });

  it('re-issues the same commit while the outcome is unresolved', async () => {
    transactionRoutes();

    server.on('commit-transaction', (_request, response, callNumber) => {
      if (callNumber < 3) {
        respondJson(response, 500, { status: 'failed', code: 'CADB0509', message: 'unresolved' });
        return;
      }

      respondJson(response, 200, { status: 'ok' });
    });

    await client().transaction(async () => {
      await Promise.resolve();
    });

    expect(server.callCount('commit-transaction')).toBe(3);

    // The unit of work was never replayed: the transaction was begun exactly once.
    expect(server.callCount('start-transaction')).toBe(1);
  });

  it('rolls a transaction back when its block unwinds without a commit', async () => {
    transactionRoutes();

    const subject = client();

    {
      await using transaction = await subject.beginTransaction();

      expect(transaction.isFinalized).toBe(false);
    }

    expect(server.callCount('rollback-transaction')).toBe(1);
  });

  it('does nothing when a committed transaction leaves its block', async () => {
    transactionRoutes();

    const subject = client();

    {
      await using transaction = await subject.beginTransaction();
      await transaction.commit();
    }

    expect(server.callCount('rollback-transaction')).toBe(0);
  });

  it('refuses a second finalize', async () => {
    transactionRoutes();

    const transaction = await client().beginTransaction();

    await transaction.commit();

    await expect(transaction.commit()).rejects.toThrow(CamusError);
  });
});

describe('learned routing', () => {
  function routedClient(): CamusClient {
    return new CamusClient({
      endpoint: [server.endpoint, 'http://127.0.0.1:9'],
      database: `test-${String(suffix)}`,
      timeoutSeconds: 5,
      routingMode: 'learned',
      routingNodes: { 'camus-a:7070': server.endpoint },
    });
  }

  it('negotiates, learns a destination, and steers the next execution to it', async () => {
    server.json('execute-sql-query', {
      status: 'ok',
      columns: [],
      rows: [],
      routing: {
        version: 1,
        disposition: 'prefer',
        preferredNodeId: 'camus-a:7070',
        reuseScope: 'statementParametersIndependent',
        maxAgeMs: 5000,
      },
    });

    const subject = routedClient();

    const first = await subject.query('SELECT 1');

    expect(first.routingAdvice?.preferredNodeId).toBe('camus-a:7070');
    expect(subject.learnedRouteCount).toBe(1);

    expect(
      (server.requestsTo('execute-sql-query')[0]!.body as Record<string, unknown>).routingAcceptVersion,
    ).toBe(1);

    // The learned route sends the second execution to the node the advice named, rather than to
    // the next endpoint in the rotation, which is unreachable.
    await subject.query('SELECT 1');

    expect(server.callCount('execute-sql-query')).toBe(2);
  });

  it('sends no negotiation field when routing is off', async () => {
    queryRoute([], []);

    await client().query('SELECT 1');

    expect(
      (server.requestsTo('execute-sql-query')[0]!.body as Record<string, unknown>).routingAcceptVersion,
    ).toBeUndefined();
  });

  it('stays off when the trust map names one endpoint and the mode is auto', async () => {
    queryRoute([], []);

    const subject = new CamusClient({
      endpoint: server.endpoint,
      database: `test-${String(suffix)}`,
      routingNodes: { 'camus-a:7070': server.endpoint },
    });

    await subject.query('SELECT 1');

    expect(
      (server.requestsTo('execute-sql-query')[0]!.body as Record<string, unknown>).routingAcceptVersion,
    ).toBeUndefined();
  });
});

describe('automatic prepared statements', () => {
  it('prepares a statement once it is hot, then sends only the handle', async () => {
    server.json('prepare-sql-statement', { status: 'ok', statementId: 'stmt-1', parameterNames: ['@year'] });
    queryRoute([], []);

    const subject = client({ autoPrepareMinUsages: 2 });

    await subject.query('SELECT * FROM robots WHERE year = @year', { year: 1 });
    expect(server.callCount('prepare-sql-statement')).toBe(0);

    await subject.query('SELECT * FROM robots WHERE year = @year', { year: 2 });
    expect(server.callCount('prepare-sql-statement')).toBe(1);
    expect(subject.isPrepared('SELECT * FROM robots WHERE year = @year')).toBe(true);
    expect(subject.preparedStatementCount).toBe(1);

    await subject.query('SELECT * FROM robots WHERE year = @year', { year: 3 });

    const bodies = server.requestsTo('execute-sql-query').map((r) => r.body as Record<string, unknown>);

    expect(bodies[0]!.sql).toBe('SELECT * FROM robots WHERE year = @year');
    expect(bodies[2]!.sql).toBeUndefined();
    expect(bodies[2]!.statementId).toBe('stmt-1');
  });

  it('prepares nothing when the setting is zero', async () => {
    queryRoute([], []);

    const subject = client({ maxAutoPrepare: 0 });

    await subject.query('SELECT 1');
    await subject.query('SELECT 1');
    await subject.query('SELECT 1');

    expect(server.callCount('prepare-sql-statement')).toBe(0);
  });

  it('runs the statement inline when a registration fails, and stops asking', async () => {
    server.json('prepare-sql-statement', { status: 'failed', code: 'CADB0521', message: 'cap full' }, 400);
    queryRoute([], []);

    const subject = client({ autoPrepareMinUsages: 1 });

    await subject.query('SELECT 1');
    await subject.query('SELECT 1');

    expect(server.callCount('prepare-sql-statement')).toBe(1);
    expect(server.callCount('execute-sql-query')).toBe(2);
  });

  it('asks again after a registration that failed without a verdict', async () => {
    // A gateway failure says nothing about the statement, so it must not be terminal.
    server.json('prepare-sql-statement', { status: 'failed', code: 'CADB0000', message: 'gateway' }, 504);
    queryRoute([], []);

    const subject = client({ autoPrepareMinUsages: 1 });

    await subject.query('SELECT 1');
    await subject.query('SELECT 1');

    expect(server.callCount('prepare-sql-statement')).toBe(2);
    expect(server.callCount('execute-sql-query')).toBe(2);
  });

  it('prepares on request, and treats a statement it cannot prepare as no error', async () => {
    server.json('prepare-sql-statement', { status: 'ok', statementId: 'stmt-1', parameterNames: [] });

    const subject = client();

    await subject.prepare('SELECT 1');
    expect(subject.isPrepared('SELECT 1')).toBe(true);

    await subject.prepare('CREATE TABLE t (id id)');
    expect(server.callCount('prepare-sql-statement')).toBe(1);
  });
});

describe('databases', () => {
  it('creates, drops, branches, and lists', async () => {
    server.json('create-db', { status: 'ok' });
    server.json('drop-db', { status: 'ok' });
    server.json('execute-sql-ddl', { status: 'ok' });

    // Branching and its listings are SQL statements, not routes of their own.
    server.on('execute-sql-query', (request, response) => {
      const sql = (request.body as { sql?: string }).sql ?? '';

      respondJson(response, 200, {
        status: 'ok',
        columns: [
          { name: 'database', type: ColumnType.String },
          { name: 'depth', type: ColumnType.Integer64 },
        ],
        rows: sql.startsWith('SHOW BRANCHES') ? [['child', 1]] : [],
      });
    });

    const subject = client();

    await subject.createDatabase(undefined, { ifNotExists: true });
    await subject.createBranchDatabase('child', 'root');
    await subject.dropDatabase('other');

    expect(await subject.showBranches('root')).toHaveLength(1);
    expect(await subject.showAncestors('child')).toEqual([]);

    expect(server.requestsTo('create-db')[0]!.body).toMatchObject({
      databaseName: subject.database,
      ifNotExists: true,
    });

    expect((server.requestsTo('execute-sql-ddl')[0]!.body as Record<string, unknown>).sql).toBe(
      'CREATE DATABASE `child` BRANCH FROM `root`',
    );
  });

  it('retries a creation that collided transiently', async () => {
    server.on('create-db', (_request, response, callNumber) => {
      if (callNumber < 3) {
        respondJson(response, 500, { status: 'failed', code: 'CADB0505', message: 'MustRetry' });
        return;
      }

      respondJson(response, 200, { status: 'ok' });
    });

    await client().createDatabase();

    expect(server.callCount('create-db')).toBe(3);
  });

  it('treats a lost registration race as success when the caller asked for IF NOT EXISTS', async () => {
    server.json('create-db', { status: 'failed', code: 'CADB0012', message: 'already registered' }, 409);

    await expect(client().createDatabase(undefined, { ifNotExists: true })).resolves.toBeUndefined();
    await expect(client().createDatabase()).rejects.toMatchObject({ code: 'CADB0012' });
  });
});

describe('the query result cache', () => {
  it('evicts one family and every family', async () => {
    server.json('execute-sql-non-query', { status: 'ok', rows: 0 });

    const subject = client();

    await subject.evictCache('robots');
    await subject.evictAllCache();

    const bodies = server.requestsTo('execute-sql-non-query').map((r) => r.body as Record<string, unknown>);

    expect(bodies[0]!.sql).toBe("EVICT CACHE 'robots'");
    expect(bodies[1]!.sql).toBe('EVICT CACHE ALL');
  });

  it('refuses a family name that cannot be written into SQL', async () => {
    await expect(client().evictCache("x'; DROP DATABASE y --")).rejects.toThrow(TypeError);
  });
});

describe('the client surface', () => {
  it('builds from a connection string', async () => {
    server.json('ping', { status: 'ok' });

    const subject = CamusClient.fromConnectionString(
      `Endpoint=${server.endpoint};Database=test-${String(suffix)};Timeout=5`,
    );

    expect(subject.database).toBe(`test-${String(suffix)}`);
    expect(subject.protocol).toBe('rest');
    expect(await subject.ping()).toBe(true);
  });

  it('masks its secrets when it is printed', () => {
    const subject = CamusClient.fromConnectionString(
      'Endpoint=https://db:5095;Database=test;User=app;Password=secret',
    );

    expect(subject.toString()).toContain('Password=***');
    expect(subject.toString()).not.toContain('secret');
  });

  it('points at another database', () => {
    const subject = client();

    subject.changeDatabase('other');

    expect(subject.database).toBe('other');
    expect(() => subject.changeDatabase('  ')).toThrow(CamusError);

    // A newline would make two distinct (database, sql) pairs collide on one cache key.
    expect(() => subject.changeDatabase('a\nb')).toThrow(CamusError);
  });

  it('ends a statement when the caller cancels it', async () => {
    server.on('execute-sql-query', () => {
      // Never answers.
    });

    const controller = new AbortController();
    const pending = client().query('SELECT 1', undefined, { signal: controller.signal });

    controller.abort(new Error('caller stopped'));

    await expect(pending).rejects.toThrow('caller stopped');
  });

  it('gives up on a per-statement deadline', async () => {
    server.on('execute-sql-query', () => {
      // Never answers.
    });

    await expect(client().query('SELECT 1', undefined, { timeoutSeconds: 1 })).rejects.toThrow(CamusError);
  });

  it('is released by an await using block', async () => {
    await using subject = client();

    expect(subject.database).toBe(`test-${String(suffix)}`);
  });
});

describe('the backup admin API', () => {
  it('takes, lists, and resolves a chain', async () => {
    server.json('v1/backups/full', {
      status: 'ok',
      backup: {
        backupId: 'b1',
        formatVersion: 1,
        type: 'full',
        partitionCount: 4,
        requestedKind: 'coordinated',
        actualKind: 'full',
        substitutionReason: 'no coordinator',
      },
    });

    server.json('v1/backups', { status: 'ok', backups: [{ backupId: 'b1', type: 'full' }] });
    server.json('v1/backups/b1/chain', { status: 'ok', backups: [{ backupId: 'b0', type: 'full' }] });

    const subject = client();

    const backup = await subject.backups.takeFullBackup();

    expect(backup.backupId).toBe('b1');
    expect(backup.wasSubstituted).toBe(true);

    expect(await subject.backups.listBackups()).toHaveLength(1);
    expect(await subject.backups.getChain('b1')).toHaveLength(1);
  });

  it('previews and runs retention', async () => {
    server.on('v1/backups/gc', (request, response) => {
      respondJson(response, 200, {
        status: 'ok',
        applied: request.query.get('dryRun') === 'false',
        bytesReclaimed: 1024,
        retentionDeletions: [{ backupId: 'b0', type: 'full', bytes: 1024, reason: 'aged out' }],
        orphanReclamations: [],
      });
    });

    const subject = client();

    expect((await subject.backups.previewGarbageCollection()).applied).toBe(false);

    const run = await subject.backups.collectGarbage();

    expect(run.applied).toBe(true);
    expect(run.bytesReclaimed).toBe(1024);
    expect(run.retentionDeletions[0]!.backupId).toBe('b0');
  });

  it('refuses to guess a backup endpoint for a gRPC client', async () => {
    const subject = new CamusClient({
      endpoint: server.endpoint,
      database: 'test',
      protocol: 'grpc',
    });

    // The backup routes are REST-only, so a gRPC client must be told where the HTTP port is.
    await expect(subject.backups.listBackups()).rejects.toThrow(CamusError);
  });
});
