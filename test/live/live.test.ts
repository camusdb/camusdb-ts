/**
 * The suite that runs against a real CamusDB server.
 *
 * It is separate from the offline suite because it needs a server, and it is run by its own
 * command:
 *
 *   npm run test:live
 *
 * The endpoints come from the environment, and default to a local development server:
 *
 *   CAMUS_LIVE_ENDPOINT       the REST endpoint, default http://localhost:5095
 *   CAMUS_LIVE_GRPC_ENDPOINT  the gRPC endpoint, default http://localhost:5096
 *   CAMUS_LIVE_DATABASE       the database to work in, default camusdb_ts_live
 *   CAMUS_LIVE_USER           the user, when the server has authentication on
 *   CAMUS_LIVE_PASSWORD       that user's password
 *   CAMUS_LIVE_LARGE_VALUES   set to true to run the large-value cases, which need a server with
 *                             large-value storage: an older server refuses the STORAGE clause
 *
 * Every case creates its own table and drops it afterwards, so the suite leaves nothing behind and
 * two runs never collide.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CamusClientOptions } from '../../src/config.js';
import {
  CamusClient,
  CamusColumnStorage,
  CamusError,
  CamusObjectId,
  CamusVector,
  camus,
  cacheHint,
  ColumnType,
  setColumnStorageStatement,
} from '../../src/index.js';

const REST_ENDPOINT = process.env.CAMUS_LIVE_ENDPOINT ?? 'http://localhost:5095';
const GRPC_ENDPOINT = process.env.CAMUS_LIVE_GRPC_ENDPOINT ?? 'http://localhost:5096';
const DATABASE = process.env.CAMUS_LIVE_DATABASE ?? 'camusdb_ts_live';
const LARGE_VALUES = process.env.CAMUS_LIVE_LARGE_VALUES?.toLowerCase() === 'true';

const CREDENTIALS =
  process.env.CAMUS_LIVE_USER === undefined
    ? {}
    : {
        user: process.env.CAMUS_LIVE_USER,
        password: process.env.CAMUS_LIVE_PASSWORD ?? '',
        allowInsecureCredentials: true,
      };

interface Robot {
  id: string;
  name: string;
  type: string;
  year: number;
  price: number;
  enabled: boolean;
}

/** A table name no other run can collide with. */
function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

/**
 * Runs the whole suite against one transport.
 *
 * Both transports carry the same features, so the assertions are the same for each. The few places
 * they genuinely differ — only streaming is incremental over REST — are noted where they arise.
 */
