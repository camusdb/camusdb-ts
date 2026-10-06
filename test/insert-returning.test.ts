import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CamusClient } from '../src/client.js';
import { ColumnType } from '../src/column-type.js';
import { DEFAULT_BATCH_OPTIONS } from '../src/config.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusPreparedStatementPolicy } from '../src/prepared/policy.js';
import { CamusStatementRouter } from '../src/routing/router.js';
import { hasReturningKeyword } from '../src/sql-syntax.js';
import { isInsertReturning } from '../src/statements.js';
import { CamusTokenProvider } from '../src/auth/token-provider.js';
import { GrpcBatcher } from '../src/transport/grpc/batcher.js';
import type { BatchStream } from '../src/transport/grpc/batcher.js';
import type { GrpcBatchExecuteRequest, GrpcBatchExecuteResponse } from '../src/transport/grpc/messages.js';
import { loadGrpc } from '../src/transport/grpc/proto.js';
import { CamusTransportPool } from '../src/transport/transport-pool.js';
import { FakeCamusServer, respondJson, respondNdjson } from './support/fake-server.js';

describe('the RETURNING keyword scan', () => {
  it.each([
    'INSERT INTO t (a) VALUES (1) RETURNING a',
    'insert into t (a) values (1) returning *',
    'INSERT INTO t (a) VALUES (1)\nRETURNING\ta',
    "INSERT INTO t (a) VALUES ('x') RETURNING a",
    "INSERT INTO t (a) VALUES ('it''s') RETURNING a",
    "INSERT INTO t (a) VALUES ('a\\'b') RETURNING a",
    'INSERT INTO t SELECT * FROM s /* comment */ RETURNING id',
    'INSERT INTO t (a) VALUES (1) -- note\nRETURNING a',
  ])('finds the keyword in %j', (sql) => {
    expect(hasReturningKeyword(sql)).toBe(true);
  });

  it.each([
    'INSERT INTO t (a) VALUES (1)',
    "INSERT INTO t (a) VALUES ('RETURNING')",
    "INSERT INTO t (a) VALUES ('it''s RETURNING')",
    'INSERT INTO t (`returning`) VALUES (1)',
    'INSERT INTO t (a) VALUES (@returning)',
    'INSERT INTO t (a) VALUES (1) -- RETURNING a',
    'INSERT INTO t (a) VALUES (1) /* RETURNING a */',
    'INSERT INTO returning_log (a) VALUES (1)',
    'INSERT INTO t (a) SELECT s.returning FROM s',
    'INSERT INTO t (a) VALUES ("RETURNING")',
    "INSERT INTO t (a) VALUES ('unterminated RETURNING",
  ])('does not find the keyword in %j', (sql) => {
    expect(hasReturningKeyword(sql)).toBe(false);
  });

  it('accepts an INSERT only', () => {
    expect(isInsertReturning('  insert into t (a) values (1) returning a')).toBe(true);
    expect(isInsertReturning('UPDATE t SET a = 1 RETURNING a')).toBe(false);
    expect(isInsertReturning('SELECT 1 AS returning_value')).toBe(false);
  });
});

