import { beforeEach, describe, expect, it } from 'vitest';

import { CamusProtocol, CamusRoutingMode, resolveConnectionString, resolveOptions } from '../src/config.js';
import { parseConnectionString, redactConnectionString } from '../src/connection-string.js';
import { CamusEndpointPool } from '../src/endpoint-pool.js';
import { CamusError } from '../src/errors.js';
import { CamusIsolationLevel, CamusLocking, CamusTransactionMode } from '../src/options.js';

beforeEach(() => {
  CamusEndpointPool.resetShared();
});

describe('parseConnectionString', () => {
  it('reads key and value pairs', () => {
    const settings = parseConnectionString('Endpoint=http://localhost:8082;Database=test');

    expect(settings.get('Endpoint')).toBe('http://localhost:8082');
    expect(settings.get('Database')).toBe('test');
  });

  it('matches keys without regard to case and trims them', () => {
    const settings = parseConnectionString(' password = secret ;  UID=app');

    expect(settings.get('Password')).toBe('secret');
    expect(settings.get('uid')).toBe('app');
  });

  it('reads a quoted value that holds a semicolon', () => {
    const settings = parseConnectionString("Password='pa;ss';Database=test");

    expect(settings.get('Password')).toBe('pa;ss');
    expect(settings.get('Database')).toBe('test');
  });

  it('reads a doubled quote as one literal quote', () => {
    const settings = parseConnectionString("Password='pa;ss''word';Database=test");

    expect(settings.get('Password')).toBe("pa;ss'word");
    expect(settings.get('Database')).toBe('test');
  });

  it('keeps spaces inside a quoted value', () => {
    expect(parseConnectionString('Password=" pad "').get('Password')).toBe(' pad ');
  });

  it('ignores a segment with no equals sign', () => {
    const settings = parseConnectionString('nonsense;Database=test');

    expect(settings.get('Database')).toBe('test');
  });

  it('accepts an empty string', () => {
    expect([...parseConnectionString('')]).toHaveLength(0);
  });

  it('refuses a repeated key', () => {
    expect(() => parseConnectionString('Database=a;database=b')).toThrow(CamusError);
  });

  it('refuses an unclosed quoted value', () => {
    expect(() => parseConnectionString("Password='oops")).toThrow(CamusError);
  });
});

describe('redactConnectionString', () => {
  it('masks every secret and leaves the rest as written', () => {
    const redacted = redactConnectionString(
      'Endpoint=https://db:5095;Database=test;User=app;Password=secret;AccessToken=abc',
    );

    expect(redacted).toBe('Endpoint=https://db:5095;Database=test;User=app;Password=***;AccessToken=***');
  });

  it('keeps the quotes around a masked value', () => {
    expect(redactConnectionString("Database=test;Password='pa;ss'")).toBe("Database=test;Password='***'");
  });

  it('masks a lowercase key', () => {
    expect(redactConnectionString('pwd=secret')).toBe('pwd=***');
  });

  it('reports nothing for a string it cannot parse', () => {
    expect(redactConnectionString("Password='unclosed")).toBe('***');
  });

  it('accepts an empty value', () => {
    expect(redactConnectionString('')).toBe('');
    expect(redactConnectionString(undefined)).toBe('');
  });
});

