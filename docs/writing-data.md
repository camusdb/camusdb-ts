# Writing data

`INSERT`, `UPDATE`, `DELETE`, `RETURNING`, and `UPSERT`.

## `execute`

`execute` runs a write and gives the number of rows that it changed:

```ts
const { affectedRows } = await client.execute('DELETE FROM robots WHERE year < @year', { year: 1970 });
```

`execute` also accepts DDL. See [Databases and DDL](databases-and-ddl.md).

## `insert`

`insert` adds one row from a table name and an object of column values. It sends no SQL text. It does the same as `INSERT INTO`, with the same privileges and errors.

```ts
await client.insert('robots', { id: CamusObjectId.generateAsString(), name: 'r1', year: 1974 });
```

The keys are column names, so they have no `@`.

## `RETURNING`

An `INSERT`, `UPDATE`, or `DELETE` with `RETURNING` sends back the stored values of the rows that it wrote. These values include defaults and sequence values. Read them with `query`, `queryOne`, or `scalar`:

```ts
const result = await client.query<{ id: string; name: string }>(
  'INSERT INTO robots (id, name) VALUES (GEN_ID(), @name) RETURNING id, name',
  { name: 'R2-D2' },
);

result.rows;         // one row for each inserted row, in insert order
result.affectedRows; // the number of inserted rows

const updated = await client.query('UPDATE robots SET year = year + 1 WHERE year < @year RETURNING id, year', {
  year: 1980,
});
const deleted = await client.query('DELETE FROM robots WHERE year > 2000 LIMIT 10 RETURNING id');
```

- `UPDATE` returns the new row. `DELETE` returns the deleted row.
- `RETURNING` comes after `LIMIT`.
- `execute` returns the count only. The server sends no rows.
- `RETURNING` accepts `*`, columns, expressions, aliases, and parameters. It does not accept aggregates, subqueries, or sequence functions.
- `RETURNING` needs the `SELECT` privilege on the table too.
- `INSERT` returns rows in insert order. `UPDATE` and `DELETE` return rows in no fixed order.
- An `UPDATE` cannot return the old values.
- `RETURNING` is a reserved word. Put a column or a table with that name in backticks.
- The `transactionOptions` of `query`, `queryOne`, `scalar`, and `queryStream` apply to a write with `RETURNING`.

**Large results.** `query` gets all rows in one reply. On gRPC, a reply larger than 4 MiB fails with `CADB0550` before the commit, so nothing is stored. For many rows, use `queryStream`. It sends no row before the commit, and it gives no row count.

## `INSERT … ON CONFLICT` and `UPSERT`

When a row has a unique key that is already used, `ON CONFLICT` can skip the row (`DO NOTHING`) or update the stored row (`DO UPDATE`). `UPSERT INTO` updates on the primary key. In `SET`, a bare column is the stored row, and `excluded.c` is the new row.

```ts
const hits = await client.scalar<number>(
  `INSERT INTO counters (k, n) VALUES (@k, 1)
   ON CONFLICT (k) DO UPDATE SET n = counters.n + excluded.n
   RETURNING n`,
  { k: 'hits' },
); // 1 the first time, then 2, 3, …

await client.execute('UPSERT INTO counters (k, n) VALUES (@k, @n)', { k: 'misses', n: 0 });
```

- The row count is the inserted rows plus the updated rows. A skipped row counts 0, and returns no `RETURNING` row.
- `DO UPDATE` and `UPSERT` need the `INSERT` and the `UPDATE` privileges.
- When two transactions write the same new key, one fails with the retryable `CADB0502` or `CADB0504`.
- A duplicate on a different unique index fails with the duplicate-key error. It is not retryable.
- `insert` has no upsert form. Use SQL.