function suite(name: string, options: Partial<CamusClientOptions>): void {
  describe(name, () => {
    let client: CamusClient;
    const tables: string[] = [];

    /** Creates the standard table, and registers it to be dropped when the suite ends. */
    async function createRobotsTable(): Promise<string> {
      const table = uniqueName('robots');

      await client.executeDdl(
        `CREATE TABLE ${table} (` +
          ' id OID PRIMARY KEY NOT NULL,' +
          ' name STRING NOT NULL,' +
          ' type STRING,' +
          ' year INT64,' +
          ' price FLOAT64,' +
          ' enabled BOOL)',
      );

      tables.push(table);
      return table;
    }

    async function insertRobot(table: string, robot: Partial<Robot> = {}): Promise<string> {
      const id = robot.id ?? CamusObjectId.generateAsString();

      await client.execute(
        `INSERT INTO ${table} (id, name, type, year, price, enabled)
         VALUES (@id, @name, @type, @year, @price, @enabled)`,
        {
          id,
          name: robot.name ?? 'r1',
          type: robot.type ?? 'mechanical',
          year: robot.year ?? 1974,
          price: robot.price ?? 1500.5,
          enabled: robot.enabled ?? true,
        },
      );

      return id;
    }

    beforeAll(async () => {
      client = new CamusClient({
        endpoint: REST_ENDPOINT,
        database: DATABASE,
        timeoutSeconds: 30,
        ...CREDENTIALS,
        ...options,
      });

      // The database is created over REST whichever transport this suite uses, so a gRPC run does
      // not depend on the DDL route existing before it has a database to talk to.
      const provisioner = new CamusClient({
        endpoint: REST_ENDPOINT,
        database: DATABASE,
        timeoutSeconds: 30,
        ...CREDENTIALS,
      });

      await provisioner.createDatabase(undefined, { ifNotExists: true });
      await provisioner.close();
    });

    afterAll(async () => {
      for (const table of tables) {
        try {
          await client.executeDdl(`DROP TABLE ${table}`);
        } catch {
          // A case may have dropped it already.
        }
      }

      await client.close();
    });

    // ─── Liveness ───────────────────────────────────────────────────────────

    it('answers a ping', async () => {
      expect(await client.ping()).toBe(true);
    });

    // ─── Schema ─────────────────────────────────────────────────────────────

    it('creates, alters, and drops a table', async () => {
      const table = uniqueName('schema');

      expect(await client.executeDdl(`CREATE TABLE ${table} (id OID PRIMARY KEY NOT NULL, n INT64)`)).toBe(
        true,
      );

      await client.executeDdl(`ALTER TABLE ${table} ADD COLUMN extra STRING`);

      const columns = (await client.query(`SELECT * FROM ${table}`)).columns.map((column) => column.name);

      expect(columns).toContain('extra');

      await client.executeDdl(`DROP TABLE ${table}`);
    });

    it('creates and drops an index', async () => {
      const table = await createRobotsTable();
      const index = uniqueName('ix');

      await client.executeDdl(`CREATE INDEX ${index} ON ${table} (year)`);

      // This server drops an index through ALTER TABLE; it has no standalone DROP INDEX statement.
      await client.executeDdl(`ALTER TABLE ${table} DROP INDEX ${index}`);
    });

    // ─── Writes and reads ───────────────────────────────────────────────────

    it('inserts a row and reads it back', async () => {
      const table = await createRobotsTable();
      const id = await insertRobot(table, { name: 'r1', year: 1974 });

      const row = await client.queryOne<Robot>(`SELECT * FROM ${table} WHERE id = @id`, {
        id: camus.id(id),
      });

      expect(row).toMatchObject({
        id,
        name: 'r1',
        type: 'mechanical',
        year: 1974,
        price: 1500.5,
        enabled: true,
      });
    });

    it('reports the output schema, even for a result with no rows', async () => {
      const table = await createRobotsTable();

      const result = await client.query(`SELECT id, name, year FROM ${table} WHERE year = @year`, {
        year: -1,
      });

      expect(result.rowCount).toBe(0);
      expect(result.columns.map((column) => `${column.name}:${column.typeName}`)).toEqual([
        'id:Id',
        'name:String',
        'year:Integer64',
      ]);
    });

    it('binds a parameter rather than composing text', async () => {
      const table = await createRobotsTable();

      await insertRobot(table, { name: "O'Brien; DROP TABLE x --", year: 2000 });

      const row = await client.queryOne<Robot>(`SELECT name FROM ${table} WHERE year = @year`, {
        year: 2000,
      });

      expect(row?.name).toBe("O'Brien; DROP TABLE x --");
    });

    it('updates and deletes, reporting how many rows changed', async () => {
      const table = await createRobotsTable();

      await insertRobot(table, { name: 'a', year: 1970 });
      await insertRobot(table, { name: 'b', year: 1971 });
      await insertRobot(table, { name: 'c', year: 1980 });

      const updated = await client.execute(`UPDATE ${table} SET type = @type WHERE year < @year`, {
        type: 'vintage',
        year: 1975,
      });

      expect(updated.affectedRows).toBe(2);

      const deleted = await client.execute(`DELETE FROM ${table} WHERE year >= @year`, { year: 1975 });

      expect(deleted.affectedRows).toBe(1);
      expect(await client.scalar<number>(`SELECT COUNT(*) FROM ${table}`)).toBe(2);
    });

    it('inserts through the typed row-level route', async () => {
      const table = await createRobotsTable();

      const id = CamusObjectId.generateAsString();

      const affected = await client.insert(table, {
        id: camus.id(id),
        name: 'typed',
        type: 'hydraulic',
        year: 1984,
        price: 2500.25,
        enabled: false,
      });

      expect(affected).toBe(1);

      const row = await client.queryOne<Robot>(`SELECT * FROM ${table} WHERE id = @id`, {
        id: camus.id(id),
      });

      expect(row).toMatchObject({ name: 'typed', year: 1984, price: 2500.25, enabled: false });
    });

    // ─── Types ──────────────────────────────────────────────────────────────

    it('round-trips every column type', async () => {
      const table = uniqueName('types');

      await client.executeDdl(
        `CREATE TABLE ${table} (` +
          ' id OID PRIMARY KEY NOT NULL,' +
          ' s STRING, n INT64, f FLOAT64, b BOOL,' +
          ' u UUID, d DATE, dt DATETIME, raw BYTES)',
      );

      tables.push(table);

      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const day = new Date('2024-03-15T18:45:00Z');
      const instant = new Date('2024-03-15T12:34:56.789Z');

      await client.execute(
        `INSERT INTO ${table} (id, s, n, f, b, u, d, dt, raw)
         VALUES (@id, @s, @n, @f, @b, @u, @d, @dt, @raw)`,
        {
          id: CamusObjectId.generateAsString(),
          s: 'text',
          n: 1234,
          f: 1.5,
          b: true,
          u: camus.uuid(uuid),
          d: camus.date(day),
          dt: instant,
          raw: camus.vector([0.5, -1.25, 2]),
        },
      );

      const row = await client.queryOne<Record<string, unknown>>(`SELECT * FROM ${table}`);

      expect(row?.s).toBe('text');
      expect(row?.n).toBe(1234);
      expect(row?.f).toBe(1.5);
      expect(row?.b).toBe(true);
      expect(row?.u).toBe(uuid);

      // A date column is truncated to UTC midnight; a datetime keeps its milliseconds.
      expect((row?.d as Date).toISOString()).toBe('2024-03-15T00:00:00.000Z');
      expect((row?.dt as Date).toISOString()).toBe(instant.toISOString());

      expect([...CamusVector.toFloats(row?.raw as Uint8Array)]).toEqual([0.5, -1.25, 2]);
    });

    it('keeps a 64-bit integer exact', async () => {
      const table = uniqueName('big');

      await client.executeDdl(`CREATE TABLE ${table} (id OID PRIMARY KEY NOT NULL, n INT64)`);
      tables.push(table);

      // Above 2^53, where a JavaScript number stops being able to name every integer.
      const values = [9007199254740993n, 9223372036854775807n, -9223372036854775808n];

      for (const n of values) {
        await client.execute(`INSERT INTO ${table} (id, n) VALUES (@id, @n)`, {
          id: CamusObjectId.generateAsString(),
          n,
        });
      }

      const result = await client.query<{ n: bigint }>(`SELECT n FROM ${table} ORDER BY n`, undefined, {
        int64: 'bigint',
      });

      expect([...result.rows].map((row) => row.n).sort(compareBigInt)).toEqual(
        [...values].sort(compareBigInt),
      );
    });

    it('reads a null as null', async () => {
      const table = await createRobotsTable();

      await client.execute(`INSERT INTO ${table} (id, name, type) VALUES (@id, @name, @type)`, {
        id: CamusObjectId.generateAsString(),
        name: 'sparse',
        type: null,
      });

      const row = await client.queryOne<Robot>(`SELECT name, type FROM ${table} WHERE name = @name`, {
        name: 'sparse',
      });

      expect(row?.type).toBeNull();
    });

    // ─── Streaming ──────────────────────────────────────────────────────────

    it('streams rows one at a time', async () => {
      const table = await createRobotsTable();

      for (let i = 0; i < 25; i++) {
        await insertRobot(table, { name: `r${String(i)}`, year: 1900 + i });
      }

      await using stream = await client.queryStream<Robot>(`SELECT id, name, year FROM ${table}`);

      expect(stream.columns.map((column) => column.name)).toEqual(['id', 'name', 'year']);

      let counted = 0;
      for await (const row of stream) {
        expect(typeof row.name).toBe('string');
        counted++;
      }

      expect(counted).toBe(25);
    });

    it('releases a stream the caller leaves early', async () => {
      const table = await createRobotsTable();

      for (let i = 0; i < 10; i++) await insertRobot(table, { name: `r${String(i)}` });

      const stream = await client.queryStream<Robot>(`SELECT id FROM ${table}`);

      for await (const row of stream) {
        expect(typeof row.id).toBe('string');
        break;
      }

      // A second query on the same client proves the response was released rather than left open.
      expect(await client.scalar<number>(`SELECT COUNT(*) FROM ${table}`)).toBe(10);
    });

    // ─── Transactions ───────────────────────────────────────────────────────

    it('commits a transaction', async () => {
      const table = await createRobotsTable();
      const id = await insertRobot(table, { name: 'txn', price: 100 });

      await client.transaction(async (txn) => {
        expect(txn.isStarted).toBe(true);
        expect(txn.txnIdPT).toBeGreaterThan(0n);

        await client.execute(
          `UPDATE ${table} SET price = @price WHERE id = @id`,
          { price: 200, id: camus.id(id) },
          { transaction: txn },
        );
      });

      const row = await client.queryOne<Robot>(`SELECT price FROM ${table} WHERE id = @id`, {
        id: camus.id(id),
      });

      expect(row?.price).toBe(200);
    });

    it('rolls back when the work throws', async () => {
      const table = await createRobotsTable();
      const id = await insertRobot(table, { name: 'txn', price: 100 });

      await expect(
        client.transaction(async (txn) => {
          await client.execute(
            `UPDATE ${table} SET price = @price WHERE id = @id`,
            { price: 999, id: camus.id(id) },
            { transaction: txn },
          );

          throw new Error('the work failed');
        }),
      ).rejects.toThrow('the work failed');

      const row = await client.queryOne<Robot>(`SELECT price FROM ${table} WHERE id = @id`, {
        id: camus.id(id),
      });

      expect(row?.price).toBe(100);
    });

    it('rolls back a transaction its block leaves without a commit', async () => {
      const table = await createRobotsTable();
      const id = await insertRobot(table, { name: 'scoped', price: 100 });

      {
        await using txn = await client.beginTransaction();

        await client.execute(
          `UPDATE ${table} SET price = @price WHERE id = @id`,
          { price: 555, id: camus.id(id) },
          { transaction: txn },
        );
      }

      const row = await client.queryOne<Robot>(`SELECT price FROM ${table} WHERE id = @id`, {
        id: camus.id(id),
      });

      expect(row?.price).toBe(100);
    });

    it('reads its own writes inside a transaction', async () => {
      const table = await createRobotsTable();
      const id = await insertRobot(table, { name: 'rww', price: 1 });

      await client.transaction(async (txn) => {
        await client.execute(
          `UPDATE ${table} SET price = @price WHERE id = @id`,
          { price: 42, id: camus.id(id) },
          { transaction: txn },
        );

        const inside = await client.queryOne<Robot>(
          `SELECT price FROM ${table} WHERE id = @id`,
          { id: camus.id(id) },
          { transaction: txn },
        );

        expect(inside?.price).toBe(42);
      });
    });

    it('runs several statements in one transaction', async () => {
      const table = await createRobotsTable();

      await client.transaction(async (txn) => {
        for (let i = 0; i < 5; i++) {
          await client.execute(
            `INSERT INTO ${table} (id, name, year) VALUES (@id, @name, @year)`,
            { id: CamusObjectId.generateAsString(), name: `batch${String(i)}`, year: 2000 + i },
            { transaction: txn },
          );
        }
      });

      expect(await client.scalar<number>(`SELECT COUNT(*) FROM ${table}`)).toBe(5);
    });

    it('refuses TRUNCATE inside an explicit transaction', async () => {
      const table = await createRobotsTable();

      await using txn = await client.beginTransaction();

      await expect(client.executeDdl(`TRUNCATE ${table}`, { transaction: txn })).rejects.toMatchObject({
        code: 'CADB0538',
      });

      await txn.rollback();
    });

    // ─── Prepared statements ────────────────────────────────────────────────

    it('prepares a hot statement and keeps answering correctly', async () => {
      const table = await createRobotsTable();

      await insertRobot(table, { name: 'prepared', year: 1990 });

      const sql = `SELECT name FROM ${table} WHERE year = @year`;

      for (let i = 0; i < 4; i++) {
        const result = await client.query<Robot>(sql, { year: 1990 });
        expect(result.rows[0]?.name).toBe('prepared');
      }

      expect(client.isPrepared(sql)).toBe(true);
    });

    it('prepares on request', async () => {
      const table = await createRobotsTable();
      const sql = `SELECT * FROM ${table} WHERE year = @year`;

      await client.prepare(sql);

      expect(client.isPrepared(sql)).toBe(true);
      expect((await client.query(sql, { year: 1 })).rowCount).toBe(0);
    });

    // ─── Errors ─────────────────────────────────────────────────────────────

    it('reports an unknown table with the server code', async () => {
      await expect(client.query('SELECT * FROM no_such_table_at_all')).rejects.toMatchObject({
        code: 'CADB0011',
      });
    });

    it('reports a syntax error with the server code', async () => {
      await expect(client.query('SELECT FROM WHERE')).rejects.toSatisfy(
        (error: unknown) => CamusError.is(error) && error.code.startsWith('CADB'),
      );
    });

    it('reports a duplicate primary key', async () => {
      const table = await createRobotsTable();
      const id = await insertRobot(table, { name: 'first' });

      await expect(insertRobot(table, { id, name: 'second' })).rejects.toThrow(CamusError);
    });

    // ─── Cancellation ───────────────────────────────────────────────────────

    it('ends a statement the caller cancels', async () => {
      const controller = new AbortController();
      controller.abort(new Error('caller stopped'));

      await expect(client.query('SELECT 1', undefined, { signal: controller.signal })).rejects.toThrow();
    });
  });
}

