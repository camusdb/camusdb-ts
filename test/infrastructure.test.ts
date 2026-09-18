import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusError } from '../src/errors.js';
import { CamusPreparedStatementPolicy, PrepareDecision } from '../src/prepared/policy.js';
import { bindPositional } from '../src/prepared/binder.js';
import { computeDelayMs, isRetryable, withRetry } from '../src/retry.js';
import { CamusRoutingDisposition, makeRoutingAdvice, routingAdviceFromJson } from '../src/routing/advice.js';
import { CamusRouteOpKind, CamusStatementRouteCache, routeKey } from '../src/routing/route-cache.js';
import { CamusStatementRouter } from '../src/routing/router.js';
import { SharedRegistry } from '../src/shared-registry.js';
import {
  isDdlStatement,
  isDmlStatement,
  isPreparableStatement,
  runsInOwnTransaction,
} from '../src/statements.js';
import { sanitizeErrorText } from '../src/transport/error-text.js';
import { ColumnType } from '../src/column-type.js';
import {
  cacheHint,
  CamusCacheStatus,
  evictAllCacheStatement,
  evictCacheStatement,
  makeCacheMetadata,
} from '../src/cache.js';
import {
  CamusColumnStorage,
  isColumnStorage,
  rewriteStorageStatement,
  setColumnStorageStatement,
} from '../src/column-storage.js';
import { delimitIdentifier, sqlLiteral, validateBareName } from '../src/sql-syntax.js';

beforeEach(() => {
  CamusEndpointPool.resetShared();
  CamusStatementRouter.resetShared();
  CamusPreparedStatementPolicy.resetShared();
});

describe('CamusEndpointPool', () => {
  it('rotates over every endpoint', () => {
    const pool = new CamusEndpointPool('http://a,http://b,http://c');

    expect([pool.next(), pool.next(), pool.next(), pool.next()]).toEqual([
      'http://a',
      'http://b',
      'http://c',
      'http://a',
    ]);
  });

  it('skips an endpoint that was marked unreachable', () => {
    const pool = new CamusEndpointPool('http://a,http://b');
    pool.clock = () => 0;

    pool.markUnreachable('http://a');

    expect(pool.next()).toBe('http://b');
    expect(pool.next()).toBe('http://b');
    expect(pool.isQuarantined('http://a')).toBe(true);
  });

  it('draws a quarantined endpoint again once the period passes', () => {
    const pool = new CamusEndpointPool('http://a,http://b');
    let now = 0;
    pool.clock = () => now;

    pool.markUnreachable('http://a');
    now = CamusEndpointPool.QUARANTINE_PERIOD_MS + 1;

    expect(pool.isQuarantined('http://a')).toBe(false);
    expect([pool.next(), pool.next()].sort()).toEqual(['http://a', 'http://b']);
  });

  it('still reports an endpoint when every one is quarantined', () => {
    const pool = new CamusEndpointPool('http://a');
    pool.clock = () => 0;

    pool.markUnreachable('http://a');

    expect(pool.next()).toBe('http://a');
  });

  it('reports which addresses it lists', () => {
    const pool = new CamusEndpointPool(' http://a , http://b ');

    expect(pool.members).toEqual(['http://a', 'http://b']);
    expect(pool.contains('HTTP://A')).toBe(true);
    expect(pool.contains('http://z')).toBe(false);
    expect(pool.isQuarantined('http://z')).toBe(false);
  });

  it('refuses an empty endpoint list', () => {
    expect(() => new CamusEndpointPool('  ,  ')).toThrow(CamusError);
  });

  it('shares one pool per endpoint list', () => {
    expect(CamusEndpointPool.forEndpoints('http://a')).toBe(CamusEndpointPool.forEndpoints('http://a'));
    expect(CamusEndpointPool.forEndpoints('http://a')).not.toBe(CamusEndpointPool.forEndpoints('http://b'));
  });
});