describe('resolveConnectionString', () => {
  it('applies every default', () => {
    const config = resolveConnectionString('Endpoint=http://localhost:8082;Database=test');

    expect(config.timeoutSeconds).toBe(10);
    expect(config.protocol).toBe(CamusProtocol.Rest);
    expect(config.maxAutoPrepare).toBe(128);
    expect(config.autoPrepareMinUsages).toBe(2);
    expect(config.backupTimeoutSeconds).toBe(300);
    expect(config.routingMode).toBe(CamusRoutingMode.Auto);
    expect(config.routingMaxHintAgeMs).toBe(5000);
    expect(config.batch.channelPoolSize).toBe(2);
    expect(config.decode.int64).toBe('auto');
  });

  it('reads every tuning key', () => {
    const config = resolveConnectionString(
      'Endpoint=http://localhost:8082;Database=test;Timeout=30;Protocol=grpc;' +
        'MaxAutoPrepare=8;AutoPrepareMinUsages=1;ChannelPoolSize=4;CoalescingThreshold=20;' +
        'CoalescingDelay=3;BackupTimeout=60;RoutingMaxHintAge=1500;Int64=bigint',
    );

    expect(config.timeoutSeconds).toBe(30);
    expect(config.protocol).toBe(CamusProtocol.Grpc);
    expect(config.maxAutoPrepare).toBe(8);
    expect(config.autoPrepareMinUsages).toBe(1);
    expect(config.batch).toEqual({ channelPoolSize: 4, coalescingThreshold: 20, coalescingDelayMs: 3 });
    expect(config.backupTimeoutSeconds).toBe(60);
    expect(config.routingMaxHintAgeMs).toBe(1500);
    expect(config.decode.int64).toBe('bigint');
  });

  it('falls back to the default for an unusable value', () => {
    const config = resolveConnectionString(
      'Endpoint=http://localhost:8082;Database=test;Timeout=zero;ChannelPoolSize=0;Protocol=carrier-pigeon',
    );

    expect(config.timeoutSeconds).toBe(10);
    expect(config.batch.channelPoolSize).toBe(2);
    expect(config.protocol).toBe(CamusProtocol.Rest);
  });

  it('reads the concurrency defaults', () => {
    const config = resolveConnectionString(
      'Endpoint=http://localhost:8082;Database=test;IsolationLevel=readcommitted;' +
        'TransactionMode=readonly;Locking=optimistic',
    );

    expect(config.defaultTransactionOptions).toEqual({
      isolationLevel: CamusIsolationLevel.ReadCommitted,
      mode: CamusTransactionMode.ReadOnly,
      locking: CamusLocking.Optimistic,
    });
  });

  it('reads the credentials, and their aliases', () => {
    expect(
      resolveConnectionString('Endpoint=https://db:5095;Database=test;Uid=app;Pwd=secret').credentials,
    ).toEqual({ user: 'app', password: 'secret' });

    expect(
      resolveConnectionString('Endpoint=https://db:5095;Database=test;AccessToken=abc').credentials,
    ).toEqual({ accessToken: 'abc' });
  });

  it('refuses a missing endpoint or database', () => {
    expect(() => resolveConnectionString('Database=test')).toThrow(CamusError);
    expect(() => resolveConnectionString('Endpoint=http://localhost:8082')).toThrow(CamusError);
  });

  it('keeps only routing nodes that map a configured endpoint', () => {
    const config = resolveConnectionString(
      'Endpoint=http://a:5095,http://b:5095;Database=test;' +
        "RoutingNodes='camus-a:7070=http://a:5095,camus-b:7070=http://b:5095,camus-c:7070=http://c:5095'",
    );

    expect([...config.routingNodes.keys()].sort()).toEqual(['camus-a:7070', 'camus-b:7070']);
  });

  it('skips a malformed routing entry rather than failing', () => {
    const config = resolveConnectionString(
      "Endpoint=http://a:5095;Database=test;RoutingNodes='nonsense,camus-a:7070=http://a:5095,=x,y='",
    );

    expect([...config.routingNodes.keys()]).toEqual(['camus-a:7070']);
  });
});

describe('credentials over a plaintext endpoint', () => {
  it('allows credentials to loopback', () => {
    expect(() =>
      resolveConnectionString('Endpoint=http://localhost:8082;Database=test;User=app;Password=x'),
    ).not.toThrow();

    expect(() =>
      resolveConnectionString('Endpoint=http://127.0.0.1:8082;Database=test;User=app;Password=x'),
    ).not.toThrow();
  });

  it('allows credentials over https', () => {
    expect(() =>
      resolveConnectionString('Endpoint=https://db.example:5095;Database=test;User=app;Password=x'),
    ).not.toThrow();
  });

  it('refuses credentials to a remote plaintext endpoint', () => {
    expect(() =>
      resolveConnectionString('Endpoint=http://db.example:5095;Database=test;User=app;Password=x'),
    ).toThrow(CamusError);

    try {
      resolveConnectionString('Endpoint=http://db.example:5095;Database=test;User=app;Password=x');
    } catch (error) {
      expect(CamusError.is(error) && error.code).toBe('CADB0519');
    }
  });

  it('refuses a plaintext backup endpoint too', () => {
    expect(() =>
      resolveConnectionString(
        'Endpoint=https://db:5095;Database=test;BackupEndpoint=http://admin.example;User=app;Password=x',
      ),
    ).toThrow(CamusError);
  });

  it('sends no credentials, so a plaintext endpoint is fine', () => {
    expect(() => resolveConnectionString('Endpoint=http://db.example:5095;Database=test')).not.toThrow();
  });

  it('waives the refusal when the operator asks', () => {
    expect(() =>
      resolveConnectionString(
        'Endpoint=http://db.example:5095;Database=test;User=app;Password=x;AllowInsecureCredentials=true',
      ),
    ).not.toThrow();
  });
});

describe('resolveOptions', () => {
  it('accepts an endpoint list as an array', () => {
    const config = resolveOptions({
      endpoint: ['http://a:5095', 'http://b:5095'],
      database: 'test',
    });

    expect(config.endpointList).toBe('http://a:5095,http://b:5095');
  });

  it('accepts a routing map as an object', () => {
    const config = resolveOptions({
      endpoint: 'http://a:5095',
      database: 'test',
      routingNodes: { 'camus-a:7070': 'http://a:5095', 'camus-z:7070': 'http://z:5095' },
    });

    expect([...config.routingNodes.keys()]).toEqual(['camus-a:7070']);
  });

  it('refuses an empty endpoint or database', () => {
    expect(() => resolveOptions({ endpoint: '', database: 'test' })).toThrow(CamusError);
    expect(() => resolveOptions({ endpoint: 'http://a', database: '  ' })).toThrow(CamusError);
  });

  it('applies the same plaintext refusal as a connection string', () => {
    expect(() =>
      resolveOptions({ endpoint: 'http://db.example', database: 'test', user: 'app', password: 'x' }),
    ).toThrow(CamusError);
  });
});