suite('REST transport', { protocol: 'rest', endpoint: REST_ENDPOINT });
suite('gRPC transport', { protocol: 'grpc', endpoint: GRPC_ENDPOINT, backupEndpoint: REST_ENDPOINT });

// ─── Features that are REST-only, or that touch the whole server ────────────

describe('database branching', () => {
  let client: CamusClient;
  const branches: string[] = [];

  beforeAll(async () => {
    client = new CamusClient({
      endpoint: REST_ENDPOINT,
      database: DATABASE,
      timeoutSeconds: 30,
      ...CREDENTIALS,
    });

    await client.createDatabase(undefined, { ifNotExists: true });
  });

  afterAll(async () => {
    for (const branch of branches) {
      try {
        await client.dropDatabase(branch);
      } catch {
        // A case may have dropped it already.
      }
    }

    await client.close();
  });

  it('creates a branch and lists it', async () => {
    const branch = uniqueName('branch');

    await client.createBranchDatabase(branch, DATABASE);
    branches.push(branch);

    const listed = await client.showBranches(DATABASE);

    expect(listed.map((row) => row.database)).toContain(branch);

    const found = listed.find((row) => row.database === branch)!;

    expect(found.parent).toBe(DATABASE);
    expect(found.depth).toBeGreaterThan(0);
    expect(found.forkTimestamp).toBeTruthy();
  });

  it('reports the ancestry of a branch', async () => {
    const branch = uniqueName('branch');

    await client.createBranchDatabase(branch, DATABASE);
    branches.push(branch);

    const ancestors = await client.showAncestors(branch);

    expect(ancestors.map((row) => row.database)).toContain(DATABASE);
  });

  it('reports no descendants for a leaf', async () => {
    const branch = uniqueName('branch');

    await client.createBranchDatabase(branch, DATABASE);
    branches.push(branch);

    expect(await client.showBranches(branch)).toEqual([]);
  });

  it('creates and drops a database', async () => {
    const name = uniqueName('db');

    await client.createDatabase(name);
    await client.createDatabase(name, { ifNotExists: true });
    await client.dropDatabase(name);
  });
});

