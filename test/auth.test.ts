import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { credentialsFromPassword, credentialsFromToken, NO_CREDENTIALS } from '../src/auth/credentials.js';
import type { CamusLoginClient, CamusLoginResult } from '../src/auth/login-client.js';
import { RestLoginClient } from '../src/auth/rest-login-client.js';
import { CamusTokenProvider } from '../src/auth/token-provider.js';
import { CamusError } from '../src/errors.js';
import { AuthenticatingTransport } from '../src/transport/authenticating-transport.js';
import type { CamusTransport, TransportSqlRequest } from '../src/transport/transport.js';
import { CamusResultSet } from '../src/result-set.js';
import { CamusProtocol } from '../src/config.js';
import { FakeCamusServer } from './support/fake-server.js';

/** A login client that records what it was asked and answers from a script. */
class ScriptedLoginClient implements CamusLoginClient {
  logins = 0;
  logouts = 0;
  lastLogout: string | undefined;

  private nextToken = 1;

  constructor(private readonly expiresInMs?: number) {}

  async login(): Promise<CamusLoginResult> {
    this.logins++;

    const result: CamusLoginResult = {
      token: `token-${String(this.nextToken++)}`,
      ...(this.expiresInMs === undefined ? {} : { expiresInMs: this.expiresInMs }),
    };

    // A real login is a round trip; yielding here is what lets the single-flight test race.
    await new Promise((resolve) => setTimeout(resolve, 5));

    return result;
  }

  async logout(_endpoint: string, token: string): Promise<void> {
    this.logouts++;
    this.lastLogout = token;
  }
}

/** A login client whose token names the user, and whose round trip takes that user's own time. */
class PerUserLoginClient implements CamusLoginClient {
  logins = 0;

  constructor(private readonly delaysMs: Record<string, number>) {}

  async login(_endpoint: string, user: string): Promise<CamusLoginResult> {
    this.logins++;

    await new Promise((resolve) => setTimeout(resolve, this.delaysMs[user] ?? 1));

    return { token: `token-for-${user}` };
  }

  async logout(): Promise<void> {
    // The race tests never revoke a token.
  }
}

function provider(
  client: CamusLoginClient,
  credentials = credentialsFromPassword('app', 'secret'),
): CamusTokenProvider {
  return new CamusTokenProvider({
    credentials,
    resolveLoginClient: () => client,
    resolveEndpoint: () => 'http://localhost:8082',
    resolveTimeoutSeconds: () => 5,
    lifetimeMs: 600_000,
  });
}

