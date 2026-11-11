# Databases and DDL

Create databases and branches, change the schema, and use sequences.

## Databases and branches

```ts
await client.createDatabase('analytics', { ifNotExists: true });
await client.dropDatabase('analytics');

// A branch is a copy-on-write copy: it shares the data of its parent until you change it.
await client.createBranchDatabase('feature-x', 'production');

await client.showBranches('production'); // all descendants
await client.showAncestors('feature-x'); // the chain up to the root

client.changeDatabase('analytics'); // sends nothing
```

- A database must exist before you use it.
- When many clients create databases at the same time, the server can refuse one for a short time. The driver retries this.
- With `ifNotExists`, a database that another client created at the same time is a success.

## Schema statements (DDL)

The driver sends DDL to the DDL route of the server. `execute` and `executeDdl` both do this, and both report 0 rows.

```ts
await client.executeDdl('CREATE TABLE robots (id ID PRIMARY KEY, name STRING NOT NULL)');
```

The driver reads these first words as DDL:

- `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `TRUNCATE`
- `CREATE INDEX`, `CREATE UNIQUE INDEX`, `DROP INDEX`
- `CREATE VIEW`, `CREATE OR REPLACE VIEW`, `ALTER VIEW`, `DROP VIEW`
- `CREATE MATERIALIZED VIEW`, `ALTER MATERIALIZED VIEW`, `DROP MATERIALIZED VIEW`
- `CREATE SEQUENCE`, `ALTER SEQUENCE`, `DROP SEQUENCE`, `COMMENT ON SEQUENCE`
- `CREATE TRIGGER`, `DROP TRIGGER`
- `CREATE EXTENSION`, `ALTER EXTENSION`, `DROP EXTENSION`
- `CREATE FUNCTION`, `CREATE OR REPLACE FUNCTION`, `ALTER FUNCTION`, `DROP FUNCTION`

`REFRESH MATERIALIZED VIEW` is a write, not DDL.

DDL does not run inside a transaction. A [pipeline](transactions.md#pipelines) refuses it.

## `TRUNCATE`

`TRUNCATE t` removes all rows of a table. A rollback cannot undo it, so the server refuses it in a transaction. The driver refuses it first, with `CADB0538`.

## Sequences

A sequence gives increasing `int64` values. It needs a server from 0.13.2.

- The increment is positive.
- A sequence never starts again from the beginning. The server refuses `CYCLE` with `CADB0533`.
- A value is given only once. A rollback does not return it.

```ts
import { createSequenceStatement, dropSequenceStatement, nextValueExpression } from 'camusdb';

await client.executeDdl(createSequenceStatement('ticket_numbers', { startWith: 1000, ifNotExists: true }));

await client.executeDdl(
  `CREATE TABLE tickets (
     id      OID PRIMARY KEY NOT NULL,
     number  INT64 DEFAULT (${nextValueExpression('ticket_numbers')})
   )`,
);

const next = await client.nextSequenceValue('ticket_numbers'); // a bigint

await client.executeDdl(dropSequenceStatement('ticket_numbers'));
```

- Without `minValue`, the minimum is 1.
- `nextSequenceValue` runs `SELECT nextval('…')`. Give the `transaction` option to run it in a transaction.
- In the same transaction, `SELECT currval('…')` returns the last value again.
- `nextval` in a derived table fails with `CADB0547`.