describe('the query result cache', () => {
  let client: CamusClient;
  let table: string;

  beforeAll(async () => {
    client = new CamusClient({
      endpoint: REST_ENDPOINT,
      database: DATABASE,
      timeoutSeconds: 30,
      ...CREDENTIALS,
    });

    await client.createDatabase(undefined, { ifNotExists: true });

    table = uniqueName('cached');

    await client.executeDdl(`CREATE TABLE ${table} (id OID PRIMARY KEY NOT NULL, n INT64)`);

    for (let i = 0; i < 3; i++) {
      await client.execute(`INSERT INTO ${table} (id, n) VALUES (@id, @n)`, {
        id: CamusObjectId.generateAsString(),
        n: i,
      });
    }
  });

  afterAll(async () => {
    try {
      await client.executeDdl(`DROP TABLE ${table}`);
    } catch {
      // The table may already be gone.
    }

    await client.close();
  });

  it('reports a miss, then a hit, for a hinted statement', async () => {
    const family = uniqueName('fam');

    // The hint goes after the table reference, and applies to the whole statement.
    const sql = `SELECT * FROM ${table} ${cacheHint(family, { ttlMs: 30_000 })}`;

    const first = await client.query(sql);

    expect(first.cacheMetadata?.name).toBe(family);
    expect(first.cacheMetadata?.status).toBe('miss');

    const second = await client.query(sql);

    expect(second.cacheMetadata?.status).toBe('hit');
    expect(second.cacheMetadata?.isHit).toBe(true);
    expect(second.cacheMetadata?.cachedAtHlc?.l).toBeTypeOf('bigint');
    expect(second.rows).toEqual(first.rows);
  });

  it('reports nothing for a statement that carried no hint', async () => {
    expect((await client.query(`SELECT * FROM ${table}`)).cacheMetadata).toBeUndefined();
  });

  it('evicts a family, so the next execution misses again', async () => {
    const family = uniqueName('fam');
    const sql = `SELECT * FROM ${table} ${cacheHint(family)}`;

    await client.query(sql);

    expect((await client.query(sql)).cacheMetadata?.status).toBe('hit');

    await client.evictCache(family);

    expect((await client.query(sql)).cacheMetadata?.status).toBe('miss');
  });

  it('evicts every family for this database', async () => {
    await client.evictAllCache();
  });
});