describe('SharedRegistry', () => {
  it('builds one object per key', () => {
    const registry = new SharedRegistry<{ id: number }>();
    let next = 0;

    const first = registry.get('a', () => ({ id: ++next }));

    expect(registry.get('a', () => ({ id: ++next }))).toBe(first);
    expect(registry.get('b', () => ({ id: ++next })).id).toBe(2);
  });

  it('stops sharing past its cap', () => {
    const registry = new SharedRegistry<{ id: number }>(2);

    registry.get('a', () => ({ id: 1 }));
    registry.get('b', () => ({ id: 2 }));

    const third = registry.get('c', () => ({ id: 3 }));

    expect(registry.get('c', () => ({ id: 4 }))).not.toBe(third);
    expect([...registry.values()]).toHaveLength(2);
  });
});

describe('CamusStatementRouteCache', () => {
  const key = routeKey('test', 'SELECT 1', CamusRouteOpKind.Query);

  it('reports a miss for an unknown statement', () => {
    const cache = new CamusStatementRouteCache(10, 1024);

    expect(cache.tryGet(key, 0)).toEqual({ nodeId: undefined, revision: 0 });
  });

  it('records and reports a destination', () => {
    const cache = new CamusStatementRouteCache(10, 1024);

    cache.learn(key, 32, 'node-a', 'token', 1000, 0, 0);

    expect(cache.tryGet(key, 500).nodeId).toBe('node-a');
  });

  it('drops an entry that expired', () => {
    const cache = new CamusStatementRouteCache(10, 1024);

    cache.learn(key, 32, 'node-a', undefined, 1000, 0, 0);

    expect(cache.tryGet(key, 1001).nodeId).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('refuses a write whose observed revision is stale', () => {
    const cache = new CamusStatementRouteCache(10, 1024);

    cache.learn(key, 32, 'node-a', undefined, 1000, 0, 0);

    const current = cache.tryGet(key, 0).revision;

    // A late reply that observed the entry before it was written must not overwrite it.
    cache.learn(key, 32, 'node-b', undefined, 1000, current - 1, 0);

    expect(cache.tryGet(key, 0).nodeId).toBe('node-a');

    cache.learn(key, 32, 'node-b', undefined, 1000, current, 0);

    expect(cache.tryGet(key, 0).nodeId).toBe('node-b');
  });

  it('refuses a first write that did not observe an absent entry', () => {
    const cache = new CamusStatementRouteCache(10, 1024);

    cache.learn(key, 32, 'node-a', undefined, 1000, 7, 0);

    expect(cache.size).toBe(0);
  });

  it('forgets an entry only at its current revision', () => {
    const cache = new CamusStatementRouteCache(10, 1024);

    cache.learn(key, 32, 'node-a', undefined, 1000, 0, 0);

    const current = cache.tryGet(key, 0).revision;

    cache.clear(key, current - 1);
    expect(cache.size).toBe(1);

    cache.clear(key, current);
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry past its count bound', () => {
    const cache = new CamusStatementRouteCache(2, 1024 * 1024);

    const keys = ['a', 'b', 'c'].map((sql) => routeKey('test', sql, CamusRouteOpKind.Query));

    cache.learn(keys[0]!, 32, 'node', undefined, 10_000, 0, 1);
    cache.learn(keys[1]!, 32, 'node', undefined, 10_000, 0, 2);
    cache.tryGet(keys[1]!, 3);
    cache.learn(keys[2]!, 32, 'node', undefined, 10_000, 0, 4);

    expect(cache.size).toBe(2);
    expect(cache.tryGet(keys[0]!, 5).nodeId).toBeUndefined();
    expect(cache.tryGet(keys[1]!, 5).nodeId).toBe('node');
  });

  it('evicts past its byte bound too', () => {
    const cache = new CamusStatementRouteCache(1000, 200);

    for (let i = 0; i < 20; i++) {
      cache.learn(
        routeKey('test', `sql-${String(i)}`, CamusRouteOpKind.Query),
        64,
        'node',
        undefined,
        10_000,
        0,
        i,
      );
    }

    expect(cache.size).toBeLessThan(5);
  });
});

describe('CamusStatementRouter', () => {
  function router(): CamusStatementRouter {
    const pool = new CamusEndpointPool('http://a,http://b');
    pool.clock = () => 0;

    const built = new CamusStatementRouter(
      new Map([
        ['camus-a:7070', 'http://a'],
        ['camus-b:7070', 'http://b'],
      ]),
      pool,
      5000,
    );

    built.clock = () => 0;
    return built;
  }

  const prefer = makeRoutingAdvice({
    version: 1,
    disposition: 'prefer',
    preferredNodeId: 'camus-a:7070',
    reuseScope: 'statementParametersIndependent',
    dependencyToken: 'token',
    maxAgeMs: 1000,
    reason: 'singleTableHash',
  });

  it('learns a destination and steers the next execution to it', () => {
    const subject = router();

    expect(subject.selectEndpoint('test', 'SELECT 1', CamusRouteOpKind.Query).endpoint).toBeUndefined();

    subject.learn('test', 'SELECT 1', CamusRouteOpKind.Query, prefer, 0);

    expect(subject.selectEndpoint('test', 'SELECT 1', CamusRouteOpKind.Query).endpoint).toBe('http://a');
    expect(subject.learnedRouteCount).toBe(1);
  });

  it('keeps a route per statement kind', () => {
    const subject = router();

    subject.learn('test', 'SELECT 1', CamusRouteOpKind.Query, prefer, 0);

    expect(subject.selectEndpoint('test', 'SELECT 1', CamusRouteOpKind.NonQuery).endpoint).toBeUndefined();
  });

  it('forgets a destination on a clear disposition', () => {
    const subject = router();

    subject.learn('test', 'SELECT 1', CamusRouteOpKind.Query, prefer, 0);

    const observed = subject.selectEndpoint('test', 'SELECT 1', CamusRouteOpKind.Query).revision;

    subject.learn(
      'test',
      'SELECT 1',
      CamusRouteOpKind.Query,
      makeRoutingAdvice({
        version: 1,
        disposition: 'clear',
        preferredNodeId: undefined,
        reuseScope: undefined,
        dependencyToken: undefined,
        maxAgeMs: 0,
        reason: 'ineligible',
      }),
      observed,
    );

    expect(subject.learnedRouteCount).toBe(0);
  });

  it('ignores advice it cannot use', () => {
    const subject = router();

    const cases = [
      { ...prefer, version: 2 },
      { ...prefer, parametersIndependentScope: false },
      { ...prefer, preferredNodeId: 'camus-z:7070' },
      { ...prefer, maxAgeMs: 0 },
      { ...prefer, disposition: CamusRoutingDisposition.Unknown },
    ];

    for (const advice of cases) {
      subject.learn('test', 'SELECT 1', CamusRouteOpKind.Query, advice, 0);
    }

    subject.learn('test', 'SELECT 1', CamusRouteOpKind.Query, undefined, 0);

    expect(subject.learnedRouteCount).toBe(0);
  });

  it('falls back to rotation when the learned node is quarantined', () => {
    const pool = new CamusEndpointPool('http://a,http://b');
    pool.clock = () => 0;

    const subject = new CamusStatementRouter(new Map([['camus-a:7070', 'http://a']]), pool, 5000);
    subject.clock = () => 0;

    subject.learn('test', 'SELECT 1', CamusRouteOpKind.Query, prefer, 0);
    pool.markUnreachable('http://a');

    expect(subject.selectEndpoint('test', 'SELECT 1', CamusRouteOpKind.Query).endpoint).toBeUndefined();
  });

  it('caps the reuse period at the client ceiling', () => {
    const pool = new CamusEndpointPool('http://a');
    pool.clock = () => 0;

    const subject = new CamusStatementRouter(new Map([['camus-a:7070', 'http://a']]), pool, 100);
    let now = 0;
    subject.clock = () => now;

    subject.learn('test', 'SELECT 1', CamusRouteOpKind.Query, prefer, 0);

    now = 99;
    expect(subject.selectEndpoint('test', 'SELECT 1', CamusRouteOpKind.Query).endpoint).toBe('http://a');

    now = 101;
    expect(subject.selectEndpoint('test', 'SELECT 1', CamusRouteOpKind.Query).endpoint).toBeUndefined();
  });
});

describe('routingAdviceFromJson', () => {
  it('reads a response envelope', () => {
    const advice = routingAdviceFromJson({
      routing: {
        version: 1,
        disposition: 'prefer',
        preferredNodeId: 'camus-a:7070',
        reuseScope: 'statementParametersIndependent',
        dependencyToken: 'abc',
        maxAgeMs: 2000,
        reason: 'singleTableHash',
      },
    });

    expect(advice).toEqual({
      version: 1,
      disposition: CamusRoutingDisposition.Prefer,
      preferredNodeId: 'camus-a:7070',
      parametersIndependentScope: true,
      dependencyToken: 'abc',
      maxAgeMs: 2000,
      reason: 'singleTableHash',
    });
  });

  it('reports nothing when a response carried no advice', () => {
    expect(routingAdviceFromJson({ rows: 1 })).toBeUndefined();
    expect(routingAdviceFromJson(null)).toBeUndefined();
  });
});

describe('CamusPreparedStatementPolicy', () => {
  it('prepares a statement once it is hot enough', () => {
    const policy = new CamusPreparedStatementPolicy(8, 2);

    expect(policy.decide('test', 'SELECT 1').decision).toBe(PrepareDecision.No);
    expect(policy.decide('test', 'SELECT 1').decision).toBe(PrepareDecision.Register);

    // While the registration is in flight the statement runs inline.
    expect(policy.decide('test', 'SELECT 1').decision).toBe(PrepareDecision.No);

    policy.markPrepared('test', 'SELECT 1');

    expect(policy.decide('test', 'SELECT 1').decision).toBe(PrepareDecision.Yes);
    expect(policy.isPrepared('test', 'SELECT 1')).toBe(true);
    expect(policy.preparedCount).toBe(1);
  });

  it('stops offering a statement the server refused', () => {
    const policy = new CamusPreparedStatementPolicy(8, 1);

    expect(policy.decide('test', 'SELECT 1').decision).toBe(PrepareDecision.Register);
    policy.markRefused('test', 'SELECT 1');

    expect(policy.decide('test', 'SELECT 1').decision).toBe(PrepareDecision.No);
  });

  it('prepares nothing at all once disabled', () => {
    const policy = new CamusPreparedStatementPolicy(8, 1);

    policy.disable();

    expect(policy.isDisabled).toBe(true);
    expect(policy.decide('test', 'SELECT 1').decision).toBe(PrepareDecision.No);
  });

  it('is off when its cap is zero', () => {
    expect(new CamusPreparedStatementPolicy(0, 1).isDisabled).toBe(true);
  });

  it('lets an explicit request override a refusal', () => {
    const policy = new CamusPreparedStatementPolicy(8, 2);

    policy.decide('test', 'SELECT 1');
    policy.markRefused('test', 'SELECT 1');

    expect(policy.pin('test', 'SELECT 1').decision).toBe(PrepareDecision.Register);
  });

  it('reports an evicted registration so the caller can release it', () => {
    const policy = new CamusPreparedStatementPolicy(2, 1);

    policy.decide('test', 'A');
    policy.markPrepared('test', 'A');
    policy.decide('test', 'B');

    const { evicted } = policy.decide('test', 'C');

    expect(evicted).toEqual({ database: 'test', sql: 'A' });
  });

  it('does not report a statement that was never registered', () => {
    const policy = new CamusPreparedStatementPolicy(1, 5);

    policy.decide('test', 'A');

    expect(policy.decide('test', 'B').evicted).toBeUndefined();
  });

  it('forgets a statement so it is reconsidered', () => {
    const policy = new CamusPreparedStatementPolicy(8, 1);

    policy.decide('test', 'SELECT 1');
    policy.forget('test', 'SELECT 1');

    expect(policy.decide('test', 'SELECT 1').decision).toBe(PrepareDecision.Register);
  });
});

describe('bindPositional', () => {
  it('orders values the way the statement binds them', () => {
    const values = bindPositional(
      ['@b', '@a'],
      new Map([
        ['@a', { type: ColumnType.Integer64, longValue: 1n }],
        ['@b', { type: ColumnType.Integer64, longValue: 2n }],
      ]),
    );

    expect(values.map((value) => value.longValue)).toEqual([2n, 1n]);
  });

  it('refuses a placeholder with no bound value', () => {
    expect(() => bindPositional(['@a'], new Map())).toThrow(CamusError);
    expect(() => bindPositional(['@a'], undefined)).toThrow(CamusError);
  });
});

describe('retry', () => {
  it('reports which failures are retryable', () => {
    expect(isRetryable(new CamusError('CADB0502', 'conflict'))).toBe(true);
    expect(isRetryable(new CamusError('CADB0000', 'MustRetry later'))).toBe(true);
    expect(isRetryable(new CamusError('CADB0509', 'unresolved'))).toBe(false);
    expect(isRetryable(new CamusError('CADB0516', 'auth'))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });

  it('reads a retryable failure through a cause chain', () => {
    const wrapped = new Error('outer', { cause: new CamusError('CADB0504', 'AlreadyLocked') });

    expect(isRetryable(wrapped)).toBe(true);
  });

  it('runs the work again while it fails retryably', async () => {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new CamusError('CADB0502', 'conflict');
        return 'done';
      },
      { maxAttempts: 5 },
    );

    expect(result).toBe('done');
    expect(attempts).toBe(3);
  });

  it('reports the failure once the attempts run out', async () => {
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new CamusError('CADB0502', 'conflict');
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toThrow(CamusError);

    expect(attempts).toBe(2);
  });

  it('does not retry a failure that is not retryable', async () => {
    let attempts = 0;

    await expect(
      withRetry(async () => {
        attempts++;
        throw new CamusError('CADB0516', 'auth');
      }),
    ).rejects.toThrow(CamusError);

    expect(attempts).toBe(1);
  });

  it('backs off within its documented bounds', () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const delay = computeDelayMs(attempt);

      expect(delay).toBeGreaterThanOrEqual(1);
      expect(delay).toBeLessThanOrEqual(500);
    }
  });
});