describe('CamusTokenProvider', () => {
  it('reports nothing when nothing is configured', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client, NO_CREDENTIALS);

    expect(auth.isEnabled).toBe(false);
    expect(await auth.getToken()).toBeUndefined();
    expect(client.logins).toBe(0);
  });

  it('mints a token on first use and reuses it', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client);

    expect(await auth.getToken()).toBe('token-1');
    expect(await auth.getToken()).toBe('token-1');
    expect(client.logins).toBe(1);
    expect(auth.currentToken).toBe('token-1');
  });

  it('performs one login for many concurrent callers', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client);

    const tokens = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);

    expect(tokens).toEqual(['token-1', 'token-1', 'token-1']);
    expect(client.logins).toBe(1);
  });

  it('renews at 80% of the lifetime the server reported', async () => {
    const client = new ScriptedLoginClient(1000);
    const auth = provider(client);

    let now = 0;
    auth.clock = () => now;

    expect(await auth.getToken()).toBe('token-1');

    now = 799;
    expect(await auth.getToken()).toBe('token-1');

    now = 801;
    expect(await auth.getToken()).toBe('token-2');
    expect(client.logins).toBe(2);
  });

  it('falls back to its own lifetime when the server reports none', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client);

    let now = 0;
    auth.clock = () => now;

    await auth.getToken();

    now = 599_999;
    expect(await auth.getToken()).toBe('token-1');

    now = 600_001;
    expect(await auth.getToken()).toBe('token-2');
  });

  it('mints a new token after the one it held was rejected', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client);

    await auth.getToken();
    auth.invalidate('token-1');

    expect(await auth.getToken()).toBe('token-2');
  });

  it('keeps a token a concurrent caller already replaced', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client);

    await auth.getToken();
    auth.invalidate('token-1');
    await auth.getToken();

    // A late rejection of the first token must not discard the second.
    auth.invalidate('token-1');

    expect(auth.currentToken).toBe('token-2');
  });

  it('uses a directly supplied token as written and never renews it', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client, credentialsFromToken('supplied'));

    expect(auth.canRenew).toBe(false);
    expect(await auth.getToken()).toBe('supplied');

    auth.invalidate('supplied');

    // Invalidation does nothing, because there is no password to mint a replacement with.
    expect(await auth.getToken()).toBe('supplied');
    expect(client.logins).toBe(0);
  });

  it('reports a clear failure when a supplied token is rejected and cannot be replaced', async () => {
    const client = new ScriptedLoginClient();

    const auth = new CamusTokenProvider({
      credentials: { accessToken: 'supplied' },
      resolveLoginClient: () => client,
      resolveEndpoint: () => 'http://localhost:8082',
      resolveTimeoutSeconds: () => 5,
    });

    const now = 0;
    auth.clock = () => now;

    // Force the cache past its deadline without a password to renew with.
    (auth as unknown as { renewAfter: number }).renewAfter = -1;

    await expect(auth.getToken()).rejects.toMatchObject({ code: 'CADB0516' });
  });

  it('switches identity on an explicit login', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client, NO_CREDENTIALS);

    expect(await auth.login('app', 'secret')).toBe('token-1');
    expect(auth.isEnabled).toBe(true);
    expect(await auth.getToken()).toBe('token-1');
  });

  it('does not cache a token minted with the credentials a login replaced', async () => {
    // The first login is the slow one, so it finishes after the login that replaced it.
    const client = new PerUserLoginClient({ app: 20, other: 1 });
    const auth = provider(client);

    const first = auth.getToken();
    const second = auth.login('other', 'secret');

    await expect(second).resolves.toBe('token-for-other');
    await expect(first).resolves.toBe('token-for-app');

    // The caller that asked for the first token still receives it. It is not the cached one.
    expect(auth.currentToken).toBe('token-for-other');
    expect(await auth.getToken()).toBe('token-for-other');
    expect(client.logins).toBe(2);
  });

  it('joins the newer login rather than starting a third', async () => {
    // Here the first login is the fast one: it settles while the login that replaced it runs.
    const client = new PerUserLoginClient({ app: 1, other: 20 });
    const auth = provider(client);

    const first = auth.getToken();
    const second = auth.login('other', 'secret');

    await expect(first).resolves.toBe('token-for-app');

    const third = auth.getToken();

    await expect(second).resolves.toBe('token-for-other');
    await expect(third).resolves.toBe('token-for-other');
    expect(client.logins).toBe(2);
  });

  it('revokes the token it holds and keeps the credentials', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client);

    await auth.getToken();
    await auth.logout();

    expect(client.logouts).toBe(1);
    expect(client.lastLogout).toBe('token-1');
    expect(auth.currentToken).toBeUndefined();

    // A later statement authenticates again on its own.
    expect(await auth.getToken()).toBe('token-2');
  });

  it('does nothing on a logout with no token', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client);

    await auth.logout();

    expect(client.logouts).toBe(0);
  });

  it('hashes its sharing key rather than holding the password', () => {
    const key = CamusTokenProvider.sharingKey(credentialsFromPassword('app', 'secret'), 'http://a|rest');

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('secret');

    expect(CamusTokenProvider.sharingKey(credentialsFromPassword('app', 'secret'), 'http://a|rest')).toBe(
      key,
    );
    expect(CamusTokenProvider.sharingKey(credentialsFromPassword('app', 'other'), 'http://a|rest')).not.toBe(
      key,
    );
    expect(CamusTokenProvider.sharingKey(credentialsFromPassword('app', 'secret'), 'http://b|rest')).not.toBe(
      key,
    );
  });
});