describe('the backup admin API', () => {
  let client: CamusClient;

  beforeAll(() => {
    client = new CamusClient({
      endpoint: REST_ENDPOINT,
      database: DATABASE,
      timeoutSeconds: 60,
      ...CREDENTIALS,
    });
  });

  afterAll(async () => {
    await client.close();
  });

  it('reaches the route, and reports the server verdict either way', async () => {
    try {
      const catalog = await client.backups.listBackups();

      expect(Array.isArray(catalog)).toBe(true);
    } catch (error) {
      // A node with no backup directory configured refuses with its own code, which is a correct
      // answer from the route rather than a failure to reach it.
      expect(CamusError.is(error) && error.code).toBe('CADB0700');
    }
  });
});

/** Deterministic bytes that do not compress. */
function noiseBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;

  for (let i = 0; i < length; i++) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }

  return bytes;
}

describe.runIf(LARGE_VALUES)('large-value storage', () => {
  for (const [name, options] of [
    ['REST transport', { protocol: 'rest', endpoint: REST_ENDPOINT }],
    ['gRPC transport', { protocol: 'grpc', endpoint: GRPC_ENDPOINT }],
  ] as const) {
    describe(name, () => {
      let client: CamusClient;
      const tables: string[] = [];

      beforeAll(async () => {
        const provisioner = new CamusClient({
          endpoint: REST_ENDPOINT,
          database: DATABASE,
          timeoutSeconds: 30,
          ...CREDENTIALS,
        });

        await provisioner.createDatabase(undefined, { ifNotExists: true });
        await provisioner.close();

        client = new CamusClient({ database: DATABASE, timeoutSeconds: 120, ...CREDENTIALS, ...options });
      });

      afterAll(async () => {
        for (const table of tables) {
          try {
            await client.executeDdl(`DROP TABLE ${table}`);
          } catch {
            // A case may have dropped it already.
          }
        }

        await client.close();
      });

      async function showCreateTable(table: string): Promise<string> {
        const result = await client.query<Record<string, unknown>>(`SHOW CREATE TABLE ${table}`);
        const column = result.columns[1]?.name;

        expect(column).toBeDefined();
        return String(result.rows[0]?.[column!]);
      }

      it('round-trips large values through every storage form', async () => {
        const table = uniqueName('lv');

        await client.executeDdl(
          `CREATE TABLE ${table} (` +
            ' id OID PRIMARY KEY NOT NULL,' +
            ' title STRING,' +
            ` body STRING STORAGE ${CamusColumnStorage.Extended},` +
            ` image BYTES STORAGE ${CamusColumnStorage.External},` +
            ` embedding BYTES(3072) STORAGE ${CamusColumnStorage.Plain},` +
            ` tags ARRAY(STRING) STORAGE ${CamusColumnStorage.Main})`,
        );
        tables.push(table);

        // A compressible body far above the out-of-line threshold, an incompressible image, an
        // embedding above the threshold that PLAIN keeps inline, and a compressible array.
        const id = CamusObjectId.generateAsString();
        const body = 'CamusDB stores large values compressed or out of line. '.repeat(4000);
        const image = noiseBytes(100_000, 1);
        const embedding = noiseBytes(3072, 2);
        const tags = Array.from({ length: 400 }, (_, i) => `tag-${String(i % 7)}-${'a'.repeat(36)}`);

        await client.execute(
          `INSERT INTO ${table} (id, title, body, image, embedding, tags)
           VALUES (@id, @title, @body, @image, @embedding, @tags)`,
          { id: camus.id(id), title: 'first', body, image, embedding, tags },
        );

        async function expectRow(title: string): Promise<void> {
          // A narrow read never names a column stored out of line.
          const narrow = await client.queryOne<{ title: string }>(
            `SELECT title FROM ${table} WHERE id = @id`,
            {
              id: camus.id(id),
            },
          );

          expect(narrow?.title).toBe(title);

          const row = await client.queryOne<Record<string, unknown>>(
            `SELECT title, body, image, embedding, tags FROM ${table} WHERE id = @id`,
            { id: camus.id(id) },
          );

          expect(row?.title).toBe(title);
          expect(row?.body).toBe(body);
          expect(Buffer.from(row?.image as Uint8Array).equals(image)).toBe(true);
          expect(Buffer.from(row?.embedding as Uint8Array).equals(embedding)).toBe(true);
          expect(row?.tags).toEqual(tags);
        }

        await expectRow('first');

        // An update of a small column carries the out-of-line pointers; the large values must survive.
        await client.execute(`UPDATE ${table} SET title = @title WHERE id = @id`, {
          title: 'second',
          id: camus.id(id),
        });

        await expectRow('second');

        const created = await showCreateTable(table);

        for (const storage of Object.values(CamusColumnStorage)) {
          expect(created).toContain(`STORAGE ${storage}`);
        }

        // SET STORAGE changes future writes only; REWRITE STORAGE converts the stored rows. Neither
        // may change a value.
        await client.executeDdl(setColumnStorageStatement(table, 'image', CamusColumnStorage.Plain));
        expect(await showCreateTable(table)).toContain('`image` BYTES NULL STORAGE PLAIN');

        await client.rewriteStorage(table);
        await expectRow('second');

        await client.rewriteStorage(table, { inline: true });
        await expectRow('second');
      });

      it('refuses a storage strategy on a fixed-width column', async () => {
        await expect(
          client.executeDdl(
            `CREATE TABLE ${uniqueName('lv_bad')} (id OID PRIMARY KEY NOT NULL, year INT64 STORAGE PLAIN)`,
          ),
        ).rejects.toMatchObject({ code: 'CADB0414' });
      });
    });
  }
});

describe('unsupported column types', () => {
  it('reports the server error rather than sending nonsense', async () => {
    const client = new CamusClient({
      endpoint: REST_ENDPOINT,
      database: DATABASE,
      timeoutSeconds: 30,
      ...CREDENTIALS,
    });

    await expect(
      client.executeDdl(`CREATE TABLE ${uniqueName('bad')} (id OID PRIMARY KEY, n NO_SUCH_TYPE)`),
    ).rejects.toThrow(CamusError);

    await client.close();
  });
});

it('exposes the array column type for a caller that needs it', () => {
  expect(ColumnType.Array).toBe(10);
});

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
