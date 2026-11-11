# Prepared statements

A prepared statement costs one more round trip to register. After that, each run sends a handle and the values, not the SQL text.

## Automatic preparation

The driver prepares statements for you:

- It registers a statement after `autoPrepareMinUsages` runs (default 2).
- It keeps the `maxAutoPrepare` most recently used statements (default 128).
- It releases a statement on the server when it removes it from the list.
- `maxAutoPrepare: 0` turns automatic preparation off.

## Explicit preparation

Prepare a statement that you know you will run often:

```ts
await client.prepare('SELECT * FROM robots WHERE year = @year');

client.isPrepared('SELECT * FROM robots WHERE year = @year'); // true
client.preparedStatementCount;                                // 1
```

## Rules

- Only `SELECT`, `INSERT`, `UPSERT`, `UPDATE`, `DELETE`, `SHOW`, and a query that starts with `(` can be prepared.
- `prepare` on another statement does nothing. The statement runs as SQL text.
- When the server refuses a registration, the statement runs as SQL text. `prepare` reports no error.
- `CALL` is never prepared.
- On gRPC, `queryStream` always sends SQL text.