describe('INSERT … RETURNING over REST', () => {
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

  function client(connectionSuffix = ''): CamusClient {
    return new CamusClient(
      `Endpoint=${server.endpoint};Database=returning-${String(suffix)};Timeout=5${connectionSuffix}`,
    );
  }

  const returningReply = {
    status: 'ok',
    rows: 2,
    columns: [
      { name: 'id', type: ColumnType.Id },
      { name: 'n', type: ColumnType.Integer64 },
    ],
    returningRows: [
      ['6849f3aa', 10],
      ['6849f3bb', 20],
    ],
  };

  it('reads the returned rows through query', async () => {
    server.json('execute-sql-non-query', returningReply);

    const result = await client().query<{ id: string; n: number }>(
      'INSERT INTO t (id, n) VALUES (GEN_ID(), 10), (GEN_ID(), 20) RETURNING id, n',
    );

    expect(result.columns.map((column) => column.name)).toEqual(['id', 'n']);
    expect(result.rows).toEqual([
      { id: '6849f3aa', n: 10 },
      { id: '6849f3bb', n: 20 },
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.affectedRows).toBe(2);

    // The caller asks for the rows, so the request does not carry the count-only flag.
    expect(server.callCount('execute-sql-query')).toBe(0);
    expect(server.requestsTo('execute-sql-non-query')[0]!.body).not.toHaveProperty('discardReturningRows');
  });

  it('reads the first returned value through scalar', async () => {
    server.json('execute-sql-non-query', returningReply);

    await expect(client().scalar<string>('INSERT INTO t (n) VALUES (10) RETURNING id')).resolves.toBe(
      '6849f3aa',
    );
  });

  it('reads the first returned row through queryOne', async () => {
    server.json('execute-sql-non-query', returningReply);

    await expect(client().queryOne('INSERT INTO t (n) VALUES (10) RETURNING id, n')).resolves.toEqual({
      id: '6849f3aa',
      n: 10,
    });
  });

  it('keeps the schema when the statement inserted no rows', async () => {
    server.json('execute-sql-non-query', {
      status: 'ok',
      rows: 0,
      columns: [{ name: 'id', type: ColumnType.Id }],
      returningRows: [],
    });

    const result = await client().query('INSERT INTO t SELECT * FROM s WHERE FALSE RETURNING id');

    expect(result.columns.map((column) => column.name)).toEqual(['id']);
    expect(result.rows).toEqual([]);
    expect(result.affectedRows).toBe(0);
  });

  it('sends the autocommit options with the write', async () => {
    server.json('execute-sql-non-query', returningReply);

    await client(';IsolationLevel=Serializable;Locking=Optimistic').query(
      'INSERT INTO t (n) VALUES (1) RETURNING id',
    );

    expect(server.requestsTo('execute-sql-non-query')[0]!.body).toMatchObject({
      isolationLevel: 'Serializable',
      locking: 'Optimistic',
    });
  });

  it('asks for the count only through execute', async () => {
    server.json('execute-sql-non-query', { status: 'ok', rows: 2 });

    const result = await client().execute('INSERT INTO t (n) VALUES (1), (2) RETURNING id');

    expect(result.affectedRows).toBe(2);
    expect(server.requestsTo('execute-sql-non-query')[0]!.body).toMatchObject({ discardReturningRows: true });
  });

  it('sends the statement to the streaming query endpoint through queryStream', async () => {
    server.on('execute-sql-query-stream', (_request, response) => {
      respondNdjson(response, [
        { status: 'ok', columns: [{ name: 'id', type: ColumnType.Id }] },
        ['6849f3aa'],
        { status: 'ok', total: 1, serverTimeMs: 0.5 },
      ]);
    });

    await using stream = await client(';IsolationLevel=Serializable;Locking=Optimistic').queryStream<{
      id: string;
    }>('INSERT INTO t (n) VALUES (1) RETURNING id');

    const rows: { id: string }[] = [];
    for await (const row of stream) rows.push(row);

    expect(rows).toEqual([{ id: '6849f3aa' }]);

    // The autocommit INSERT runs in a writable transaction, so its options travel with it. The
    // query endpoint refuses the count-only flag, so the request must not carry it.
    const body = server.requestsTo('execute-sql-query-stream')[0]!.body;

    expect(body).toMatchObject({ isolationLevel: 'Serializable', locking: 'Optimistic' });
    expect(body).not.toHaveProperty('discardReturningRows');
  });

  it('sends no autocommit options with a read', async () => {
    server.on('execute-sql-query', (_request, response) => {
      respondJson(response, 200, {
        status: 'ok',
        columns: [{ name: 'n', type: ColumnType.Integer64 }],
        rows: [],
      });
    });

    await client(';IsolationLevel=Serializable;Locking=Optimistic').query('SELECT n FROM t');

    const body = server.requestsTo('execute-sql-query')[0]!.body;

    expect(body).not.toHaveProperty('isolationLevel');
    expect(body).not.toHaveProperty('locking');
    expect(body).not.toHaveProperty('discardReturningRows');
  });

  it('keeps a plain INSERT on the query endpoint through query', async () => {
    server.on('execute-sql-query', (_request, response) => {
      respondJson(response, 200, { status: 'ok', columns: [], rows: [] });
    });

    // A backtick column named `returning` is not the clause, so the statement is not rerouted.
    await client().query('INSERT INTO t (`returning`) VALUES (1)');

    expect(server.callCount('execute-sql-query')).toBe(1);
    expect(server.callCount('execute-sql-non-query')).toBe(0);
  });
});

describe('INSERT … RETURNING over gRPC', () => {
  class FakeStream implements BatchStream {
    readonly sent: GrpcBatchExecuteRequest[] = [];

    framesAnnounced = false;

    closed = false;

    private handlers:
      | { onMessage: (response: GrpcBatchExecuteResponse) => void; onClose: (error: Error) => void }
      | undefined;

    constructor(
      readonly id: number,
      private readonly answer: (request: GrpcBatchExecuteRequest, stream: FakeStream) => void,
    ) {}

    send(request: GrpcBatchExecuteRequest): void {
      this.sent.push(request);
      this.answer(request, this);
    }

    listen(handlers: {
      onMessage: (response: GrpcBatchExecuteResponse) => void;
      onClose: (error: Error) => void;
    }): void {
      this.handlers = handlers;
    }

    reply(response: GrpcBatchExecuteResponse): void {
      this.handlers?.onMessage(response);
    }

    close(): void {
      this.closed = true;
    }
  }

  function batcher(answer: (request: GrpcBatchExecuteRequest, stream: FakeStream) => void): GrpcBatcher {
    return new GrpcBatcher(
      { ...DEFAULT_BATCH_OPTIONS, channelPoolSize: 1 },
      (id) => new FakeStream(id, answer),
    );
  }

  it('passes the returned schema and rows through the batcher', async () => {
    const subject = batcher((request, stream) => {
      stream.reply({
        requestId: request.requestId,
        payload: 'nonQuery',
        nonQuery: {
          affectedRows: 1,
          causalTokenL: '0',
          causalTokenC: '0',
          causalTokenN: 0,
          warning: '',
          returningSchema: { columns: [{ name: 'id', type: ColumnType.Id }] },
          returningRows: [{ values: [{ kind: 'idValue', idValue: '6849f3aa' }] }],
        },
      });
    });

    const result = await subject.enqueueNonQuery({ sql: 'INSERT … RETURNING id' }, undefined, undefined);

    expect(result.returningSchema?.columns.map((column) => column.name)).toEqual(['id']);
    expect(result.returningRows).toHaveLength(1);

    await subject.dispose();
  });

  it('keeps an unset schema apart from an empty result', async () => {
    const subject = batcher((request, stream) => {
      stream.reply({
        requestId: request.requestId,
        payload: 'nonQuery',
        nonQuery: {
          affectedRows: 3,
          causalTokenL: '0',
          causalTokenC: '0',
          causalTokenN: 0,
          warning: '',
          returningSchema: null,
          returningRows: [],
        },
      });
    });

    const result = await subject.enqueueNonQuery({ sql: 'UPDATE t SET a = 1' }, undefined, undefined);

    expect(result.returningSchema).toBeUndefined();
    expect(result.returningRows).toEqual([]);

    await subject.dispose();
  });

  it('declares the RETURNING fields in the proto', async () => {
    const { definition } = await loadGrpc();

    const fieldNames = (typeName: string): string[] => {
      const key = Object.keys(definition).find((name) => name === typeName || name.endsWith(`.${typeName}`));
      const type = (definition[key!] as { type: { field: { name: string }[] } }).type;
      return type.field.map((field) => field.name);
    };

    expect(fieldNames('SqlRequest')).toContain('discardReturningRows');
    expect(fieldNames('NonQueryReply')).toEqual(expect.arrayContaining(['returningSchema', 'returningRows']));
  });
});
