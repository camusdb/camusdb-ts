# Reading data

Run a `SELECT`, stream a large result, and use the query result cache.

## `query`

`query` runs a statement and reads all rows into memory.

```ts
interface Robot {
  id: string;
  name: string;
}

const result = await client.query<Robot>('SELECT id, name FROM robots WHERE year > @year', { year: 1970 });

result.rows;     // Robot[]
result.rowCount; // number
result.columns;  // [{ name: 'id', type: 1, typeName: 'Id' }, …]
```

- The type argument (`Robot`) is not checked against the server. It only gives types to your code.
- `columns` is set also when the result has no rows.
- Each value has the JavaScript type of its column type. See [Data types](data-types.md).
- When two columns have the same name, the first keeps it. The next ones get `name_2`, `name_3`, and so on.

## `queryOne` and `scalar`

```ts
const robot = await client.queryOne<Robot>('SELECT * FROM robots WHERE id = @id', { id });
// the first row, or undefined

const total = await client.scalar<number>('SELECT COUNT(*) FROM robots');
// the first column of the first row, or undefined
```

## Stream a large result

`queryStream` reads the rows from the network as you iterate. It does not keep all rows in memory.

```ts
await using stream = await client.queryStream<Robot>('SELECT * FROM robots');

console.log(stream.columns); // known before the first row

for await (const robot of stream) {
  handle(robot);
}
```

- The stream closes when the loop ends, on `break`, or on an error.
- If you do not iterate, close the stream: use `await using`, or call `stream.close()`.
- On both transports the server waits while you do not read.
- On gRPC, `timeoutSeconds` applies to each wait for the next row, not to the whole read.
- On gRPC, the statement always runs as SQL text, also when it is prepared.
- An autocommit statement can send rows before its commit. So a serializable conflict can come as an error in the loop. The driver does not retry it. Use `client.transaction` or `withRetry` when you need a retry. See [Transactions](transactions.md).
- A write with `RETURNING` sends no row before its commit. See [Writing data](writing-data.md#returning).

## Query result cache

The server can keep the result of a `SELECT` for a time. Add a cache hint immediately after the table name, or after its alias:

```ts
import { cacheHint } from 'camusdb';

const hint = cacheHint('recent_orders', { ttlMs: 30_000 });

const result = await client.query(`SELECT id, total FROM orders ${hint} WHERE status = @status`, { status: 1 });

result.cacheMetadata?.status; // 'hit' | 'miss' | 'bypass' | 'stale-revalidated' | …
result.cacheMetadata?.isHit;
result.cacheMetadata?.ageMs;
```

- One hint applies to the whole statement. A statement can have one hint only.
- `cacheMetadata` is `undefined` when the statement has no hint.
- A hinted statement that did not use the cache reports `bypass`, with a `bypassReason`.
- The family name (`recent_orders`) must be a letter or `_`, then letters, digits, or `_`. `cacheHint` refuses other names.

`cacheHint` writes the options:

```ts
cacheHint('hot_orders');                                 // {cache=hot_orders}
cacheHint('hot_orders', { ttlMs: 30_000 });              // {cache=hot_orders, ttl=30000}
cacheHint('hot_orders', { ttlMs: 5_000, strict: true }); // {cache=hot_orders, ttl=5000, strict}
```

With `strict`, the server checks each cache hit against the stored data. Use it when a read must not see old data from another node.

Remove cached results:

```ts
await client.evictCache('recent_orders');
await client.evictAllCache(); // this database only
```