describe('RestLoginClient', () => {
  let server: FakeCamusServer;

  beforeAll(async () => {
    server = await FakeCamusServer.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  it('exchanges a password for a token', async () => {
    server.json('login', { status: 'ok', token: 'abc', expiresInSeconds: 900 });

    const result = await new RestLoginClient().login(server.endpoint, 'app', 'secret', 5);

    expect(result).toEqual({ token: 'abc', expiresInMs: 900_000 });
    expect(server.requestsTo('login')[0]!.body).toEqual({ user: 'app', password: 'secret' });
  });

  it('prefers the duration the server measured over the absolute instant', async () => {
    server.json('login', {
      status: 'ok',
      token: 'abc',
      expiresInSeconds: 60,
      expiresAtUnixMs: Date.now() + 999_000,
    });

    const result = await new RestLoginClient().login(server.endpoint, 'app', 'secret', 5);

    expect(result.expiresInMs).toBe(60_000);
  });

  it('falls back to the absolute instant', async () => {
    server.json('login', { status: 'ok', token: 'abc', expiresAtUnixMs: Date.now() + 30_000 });

    const result = await new RestLoginClient().login(server.endpoint, 'app', 'secret', 5);

    expect(result.expiresInMs).toBeGreaterThan(25_000);
    expect(result.expiresInMs).toBeLessThanOrEqual(30_000);
  });

  it('reports no expiry against a server that sends none', async () => {
    server.json('login', { status: 'ok', token: 'abc' });

    expect(
      (await new RestLoginClient().login(server.endpoint, 'app', 'secret', 5)).expiresInMs,
    ).toBeUndefined();
  });

  it('reports rejected credentials with the server code', async () => {
    server.json('login', { status: 'failed', code: 'CADB0516', message: 'nope' }, 401);

    await expect(new RestLoginClient().login(server.endpoint, 'app', 'wrong', 5)).rejects.toMatchObject({
      code: 'CADB0516',
    });
  });

  it('presents the token when it revokes one', async () => {
    server.json('logout', { status: 'ok' });

    await new RestLoginClient().logout(server.endpoint, 'abc', 5);

    expect(server.requestsTo('logout')[0]!.headers.authorization).toBe('Bearer abc');
  });
});

/** A transport that answers from a script, so the wrapper can be driven without a server. */
class ScriptedTransport implements CamusTransport {
  readonly protocol = CamusProtocol.Rest;

  calls = 0;

  constructor(private readonly script: (call: number) => Promise<unknown>) {}

  private run<T>(): Promise<T> {
    return this.script(++this.calls) as Promise<T>;
  }

  startTransaction = () => this.run<never>();
  finalizeTransaction = () => this.run<void>();
  executeQuery = (_request: TransportSqlRequest) => this.run<never>();
  executeQueryStream = () => this.run<never>();
  executeNonQuery = () => this.run<never>();
  insert = () => this.run<number>();
  executeDdl = () => this.run<boolean>();
  prepare = () => this.run<never>();
  closePrepared = () => Promise.resolve();
  ping = () => this.run<boolean>();
  createDatabase = () => this.run<void>();
  createBranchDatabase = () => this.run<void>();
  dropDatabase = () => this.run<void>();
  showBranches = () => this.run<never>();
  showAncestors = () => this.run<never>();
  close = () => Promise.resolve();
}

describe('AuthenticatingTransport', () => {
  const query = {
    endpoint: 'http://localhost:8082',
    database: 'test',
    sql: 'SELECT 1',
    timeoutSeconds: 5,
    prepared: false,
    routingAcceptVersion: 0,
  } satisfies TransportSqlRequest;

  it('replays once with a fresh token after a rejection', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client);

    const inner = new ScriptedTransport((call) => {
      if (call === 1) return Promise.reject(new CamusError('CADB0516', 'expired'));
      return Promise.resolve({ resultSet: CamusResultSet.EMPTY });
    });

    const transport = new AuthenticatingTransport(inner, auth);

    await auth.getToken();
    await transport.executeQuery(query);

    expect(inner.calls).toBe(2);

    // The rejected token was discarded, so the next statement mints a new one. The wrapper itself
    // never logs in: only the inner transport asks for a token, and it does so per call.
    expect(auth.currentToken).toBeUndefined();
    expect(await auth.getToken()).toBe('token-2');
  });

  it('replays only once', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client);

    const inner = new ScriptedTransport(() => Promise.reject(new CamusError('CADB0516', 'expired')));
    const transport = new AuthenticatingTransport(inner, auth);

    await auth.getToken();

    await expect(transport.executeQuery(query)).rejects.toMatchObject({ code: 'CADB0516' });
    expect(inner.calls).toBe(2);
  });

  it('does not replay a refusal that a new token cannot fix', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client);

    const inner = new ScriptedTransport(() => Promise.reject(new CamusError('CADB0517', 'no privilege')));
    const transport = new AuthenticatingTransport(inner, auth);

    await auth.getToken();

    await expect(transport.executeQuery(query)).rejects.toMatchObject({ code: 'CADB0517' });
    expect(inner.calls).toBe(1);
  });

  it('does not replay when there is no password to mint a replacement with', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client, credentialsFromToken('supplied'));

    const inner = new ScriptedTransport(() => Promise.reject(new CamusError('CADB0516', 'rejected')));
    const transport = new AuthenticatingTransport(inner, auth);

    await expect(transport.executeQuery(query)).rejects.toMatchObject({ code: 'CADB0516' });
    expect(inner.calls).toBe(1);
  });

  it('discards the token the first statement minted during its own call', async () => {
    const client = new ScriptedLoginClient();
    const auth = provider(client);

    const inner = new ScriptedTransport(async (call) => {
      // The inner transport mints the token, exactly as a real one does on its first statement.
      await auth.getToken();

      if (call === 1) throw new CamusError('CADB0516', 'expired');

      return { resultSet: CamusResultSet.EMPTY };
    });

    const transport = new AuthenticatingTransport(inner, auth);

    await transport.executeQuery(query);

    expect(inner.calls).toBe(2);
    expect(auth.currentToken).toBe('token-2');
  });
});