describe('sanitizeErrorText', () => {
  it('masks a credential-shaped run', () => {
    expect(sanitizeErrorText('failed with Bearer eyJhbGciOi.abc rejected')).toBe(
      'failed with Bearer *** rejected',
    );

    expect(sanitizeErrorText('{"password":"hunter2"}')).toBe('{"password":***"}');
    expect(sanitizeErrorText('pwd=hunter2;Database=test')).toBe('pwd=***;Database=test');
  });

  it('folds a control character to a space', () => {
    expect(sanitizeErrorText('a\nb\rc')).toBe('a b c');
  });

  it('bounds the length', () => {
    const long = 'x'.repeat(5000);
    const clean = sanitizeErrorText(long);

    expect(clean.length).toBe(2049);
    expect(clean.endsWith('…')).toBe(true);
  });

  it('accepts nothing', () => {
    expect(sanitizeErrorText(undefined)).toBe('');
    expect(sanitizeErrorText('')).toBe('');
  });
});

describe('statement classification', () => {
  it('routes schema statements to the DDL route', () => {
    expect(isDdlStatement('CREATE TABLE robots (id id)')).toBe(true);
    expect(isDdlStatement('  create unique index ix ON robots (name)')).toBe(true);
    expect(isDdlStatement('CREATE OR REPLACE VIEW v AS SELECT 1')).toBe(true);
    expect(isDdlStatement('TRUNCATE robots')).toBe(true);
    expect(isDdlStatement('REFRESH MATERIALIZED VIEW v')).toBe(false);
    expect(isDdlStatement('SELECT 1')).toBe(false);
  });

  it('recognizes a write statement', () => {
    expect(isDmlStatement('insert into robots values ()')).toBe(true);
    expect(isDmlStatement('SELECT 1')).toBe(false);
  });

  it('recognizes a statement worth preparing', () => {
    expect(isPreparableStatement('SELECT 1')).toBe(true);
    expect(isPreparableStatement('SHOW BRANCHES FROM x')).toBe(true);
    expect(isPreparableStatement('CREATE TABLE t (id id)')).toBe(false);
  });

  it('recognizes a statement that owns its transaction', () => {
    expect(runsInOwnTransaction('TRUNCATE robots')).toBe(true);
    expect(runsInOwnTransaction('DELETE FROM robots')).toBe(false);
  });

  it('routes the storage statements to the DDL route, outside the own-transaction list', () => {
    // The server runs REWRITE STORAGE in its own batches but does not refuse it inside a
    // transaction, so the driver must not refuse it either.
    for (const sql of [
      'ALTER TABLE docs REWRITE STORAGE',
      'ALTER TABLE docs ALTER COLUMN body SET STORAGE MAIN',
    ]) {
      expect(isDdlStatement(sql)).toBe(true);
      expect(runsInOwnTransaction(sql)).toBe(false);
    }
  });
});

