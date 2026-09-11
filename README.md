# CamusDB Connector for Node.js

The TypeScript client library for [CamusDB](https://github.com/camusdb/camusdb).

```shell
npm install camusdb
```

The gRPC transport needs two more packages. Install them only if you use it:

```shell
npm install @grpc/grpc-js @grpc/proto-loader
```

**Requirements**: Node.js 20.11 or later. The package ships as ECMAScript modules with TypeScript
declarations.

---

## Contents

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Queries](#queries)
- [Parameters](#parameters)
- [Types](#types)
- [Writes](#writes)
- [Streaming](#streaming)
- [Transactions](#transactions)
- [Retries](#retries)
- [Prepared statements](#prepared-statements)
- [Authentication](#authentication)
- [Transport: REST and gRPC](#transport-rest-and-grpc)
- [Endpoint pools](#endpoint-pools)
- [Learned routing](#learned-routing)
- [Databases and branches](#databases-and-branches)
- [The query result cache](#the-query-result-cache)
- [Backups](#backups)
- [Errors](#errors)
- [Cancellation and deadlines](#cancellation-and-deadlines)
- [What a client shares](#what-a-client-shares)
- [Security notes](#security-notes)
- [Development](#development)

---

## Quick start

```ts
import { CamusClient } from 'camusdb';

const client = new CamusClient({
  endpoint: 'http://localhost:8082',
  database: 'test',
});

await client.executeDdl(`
  CREATE TABLE robots (
    id ID PRIMARY KEY,
    name STRING NOT NULL,
    year INT64 NOT NULL
  )
`);

await client.execute('INSERT INTO robots (id, name, year) VALUES (GEN_ID(), @name, @year)', {
  name: 'r1',
  year: 1974,
});

interface Robot {
  id: string;
  name: string;
  year: number;
}

const { rows } = await client.query<Robot>('SELECT id, name, year FROM robots WHERE year = @year', {
  year: 1974,
});

console.log(rows);
```

A client is cheap to create and safe to share. It opens no socket of its own — see
[What a client shares](#what-a-client-shares).

---

## Configuration

Build a client from an options object, or from a connection string. The two forms are
interchangeable, and every option maps to one connection-string key.

```ts
import { CamusClient } from 'camusdb';

// An options object.
const a = new CamusClient({ endpoint: 'http://localhost:8082', database: 'test' });

// A connection string.
const b = CamusClient.fromConnectionString('Endpoint=http://localhost:8082;Database=test');
```

### Options

| Option | Connection-string key | Required | Description |
| --- | --- | --- | --- |
| `endpoint` | `Endpoint` | Yes | The base URL, or several to rotate through. Pass an array, or a comma-separated list. |
| `database` | `Database` | Yes | The database name sent with every request. |
| `timeoutSeconds` | `Timeout` | No | The request timeout in seconds. Default `10`. |
| `protocol` | `Protocol` | No | `rest` (the default) or `grpc`. |
| `user` | `User` | No | The user to authenticate as. Key aliases: `UserId`, `Uid`, `Username`. |
| `password` | `Password` | No | That user's password. Key alias: `Pwd`. |
| `accessToken` | `AccessToken` | No | A bearer token obtained elsewhere, used as written. |
| `tokenLifetimeSeconds` | `TokenLifetime` | No | Fallback seconds to reuse a token when the server reports no expiry. Default `600`. |
| `maxAutoPrepare` | `MaxAutoPrepare` | No | How many statements to keep prepared. Default `128`. Zero turns it off. |
| `autoPrepareMinUsages` | `AutoPrepareMinUsages` | No | Executions of the same SQL before it is prepared. Default `2`. |
| `channelPoolSize` | `ChannelPoolSize` | No | gRPC only: streams per endpoint. Default `2`. |
| `coalescingThreshold` | `CoalescingThreshold` | No | gRPC only. Default `10`. `1` turns coalescing off. |
| `coalescingDelayMs` | `CoalescingDelay` | No | gRPC only: milliseconds. Default `0`, which is off. |
| `backupEndpoint` | `BackupEndpoint` | No | The HTTP endpoint for the backup admin API. Required with `grpc`. |
| `backupTimeoutSeconds` | `BackupTimeout` | No | The backup request timeout in seconds. Default `300`. |
| `allowInsecureCredentials` | `AllowInsecureCredentials` | No | Waives the refusal to send credentials to a remote plaintext endpoint. |
| `routingMode` | `RoutingMode` | No | `auto` (the default), `learned`, or `off`. |
| `routingNodes` | `RoutingNodes` | No | The trust map from node identities to endpoints. |
| `routingMaxHintAgeMs` | `RoutingMaxHintAge` | No | The ceiling on how long a learned route is reused. Default `5000`. |
| `defaultTransactionOptions` | `IsolationLevel`, `TransactionMode`, `Locking` | No | Concurrency defaults for every transaction and autocommit statement. |
| `int64` | `Int64` | No | `auto` (the default), `number`, or `bigint`. See [Types](#types). |

### How a connection string is parsed

Keys are matched without regard to case and are trimmed, so `password=`, `Password=` and
` Password ` all reach the same entry. A key that appears twice is an error rather than a silent
first-wins: the two spellings usually disagree, and the one that lost would disappear without a
diagnostic.

An unquoted value is trimmed and ends at the next `;`. Wrap a value in single or double quotes to
keep a semicolon or surrounding spaces in it, and double the quote character to include one:

```ts
const client = CamusClient.fromConnectionString(
  "Endpoint=https://db.example:5095;Database=test;User=app;Password='pa;ss''word'",
);
// The password is: pa;ss'word
```

### Logging a configuration

`client.toString()` masks every secret. So does `redactConnectionString`, which is a standalone
function for a caller that holds only the string:

```ts
import { redactConnectionString } from 'camusdb';

redactConnectionString('Endpoint=https://db:5095;Database=test;User=app;Password=secret');
// 'Endpoint=https://db:5095;Database=test;User=app;Password=***'
```

Never log a raw connection string. `Password`, `Pwd` and `AccessToken` are masked; everything else
is left as written, so the result still identifies the connection.

---

## Queries

### `query`

Runs a `SELECT` and reads every row.

```ts
const result = await client.query<Robot>('SELECT id, name FROM robots WHERE year > @year', {
  year: 1970,
});

result.rows;     // Robot[]
result.rowCount; // number
result.columns;  // [{ name: 'id', type: 1, typeName: 'Id' }, …]
```

The type argument states what you expect. Nothing on this side can check it against the server's
schema, so it is documentation and editor support, not validation. The driver maps each column to
the JavaScript value its **declared** type calls for.

`columns` is reported even for a result with no rows, because the server sends an authoritative
schema separately from the rows.

### `queryOne` and `scalar`

```ts
const robot = await client.queryOne<Robot>('SELECT * FROM robots WHERE id = @id', { id });
// Robot | undefined

const total = await client.scalar<number>('SELECT COUNT(*) FROM robots');
// number | undefined
```

### Duplicate column names

A join can project the same column name twice. The leftmost column keeps the name, and the ones
after it take `name_2`, `name_3`, and so on. No column is dropped.

---

## Parameters

Bind values as an object. A leading `@` is optional, so `{ year: 1974 }` and `{ '@year': 1974 }`
are the same parameter.

```ts
await client.query('SELECT * FROM robots WHERE year = @year AND name = @name', {
  year: 1974,
  name: 'r1',
});
```

Never build a statement by joining strings. A bound value never becomes SQL text, so it cannot
change what the statement means.

### What the driver infers

| JavaScript value | Column type |
| --- | --- |
| `null`, `undefined` | `Null` |
| `boolean` | `Bool` |
| `number` that is an integer | `Integer64` |
| `number` that is not | `Float64` |
| `bigint` | `Integer64` |
| `string` | `String` |
| `Date` | `DateTime` |
| `Uint8Array`, `Buffer`, `ArrayBuffer` | `Bytes` |
| `Float32Array` | `Bytes`, packed as a vector |
| `CamusObjectId` | `Id` |
| an array | `Array`, with the element type read from the first element that is not null |

A UUID-shaped string is **not** read as a `uuid`. A 36-character string that happens to look like
one would otherwise change type silently.

### Stating a type

Use a `camus.*` helper when inference cannot reach the type you need.

```ts
import { camus, ColumnType } from 'camusdb';

await client.query('SELECT * FROM robots WHERE key = @key AND made = @made AND tags = @tags', {
  key: camus.uuid('550e8400-e29b-41d4-a716-446655440000'),
  made: camus.date(new Date('2024-03-15T00:00:00Z')),
  tags: camus.array([], ColumnType.String),
});
```

| Helper | Column type |
| --- | --- |
| `camus.id(value)` | `Id` |
| `camus.uuid(value)` | `Uuid` |
| `camus.int64(value)` | `Integer64` |
| `camus.float64(value)` | `Float64` |
| `camus.float32(value)` | `Float32` |
| `camus.bool(value)` | `Bool` |
| `camus.string(value)` | `String` |
| `camus.bytes(value)` | `Bytes` |
| `camus.vector(values)` | `Bytes`, packed as float32 elements |
| `camus.date(value)` | `Date`, truncated to UTC midnight |
| `camus.dateTime(value)` | `DateTime` |
| `camus.array(items, elementType)` | `Array` with a stated element type |
| `camus.null()` | `Null` |
| `camus.raw(columnValue)` | Whatever the value holds |

An empty array needs `camus.array`: there is no element to read a type from.

---

## Types

### How a column reaches you

| Column type | JavaScript value |
| --- | --- |
| `Null` | `null` |
| `Id`, `String` | `string` |
| `Integer64` | `number` or `bigint` — see below |
| `Float64`, `Float32` | `number` |
| `Bool` | `boolean` |
| `Bytes` | `Uint8Array` |
| `Date`, `DateTime` | `Date`, in UTC |
| `Uuid` | `string`, canonical and lowercase |
| `Array` | an array of the values above |

### 64-bit integers

CamusDB is a 64-bit database, and a JavaScript number stops being able to name every integer above
2^53. The driver therefore keeps such a value exact — it never passes through a number on its way
in or out, in either transport.

`int64` chooses how the value reaches you:

- **`auto`** (the default) — a `number` inside the safe range, a `bigint` outside it. Every value
  round-trips exactly, and ordinary counters stay numbers.
- **`number`** — always a `number`. A value above 2^53 loses precision. Choose it only when the
  schema cannot hold one.
- **`bigint`** — always a `bigint`. Choose it when one uniform type matters more than convenience.

Set it for the whole client, or for one statement:

```ts
const client = new CamusClient({ endpoint, database, int64: 'bigint' });

await client.query('SELECT n FROM counters', undefined, { int64: 'number' });
```

### Dates

A `Date` or `DateTime` column stores .NET ticks: 100-nanosecond units since 0001-01-01 UTC. A
JavaScript `Date` holds whole milliseconds, so reading one truncates sub-millisecond precision.
The loss is one-way and unavoidable. Convert the raw value yourself when you need the exact stored
instant:

```ts
import { ticksToDate, dateToTicks } from 'camusdb';
```

### Vectors

An embedding is a `bytes` column holding tightly packed little-endian float32 elements. There is no
separate vector column type.

```ts
import { CamusVector, camus } from 'camusdb';

await client.execute('INSERT INTO docs (id, embedding) VALUES (GEN_ID(), @embedding)', {
  embedding: camus.vector([0.1, 0.2, 0.3]),
});

const row = await client.queryOne<{ embedding: Uint8Array }>('SELECT embedding FROM docs LIMIT 1');
const vector = CamusVector.toFloats(row!.embedding); // Float32Array
```

A `Float32Array` bound directly is packed the same way.

### ObjectIds

```ts
import { CamusObjectId } from 'camusdb';

const id = CamusObjectId.generateAsString(); // 24 lowercase hexadecimal characters
```

The layout mirrors the server's own generator, so an id minted here is indistinguishable from one
the server mints.

---

## Writes

```ts
const { affectedRows } = await client.execute('DELETE FROM robots WHERE year < @year', {
  year: 1970,
});
```

`execute` also accepts a schema statement and sends it to the DDL route, where it reports zero
rows. Call `executeDdl` directly when you want that explicitly.

### The typed row insert

The server has a row-level insert that names a table and a column-to-value map rather than SQL
text. Use it to avoid composing statement text on a hot write path. It performs exactly what
`INSERT INTO` performs, and takes the same authorization and error handling.

```ts
await client.insert('robots', {
  id: CamusObjectId.generateAsString(),
  name: 'r1',
  year: 1974,
});
```

Column names carry no `@` here, because they bind to columns rather than to placeholders.

### `TRUNCATE`

`TRUNCATE` commits a replicated schema entry that a rollback cannot undo, so the server refuses it
inside an explicit transaction. The driver refuses it before the round trip, with `CADB0538`.

---

## Streaming

`queryStream` pulls rows off the network as you advance, so a large result never fully materializes
on this side.

```ts
await using stream = await client.queryStream<Robot>('SELECT * FROM robots');

console.log(stream.columns); // known before the first row

for await (const robot of stream) {
  process(robot);
}
```

The iteration owns the underlying response and releases it when it ends — whether it ran to the
last row, was left with `break`, or was ended by a throw. A stream that is never iterated must be
released with `await using`, or with `stream.close()`.

Two limits are worth knowing:

- **It is incremental over REST only.** The gRPC data plane multiplexes results over shared streams
  that decode a whole result before returning, so gRPC buffers and replays. Your code is the same;
  the memory saving is not there.
- **It gives up the transparent retry of a lost conflict.** Rows can reach you before the
  statement's own short transaction commits, so a conflict that surfaces late is raised from the
  iteration rather than retried. Use `query`, or drive an explicit transaction and retry it
  yourself, when you need that.

---

## Transactions

### `transaction`

The usual form. It commits when the work returns and rolls back when the work throws.

```ts
await client.transaction(async (txn) => {
  await client.execute('UPDATE accounts SET balance = balance - @amount WHERE id = @id',
    { amount, id: from }, { transaction: txn });

  await client.execute('UPDATE accounts SET balance = balance + @amount WHERE id = @id',
    { amount, id: to }, { transaction: txn });
});
```

A serializable conflict is retried: the whole function runs again on a fresh transaction, with an
exponential back-off. **So the function must be safe to run more than once.** It must not send an
email, charge a card, or change state outside the database on a path that could repeat.

### `beginTransaction`

Use it when the unit of work does not fit in one function.

```ts
await using txn = await client.beginTransaction();

await client.execute('UPDATE robots SET year = @year WHERE id = @id',
  { year: 1984, id }, { transaction: txn });

await txn.commit();
```

With `await using`, a transaction left without a commit is rolled back as the block unwinds.

### Concurrency options

```ts
import { CamusIsolationLevel, CamusLocking, CamusTransactionMode } from 'camusdb';

await client.transaction(work, {
  transactionOptions: {
    isolationLevel: CamusIsolationLevel.Serializable,
    mode: CamusTransactionMode.ReadOnly,
    locking: CamusLocking.Optimistic,
  },
});
```

- **`isolationLevel`** — `ReadCommitted` or `Serializable`.
- **`mode`** — `ReadWrite` or `ReadOnly`. `Serializable` plus `ReadOnly` is a lock-free consistent
  snapshot, pinned to the instant it began.
- **`locking`** — `Pessimistic` (the default) takes locks up front. `Optimistic` stages the writes
  and detects a conflict only at commit; a losing transaction fails its commit and must be retried.
  It does not protect against phantoms.

Every knob is optional. A knob left unset falls back to the client's `defaultTransactionOptions`,
then to the connection-string defaults, then to the server default.

Prebuilt sets are exported: `OPTIMISTIC_TRANSACTION_OPTIONS` and `SNAPSHOT_TRANSACTION_OPTIONS`.

### An unresolved commit

A commit can come back saying its outcome is not known yet (`CADB0509`). The transaction is not
dead, so the driver re-issues the **same** commit on the **same** handle, backing off up to ten
times. It never replays the work from the start, because that could apply an already-durable commit
a second time. This is handled inside the driver; you do not write it.

---

## Retries

`isRetryable` is the driver's own classification, and `withRetry` is the loop it uses:

```ts
import { isRetryable, withRetry } from 'camusdb';

await withRetry(async () => {
  await client.execute('UPDATE counters SET n = n + 1 WHERE id = @id', { id });
}, { maxAttempts: 5 });
```

Use it around a unit of work that is safe to run twice. `client.transaction` already applies it.

`CADB0509` is deliberately **not** retryable here: replaying that work could double-apply a commit.

---

## Prepared statements

A prepared statement costs one extra round trip to register, and saves the SQL text and the
parameter names on every execution after it. The driver decides on its own:

- A statement is registered after `autoPrepareMinUsages` executions (default 2).
- The `maxAutoPrepare` most recently used registrations are kept (default 128).
- An evicted registration is released on the server.

You can skip the warm-up for a statement you already know is hot:

```ts
await client.prepare('SELECT * FROM robots WHERE year = @year');

client.isPrepared('SELECT * FROM robots WHERE year = @year'); // true
client.preparedStatementCount;                                // 1
```

Preparing is an optimization and never the reason a working statement fails. A registration that is
refused — schema statements, a full server-side cap, a server with no support at all — leaves the
statement running inline, and `prepare` reports no error for it.

Set `maxAutoPrepare: 0` to turn automatic preparation off and keep only explicit `prepare` calls.

---

## Authentication

CamusDB authentication is **off by default**. A configuration with no credentials sends no
`Authorization` header at all.

Against a server started with `CAMUSDB_AUTH_ENABLED=true`, add credentials:

```ts
const client = new CamusClient({
  endpoint: 'https://db.example:5095',
  database: 'test',
  user: 'app',
  password: 'app-secret',
});

// Nothing else changes. The first statement authenticates on its own.
```

### Logging in at run time

Prefer this when the password comes from a secret manager rather than from configuration:

```ts
await client.login('app', await secrets.get('camus-password'));

client.accessToken; // the minted token
await client.logout();
```

`logout` revokes the token and keeps the credentials, so a later statement authenticates again. It
ends a session; it does not switch authentication off.

### Using a token obtained elsewhere

```ts
const client = new CamusClient({ endpoint, database, accessToken: token });
```

Such a token is used as written and is never renewed — the driver has no password to mint a
replacement with — so a rejection reaches you rather than being retried.

### How the token is managed

- **One login, not many.** A token is shared by every client presenting the same identity to the
  same deployment. Password verification is expensive on the server and is rate limited per
  account, so a login stampede is exactly what must be avoided.
- **Concurrent callers share one login.** Callers that find no usable token await the same login.
- **Renewal is proactive.** The server reports how long a token is good for, and the driver renews
  at 80% of that. Against a server that reports none it falls back to `tokenLifetimeSeconds`.
- **A rejection is the backstop.** A `CADB0516` from a real request discards the token and replays
  the statement once with a fresh one. That covers what a clock cannot predict: a rotated password,
  a dropped user, a logout from elsewhere, a server restart.
- **A privilege refusal is never retried.** Authenticating again as the same user cannot grant a
  privilege, so `CADB0517` reaches you at once.

---

## Transport: REST and gRPC

```ts
const client = new CamusClient({
  endpoint: 'http://localhost:5096',   // the gRPC port
  database: 'test',
  protocol: 'grpc',
  backupEndpoint: 'http://localhost:8082',
});
```

Both transports carry the same features, and the client API does not change between them.

| | REST | gRPC |
| --- | --- | --- |
| Calls per statement | One HTTP request | Multiplexed over shared streams |
| Row-incremental streaming | Yes | No — it buffers and replays |
| Prepared statements | Node-local handles | Stream-scoped handles |
| Backup admin API | Yes | No — set `backupEndpoint` |
| Extra packages | None | `@grpc/grpc-js`, `@grpc/proto-loader` |

The gRPC transport does not make one call per statement. Statements ride a small pool of long-lived
`BatchExecute` duplex streams per endpoint, so many statements — and many concurrent transactions —
share one HTTP/2 connection. Statements that share a transaction go to one stream, in arrival
order, so the server sees them in the order you wrote them.

It also carries the session's causal token. Every reply reports a hybrid-logical-clock instant, the
transport keeps the greatest one it has seen, and every request carries it back. That is what makes
a read see this session's own earlier writes even when it lands on a different node.

Tune the stream pool with `channelPoolSize`. It is **not** a cap on in-flight transactions — many
transactions hash onto the same streams and interleave — so the default of 2 suits most workloads.
Raise it when many long-running queries per endpoint would otherwise queue behind each other.

The `.proto` file is the server's own, so the two surfaces cannot drift apart.

---

## Endpoint pools

Give several endpoints to rotate through them:

```ts
const client = new CamusClient({
  endpoint: ['http://a:8082', 'http://b:8082', 'http://c:8082'],
  database: 'test',
});
```

When a request fails because an endpoint is unreachable, that endpoint is set aside for 30 seconds
and skipped meanwhile. A node that is still down is set aside again by the next request that draws
it, at a cost of one failed request per period.

When every endpoint is set aside, the one closest to leaving is used anyway. The deployment is
evidently down, and letting the request fail against the real node reports why, where a synthetic
"no endpoints" would replace the server's diagnosis with the driver's bookkeeping.

---

## Learned routing

A CamusDB server can attach advisory routing metadata to a successful response: which node leads
the data behind that statement. With routing on, the driver learns from it and sends that
statement's future executions straight to that node, skipping a forwarding hop.

It is a latency optimization only. It changes no result, no isolation, and no commit behaviour, and
the server still executes correctly wherever a request lands.

```ts
const client = new CamusClient({
  endpoint: ['http://a:8082', 'http://b:8082', 'http://c:8082'],
  database: 'test',
  routingMode: 'learned',
  routingNodes: {
    'camus-a:7070': 'http://a:8082',
    'camus-b:7070': 'http://b:8082',
    'camus-c:7070': 'http://c:8082',
  },
});
```

- **The trust map is the routing authority.** The server advertises an opaque node identity. It
  becomes a destination only through `routingNodes`, and only when the mapped address is also a
  member of the endpoint pool. The driver never dials an address the server supplied, so a response
  can never steer traffic — or credentials — anywhere the operator did not list.
- **Modes.** `auto` (the default) negotiates only when the map names at least two distinct
  endpoints, because one destination is not a routing decision and a single load-balancer URL is
  not a set of routable nodes. So a configuration without `routingNodes` sends requests identical
  to a driver that has no routing at all. `learned` negotiates with at least one identity mapped.
  `off` never negotiates, and is the explicit switch.
- **What is learned.** Advice is cached per database, exact SQL text, and statement kind, with a
  reuse period of the smaller of the server's own value and `routingMaxHintAgeMs`, measured on a
  monotonic clock. A hint never generalizes from one SQL string to another, so parameterized and
  prepared workloads are where it pays. A late reply cannot overwrite a newer route, and the cache
  is bounded at 4096 entries and 4 MiB.
- **Precedence.** An explicit transaction stays pinned to the endpoint it started on: advice may
  inform the next transaction, never relocate a live one. A route pointing at an endpoint that was
  set aside falls back to rotation. Routing adds no retry of any kind.

### Where a routed transaction starts

With routing on, `BEGIN` is deferred. `beginTransaction` sends nothing, and the transaction's first
statement starts it on that statement's learned endpoint — so a transaction whose first statement
touches a table runs where that table's leader is. Every later statement and the finalize stay
there.

Two consequences are visible, and only in routed mode:

- `txnIdPT`, `txnIdCounter` and `transactionId` read as zero until the first statement.
  `isStarted` says which state the transaction is in.
- A failure to begin surfaces from that first statement, with the exception `beginTransaction`
  would have raised.

A transaction that runs no statement is started by its own commit or rollback, so the server sees
the same pair it always did.

To choose the endpoint from a later, hotter statement instead, name it as an affinity. `BEGIN` is
then sent at once, to that statement's learned endpoint:

```ts
const txn = await client.beginTransaction({ affinity: 'SELECT * FROM robots WHERE id = @id' });
```

`client.learnedRouteCount` reports how many destinations are currently held, and
`result.routingAdvice` reports the advice one statement received. Both are diagnostic: the driver
has already applied the advice.

---

## Databases and branches

```ts
await client.createDatabase('analytics', { ifNotExists: true });
await client.dropDatabase('analytics');

// A copy-on-write branch.
await client.createBranchDatabase('feature-x', 'production');

await client.showBranches('production');  // every transitive descendant
await client.showAncestors('feature-x');  // the chain up to the root

client.changeDatabase('analytics');       // sends nothing
```

Concurrent creations can collide transiently while the server allocates the shared database id
sequence, which is what several environments provisioning in parallel produce. The driver retries
that. With `ifNotExists`, a creation that loses a registration race is treated as success: you
asked for the database to exist, and it does.

---

## The query result cache

A `SELECT` can carry a hint asking the server to cache its result. Put the hint **immediately after
the table reference**, and after its alias when it has one. It applies to the whole statement, not
only to the table it is attached to, and only one hint per statement is allowed.

```ts
import { cacheHint } from 'camusdb';

const hint = cacheHint('recent_orders', { ttlMs: 30_000 });

const result = await client.query(`SELECT id, total FROM orders ${hint} WHERE status = @status`, {
  status: 1,
});

result.cacheMetadata?.status;   // 'hit' | 'miss' | 'bypass' | 'stale-revalidated' | …
result.cacheMetadata?.isHit;
result.cacheMetadata?.ageMs;
result.cacheMetadata?.cachedAtHlc;
```

`cacheMetadata` is `undefined` when the statement carried no hint. A hinted statement that skipped
the cache reports `bypass` with a `bypassReason`.

Options go inside the braces. `cacheHint` writes them for you:

```ts
cacheHint('hot_orders');                                // {cache=hot_orders}
cacheHint('hot_orders', { ttlMs: 30_000 });             // {cache=hot_orders, ttl=30000}
cacheHint('hot_orders', { ttlMs: 5_000, strict: true }); // {cache=hot_orders, ttl=5000, strict}
```

`strict` makes the server validate each hit against live storage, for a reader that must not see
staleness between nodes.

Drop cached results:

```ts
await client.evictCache('recent_orders');
await client.evictAllCache();   // this database only
```

**A family name in a hint is a bare identifier**: a letter or an underscore, then letters, digits,
or underscores. The hint writes it unquoted, so a hyphen, a dot or a colon is a parse error on the
server — `cacheHint` refuses those, where the name was written, rather than send a statement that
fails. `evictCache` accepts more, because `EVICT CACHE` takes a quoted string, so a family minted
elsewhere can still be evicted.

---

## Backups

The node's online backup administration API. It is server-level and node-wide, not scoped to this
client's database — every database on the server shares one storage node, so a backup captures all
of them. It needs a superuser token when authentication is on.

```ts
const full = await client.backups.takeFullBackup();
const incremental = await client.backups.takeIncrementalBackup(full.backupId);
const coordinated = await client.backups.takeCoordinatedBackup();

const catalog = await client.backups.listBackups();
const chain = await client.backups.getChain(incremental.backupId);

const preview = await client.backups.previewGarbageCollection();
const run = await client.backups.collectGarbage();
```

Check `chain` before you rely on a leaf backup: it lists every link a restore needs, and each entry
reports `isInvalid` and `invalidReason`. `wasSubstituted` says the server took a different kind of
backup than the one requested, and `substitutionReason` says why.

Restore is an offline operator procedure and is deliberately not reachable here.

The backup routes are REST and JSON only. A gRPC client must set `backupEndpoint` to the server's
HTTP endpoint; the driver refuses to guess rather than send HTTP at a gRPC port.

---

## Errors

Every database-level failure is a `CamusError` carrying the server's `CADBxxxx` code.

```ts
import { CamusError, CamusErrorCode } from 'camusdb';

try {
  await client.execute('INSERT INTO robots (id) VALUES (@id)', { id });
} catch (error) {
  if (CamusError.is(error) && error.code === CamusErrorCode.DatabaseAlreadyExists) {
    // …
  }

  throw error;
}
```

Switch on `code`. The message is human text and is not a stable contract. `CADB0000` is the generic
code the driver uses when the far end supplied none.

The codes the driver itself reacts to are named in `CamusErrorCode`; every other code reaches you
unchanged.

Every message the far end supplied is cleaned before it becomes an error: credential-shaped runs
are masked, control characters are folded to spaces, and the length is bounded. Applications log
these messages verbatim, and none of that text is the driver's.

---

## Cancellation and deadlines

Every method that reaches the server accepts an `AbortSignal`, and most accept a per-statement
timeout.

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

await client.query('SELECT * FROM robots', undefined, {
  signal: controller.signal,
  timeoutSeconds: 30,
});
```

A cancellation you asked for is re-thrown as it is. It is not a database failure and the node is
not marked unreachable.

---

## What a client shares

A client holds no socket of its own. Four kinds of state are shared process-wide, keyed by what
they actually depend on:

| State | Shared by |
| --- | --- |
| The endpoint rotation and its health | The endpoint list |
| The bearer token | The identity and the deployment |
| The transport, with its prepared-statement registrations | The identity, the deployment, and the stream tuning |
| The learned routes | The deployment and the routing configuration |

Each is a property of a deployment, not of one client object. So building a client per request
costs almost nothing and still reuses the connections, the token, and the prepared statements a
long-lived one would. An application that built one per request would otherwise start every one of
them cold — a multi-endpoint deployment would send all its traffic to one node, and every request
would perform its own login against a per-account rate limit.

`client.close()` releases what a client owns on its own, which today is nothing. To release the
shared gRPC channels when a process is shutting down:

```ts
import { CamusTransportPool } from 'camusdb';

await CamusTransportPool.closeAll();
```

---

## Security notes

- **Credentials are refused over a remote plaintext endpoint.** A password is posted to `/login`
  and a bearer token rides every later request; on an `http://` endpoint both cross the network in
  the clear. The server's own check fires only after the password has already been sent, so the
  driver refuses first, before anything leaves the process. Loopback is allowed, because that
  traffic never reaches a network. Set `allowInsecureCredentials` for a deployment reached over a
  private link that terminates TLS elsewhere.
- **A response can never steer traffic.** Routing advice names an opaque node identity, and it
  becomes a destination only through the operator's own `routingNodes` map, and only when the
  mapped address is already in the endpoint pool.
- **The driver never follows a redirect.** A redirected statement would leave the configured
  endpoint and take its bearer token with it.
- **Error text is sanitized.** See [Errors](#errors).
- **A token key is hashed and salted.** The map key that shares a token holds no plaintext
  password, and cannot be tested against a guessed one outside the process.

---

## Development

```shell
npm install
npm run build         # compile to dist/
npm test              # the offline suite
npm run test:coverage
npm run test:live     # the suite that needs a running server
npm run lint
npm run typecheck
npm run format
```

The offline suite needs no CamusDB installation. It runs against a real HTTP server on a loopback
port rather than a stubbed `fetch`, because the REST path depends on streams, deadlines, and abort
signals that a stub does not reproduce.

The live suite runs the whole surface against a real server, over both transports. It reads its
endpoints from the environment:

| Variable | Default |
| --- | --- |
| `CAMUS_LIVE_ENDPOINT` | `http://localhost:5095` |
| `CAMUS_LIVE_GRPC_ENDPOINT` | `http://localhost:5096` |
| `CAMUS_LIVE_DATABASE` | `camusdb_ts_live` |
| `CAMUS_LIVE_USER`, `CAMUS_LIVE_PASSWORD` | none, for a server with authentication off |

Each case creates its own table and drops it afterwards, so a run leaves nothing behind and two
runs never collide.

---

## License

MIT. See [LICENSE](LICENSE).
