/**
 * Offline coverage for CALL, which runs a procedure that a C# extension on the server defines: the
 * route that each entry point picks, the CALL statement that `call` composes, and trigger DDL. A fake
 * server answers over real HTTP, so no CamusDB server is needed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CamusClient } from '../src/client.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusPreparedStatementPolicy } from '../src/prepared/policy.js';
import { CamusStatementRouter } from '../src/routing/router.js';
import { isPlainIdentifier } from '../src/sql-syntax.js';
import {
  callStatement,
  isCallStatement,
  isDdlStatement,
  isDmlStatement,
  isPreparableStatement,
  isWriteReturning,
} from '../src/statements.js';
import { operationName } from '../src/telemetry.js';
import { CamusTokenProvider } from '../src/auth/token-provider.js';
import { CamusTransportPool } from '../src/transport/transport-pool.js';
import { FakeCamusServer, respondJson } from './support/fake-server.js';

describe('CALL classification', () => {
  it('reads CALL as a count-only statement on the non-query route', () => {
    expect(isCallStatement("CALL transfer('alice', 'bob', 30)")).toBe(true);
    expect(isCallStatement('  call refresh_totals()')).toBe(true);
    expect(isDmlStatement('CALL transfer(@a, @b)')).toBe(true);
    expect(isCallStatement('SELECT call FROM t')).toBe(false);
  });

  it('does not prepare CALL, and does not read it as a write with RETURNING', () => {
    expect(isPreparableStatement('CALL transfer(@a, @b)')).toBe(false);
    expect(isWriteReturning("CALL log_it('x') RETURNING")).toBe(false);
  });

  it('names the CALL operation in telemetry', () => {
    expect(operationName('CALL transfer(@a, @b)')).toBe('CALL');
  });

  it('routes trigger DDL to the DDL route', () => {
    expect(
      isDdlStatement(
        "CREATE TRIGGER audit ON robots AFTER INSERT, UPDATE EXTERNAL NAME 'MyCompany.Ext.AuditTrigger'",
      ),
    ).toBe(true);
    expect(isDdlStatement('DROP TRIGGER audit ON robots')).toBe(true);
    expect(isDdlStatement('  drop  trigger audit ON robots')).toBe(true);
  });
});

describe('callStatement', () => {
  it('composes CALL with the parameters in key order', () => {
    expect(callStatement('transfer', { '@from': 'alice', to: 'bob', '@amount': 30 })).toBe(
      'CALL transfer(@from, @to, @amount)',
    );
  });

  it('composes empty arguments without parameters', () => {
    expect(callStatement(' refresh_totals ')).toBe('CALL refresh_totals()');
    expect(callStatement('refresh_totals', {})).toBe('CALL refresh_totals()');
  });

  it.each(["transfer('a', 'b', 1)", 'CALL transfer', '`transfer`', '', '1transfer', 'trans-fer', 'café'])(
    'refuses %j, which is not a procedure name',
    (text) => {
      expect(() => callStatement(text)).toThrow(TypeError);
    },
  );

  it('refuses an empty parameter name', () => {
    expect(() => callStatement('transfer', { '': 1 })).toThrow(expect.objectContaining({ code: 'CADB0400' }));
  });

  it('reads a plain identifier as ASCII letters, digits, and _', () => {
    expect(isPlainIdentifier('_x9')).toBe(true);
    expect(isPlainIdentifier('Transfer_2')).toBe(true);
    expect(isPlainIdentifier('9x')).toBe(false);
    expect(isPlainIdentifier('a b')).toBe(false);
  });
});

describe('CALL over REST', () => {
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

    server.json('execute-sql-non-query', { status: 'ok', rows: 2 });
    server.json('execute-sql-ddl', { status: 'ok' });
  });

  function client(): CamusClient {
    return new CamusClient(`Endpoint=${server.endpoint};Database=calls-${String(suffix)};Timeout=5`);
  }

  function sentSql(): string[] {
    return server.requestsTo('execute-sql-non-query').map((request) => (request.body as { sql: string }).sql);
  }

  it('reports the changed-row count through execute', async () => {
    await expect(client().execute("CALL transfer('alice', 'bob', 30)")).resolves.toMatchObject({
      affectedRows: 2,
    });

    expect(sentSql()).toEqual(["CALL transfer('alice', 'bob', 30)"]);
  });

  it.each(["CALL transfer('alice', 'bob', 30)", "  call transfer('alice', 'bob', 30)"])(
    'sends %j from query to the non-query route',
    async (sql) => {
      const result = await client().query(sql);

      expect(result.rows).toEqual([]);
      expect(result.columns).toEqual([]);
      expect(result.affectedRows).toBe(2);
      expect(server.callCount('execute-sql-query')).toBe(0);
      expect(server.callCount('execute-sql-non-query')).toBe(1);
    },
  );

  it('reads no value through scalar', async () => {
    await expect(client().scalar('CALL refresh_totals()')).resolves.toBeUndefined();

    expect(server.callCount('execute-sql-query')).toBe(0);
  });

  it('sends CALL from queryStream to the non-query route', async () => {
    await using stream = await client().queryStream('CALL refresh_totals()');

    expect(stream.affectedRows).toBe(2);
    expect(stream.columns).toEqual([]);
    expect(await stream.toArray()).toEqual([]);
    expect(server.callCount('execute-sql-query-stream')).toBe(0);
    expect(server.callCount('execute-sql-non-query')).toBe(1);
  });

  it('composes CALL with the parameters in key order through call', async () => {
    const result = await client().call('transfer', { '@from': 'alice', to: 'bob', amount: 30n });

    expect(result.affectedRows).toBe(2);
    expect(sentSql()).toEqual(['CALL transfer(@from, @to, @amount)']);

    const body = server.requestsTo('execute-sql-non-query')[0]!.body as {
      parameters: Record<string, unknown>;
    };

    expect(Object.keys(body.parameters)).toEqual(['@from', '@to', '@amount']);
  });

  it('calls a procedure without parameters with empty arguments', async () => {
    await client().call(' refresh_totals ');

    expect(sentSql()).toEqual(['CALL refresh_totals()']);
  });

  it('refuses text that is not a procedure name, and sends nothing', async () => {
    await expect(client().call("transfer('a', 'b', 1)")).rejects.toThrow(TypeError);

    expect(server.requests).toHaveLength(0);
  });

  it('runs CALL inside a transaction', async () => {
    server.on('start-transaction', (_request, response) => {
      respondJson(response, 200, '{"status":"ok","txnIdPT":638765432109876543,"txnIdCounter":9}');
    });
    server.json('commit-transaction', { status: 'ok' });

    const camus = client();

    await camus.transaction(async (transaction) => {
      await camus.call('transfer', { from: 'alice', to: 'bob', amount: 30 }, { transaction });
    });

    expect(server.requestsTo('execute-sql-non-query')[0]!.rawBody).toContain('"txnIdPT":638765432109876543');
    expect(server.callCount('commit-transaction')).toBe(1);
  });

  it('sends trigger DDL from execute to the DDL route', async () => {
    const camus = client();

    await expect(
      camus.execute("CREATE TRIGGER audit ON robots AFTER INSERT EXTERNAL NAME 'MyCompany.Ext.AuditTrigger'"),
    ).resolves.toEqual({ affectedRows: 0 });
    await camus.execute('DROP TRIGGER audit ON robots');

    expect(server.callCount('execute-sql-ddl')).toBe(2);
    expect(server.callCount('execute-sql-non-query')).toBe(0);
  });

  it('does not retry an extension error', async () => {
    server.json(
      'execute-sql-non-query',
      { status: 'error', code: 'CADB0817', message: 'the trigger extension is not loaded' },
      500,
    );

    await expect(client().execute('INSERT INTO t (a) VALUES (1)')).rejects.toMatchObject({
      code: 'CADB0817',
    });

    expect(server.callCount('execute-sql-non-query')).toBe(1);
  });
});