describe('column storage helpers', () => {
  it('uses the SQL keywords as member values', () => {
    expect(Object.values(CamusColumnStorage)).toEqual(['EXTENDED', 'PLAIN', 'MAIN', 'EXTERNAL']);
  });

  it('recognizes a strategy in its exact spelling only', () => {
    expect(isColumnStorage('PLAIN')).toBe(true);
    expect(isColumnStorage('plain')).toBe(false);
    expect(isColumnStorage('PLAIN, MAIN')).toBe(false);
    expect(isColumnStorage(1)).toBe(false);
    expect(isColumnStorage(undefined)).toBe(false);
  });

  it('builds a SET STORAGE statement', () => {
    expect(setColumnStorageStatement('docs', 'thumbnail', CamusColumnStorage.External)).toBe(
      'ALTER TABLE `docs` ALTER COLUMN `thumbnail` SET STORAGE EXTERNAL',
    );
  });

  it('refuses a strategy that is not a keyword', () => {
    expect(() => setColumnStorageStatement('docs', 'body', 'COMPRESSED' as CamusColumnStorage)).toThrow(
      TypeError,
    );
    expect(() =>
      setColumnStorageStatement('docs', 'body', 'MAIN; DROP TABLE docs' as CamusColumnStorage),
    ).toThrow(TypeError);
  });

  it('builds a REWRITE STORAGE statement, with and without INLINE', () => {
    expect(rewriteStorageStatement('docs')).toBe('ALTER TABLE `docs` REWRITE STORAGE');
    expect(rewriteStorageStatement('docs', { inline: false })).toBe('ALTER TABLE `docs` REWRITE STORAGE');
    expect(rewriteStorageStatement('docs', { inline: true })).toBe(
      'ALTER TABLE `docs` REWRITE STORAGE INLINE',
    );
  });

  it('refuses a name that cannot be delimited', () => {
    expect(() => rewriteStorageStatement('do`cs')).toThrow(TypeError);
    expect(() => setColumnStorageStatement('docs', ' ', CamusColumnStorage.Plain)).toThrow(TypeError);
  });
});

