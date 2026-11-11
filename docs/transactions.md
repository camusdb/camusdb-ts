# Transactions

Run several statements as one unit, retry conflicts, and send a transaction in fewer round trips.

## `transaction`

`client.transaction` commits when your function returns, and rolls back when it throws. Give the transaction to each statement with the `transaction` option.

```ts
await client.transaction(async (txn) => {
  await client.execute('UPDATE accounts SET balance = balance - @amount WHERE id = @id', { amount, id: from }, { transaction: txn });
  await client.execute('UPDATE accounts SET balance = balance + @amount WHERE id = @id', { amount, id: to }, { transaction: txn });
});
```

On a serializable conflict, the driver runs your whole function again in a new transaction, after a wait that increases each time.

> **Your function can run more than one time.** Do not send an email, charge a card, or change state outside the database in it.

## `beginTransaction`

Use this when the work does not fit in one function:

```ts
await using txn = await client.beginTransaction();

await client.execute('UPDATE robots SET year = @year WHERE id = @id', { year: 1984, id }, { transaction: txn });

await txn.commit();
```

With `await using`, a transaction that you do not commit or roll back is rolled back at the end of the block. So it never keeps locks on the server.

## Concurrency options

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

| Option | Values |
| --- | --- |
| `isolationLevel` | `ReadCommitted`: each statement sees the data committed when it starts. `Serializable`: the transaction runs as if no other transaction ran at the same time. |
| `mode` | `ReadWrite` or `ReadOnly`. `Serializable` with `ReadOnly` is a consistent snapshot that takes no locks. |
| `locking` | `Pessimistic` (default): lock data when you use it. `Optimistic`: lock nothing, and find conflicts at commit. A losing commit fails, and you must retry it. `Optimistic` does not prevent phantoms (rows that another transaction adds during your transaction). |
| `deferBegin` | `true`: send `BEGIN` with the first statement, not from `beginTransaction`. The transaction identity is zero until the first statement. With learned routing on, this is always so. |

An option that you do not set comes from `defaultTransactionOptions`, then from the connection string, then from the server. The driver exports two sets: `OPTIMISTIC_TRANSACTION_OPTIONS` and `SNAPSHOT_TRANSACTION_OPTIONS`.

## Retries

`withRetry` runs a function again while it fails with a retryable error. `isRetryable` tells you if an error is retryable.

```ts
import { isRetryable, withRetry } from 'camusdb';

await withRetry(async () => {
  await client.execute('UPDATE counters SET n = n + 1 WHERE id = @id', { id });
}, { maxAttempts: 5 });
```

- Use it only for work that is safe to run two times.
- `client.transaction` already uses it.
- The driver does not retry an autocommit statement without `withRetry`.
- The retryable codes are `CADB0502`, `CADB0504`, and `CADB0505`.

## Unknown commit result

A commit can fail with `CADB0509`: the server does not know the result yet. The driver sends the same commit again on the same transaction, up to ten times, with a wait between tries. It never runs the work again, because the first commit can be durable. `isRetryable` is `false` for `CADB0509`.

## Pipelines

A transaction that waits for each statement needs one round trip for each statement. A bank transfer needs six: `BEGIN`, two reads, two writes, and `COMMIT`. A pipeline sends the statements that are ready together, in one round trip.

```ts
const txn = await client.beginTransaction({ locking: CamusLocking.Optimistic, deferBegin: true });
const pipeline = txn.pipeline();

// Round trip 1: BEGIN, SELECT a, SELECT b
const readA = pipeline.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = @id', { id: a });
const readB = pipeline.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = @id', { id: b });
await pipeline.send();

const fromBalance = (await readA).rows[0]!.balance;
const toBalance = (await readB).rows[0]!.balance;

// Round trip 2: UPDATE a, UPDATE b, COMMIT. The commit runs only if both updates succeed.
pipeline.execute('UPDATE accounts SET balance = @v WHERE id = @id', { v: fromBalance - amount, id: a });
pipeline.execute('UPDATE accounts SET balance = @v WHERE id = @id', { v: toBalance + amount, id: b });
await pipeline.commit();

console.log(pipeline.exchanges); // 2 round trips over gRPC
```

- **Results.** `query` and `execute` return promises, as the client methods do. `send` and `commit` reject with the first failure. A promise that you do not await never causes an unhandled rejection.
- **Failure.** After a failure, the next statements of the same send fail too, and `commit` does not commit. The server rolled the transaction back. To retry, run the whole transaction again.
- **Commit.** After `pipeline.commit()`, `txn.rollback()` does nothing, and `txn.commit()` throws. Inside `client.transaction`, the driver does not commit a second time.
- **Order.** Statements run in the order you add them. You can send a pipeline more than once, and run other statements between sends. Only one send at a time.
- **Round trips.** `pipeline.exchanges` gives the number of round trips. Over gRPC, with a server that supports frame contract version 2, each send is one round trip. Over REST, with `requestFrames: false`, or with an older server, the driver sends one statement at a time. The results are the same.
- **Routing.** With [learned routing](learned-routing.md) on, the driver learns routes from pipeline replies too.
- **Not allowed.** DDL and `TRUNCATE` throw a `CamusError` when you add them. The pipeline stays usable.
- **`CALL`.** A pipeline accepts `CALL` through `query`, `execute`, and `call`.