describe('cache helpers', () => {
  it('builds a hint', () => {
    expect(cacheHint('robots')).toBe('{cache=robots}');
    expect(cacheHint('robots', { ttlMs: 30_000 })).toBe('{cache=robots, ttl=30000}');
    expect(cacheHint('robots', { ttlMs: 1, strict: true })).toBe('{cache=robots, ttl=1, strict}');
  });

  it('refuses a name that cannot be written into SQL', () => {
    expect(() => cacheHint("robots'; DROP DATABASE x --")).toThrow(TypeError);
    expect(() => cacheHint('')).toThrow(TypeError);
    expect(() => cacheHint('x'.repeat(129))).toThrow(TypeError);
  });

  it('refuses a family name the hint grammar cannot read', () => {
    // A hint writes the name unquoted, so anything outside the identifier set is a parse error on
    // the server. It is refused here instead, where the name was written.
    expect(() => cacheHint('with-dash')).toThrow(TypeError);
    expect(() => cacheHint('with.dot')).toThrow(TypeError);
    expect(() => cacheHint('with:colon')).toThrow(TypeError);
    expect(() => cacheHint('9leading')).toThrow(TypeError);

    expect(cacheHint('with_underscore')).toBe('{cache=with_underscore}');
    expect(cacheHint('_leading')).toBe('{cache=_leading}');
    expect(cacheHint('trailing9')).toBe('{cache=trailing9}');
  });

  it('accepts a quoted family name for an eviction, which the hint would refuse', () => {
    // EVICT CACHE takes a quoted string, so it can reach a family minted elsewhere.
    expect(evictCacheStatement('with-dash')).toBe("EVICT CACHE 'with-dash'");
  });

  it('refuses a time to live that is out of range', () => {
    expect(() => cacheHint('robots', { ttlMs: 0 })).toThrow(RangeError);
    expect(() => cacheHint('robots', { ttlMs: 1.5 })).toThrow(RangeError);
  });

  it('builds the eviction statements', () => {
    expect(evictCacheStatement('robots')).toBe("EVICT CACHE 'robots'");
    expect(evictAllCacheStatement()).toBe('EVICT CACHE ALL');
  });

  it('parses a cache verdict', () => {
    expect(makeCacheMetadata({ rawStatus: 'hit', name: 'robots' })).toMatchObject({
      status: CamusCacheStatus.Hit,
      isHit: true,
      name: 'robots',
    });

    expect(makeCacheMetadata({ rawStatus: 'nonsense' }).status).toBe(CamusCacheStatus.Unknown);
    expect(makeCacheMetadata({}).status).toBe(CamusCacheStatus.None);
  });
});

describe('sql syntax', () => {
  it('quotes a literal and doubles its quotes', () => {
    expect(sqlLiteral("O'Brien", 'name')).toBe("'O''Brien'");
  });

  it('refuses a literal the lexer would read differently', () => {
    expect(() => sqlLiteral("a\\'b", 'name')).toThrow(TypeError);
    expect(() => sqlLiteral('trailing\\', 'name')).toThrow(TypeError);
  });

  it('allows a backslash that does not precede a quote', () => {
    expect(sqlLiteral('a\\nb', 'name')).toBe("'a\\nb'");
  });

  it('delimits an identifier', () => {
    expect(delimitIdentifier('robots', 'name')).toBe('`robots`');
    expect(() => delimitIdentifier('ro`bots', 'name')).toThrow(TypeError);
    expect(() => delimitIdentifier('  ', 'name')).toThrow(TypeError);
  });

  it('validates a bare name', () => {
    expect(() => validateBareName('a-b.c:d_1', 32, 'name')).not.toThrow();
    expect(() => validateBareName('a b', 32, 'name')).toThrow(TypeError);
  });
});

describe('vi timers are not needed', () => {
  it('keeps the suite free of real waiting', () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});
