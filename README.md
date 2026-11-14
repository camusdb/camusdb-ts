# CamusDB Connector for Node.js

The TypeScript client for [CamusDB](https://github.com/camusdb/camusdb), a distributed SQL database.

## Install

Requires Node.js 20.19 or later, or 22.12 or later. The package is ECMAScript modules with TypeScript types.

```shell
npm install camusdb
```

Optional packages:

| Package | Install it to |
| --- | --- |
| `@grpc/grpc-js`, `@grpc/proto-loader` | Use the gRPC transport. See [Transport](https://github.com/camusdb/camusdb-ts/blob/main/docs/transport.md). |
| `@opentelemetry/api` | Collect traces and metrics. See [OpenTelemetry](https://github.com/camusdb/camusdb-ts/blob/main/docs/opentelemetry.md). |

## Quick start

1. Start a CamusDB server. This example uses the REST port `8082` on your computer.
2. Run this code:

```ts
import { CamusClient } from 'camusdb';

const client = new CamusClient({ endpoint: 'http://localhost:8082', database: 'test' });

await client.createDatabase('test', { ifNotExists: true }); // a database must exist before you use it

await client.executeDdl('CREATE TABLE robots (id ID PRIMARY KEY, name STRING NOT NULL, year INT64 NOT NULL)');

await client.execute('INSERT INTO robots (id, name, year) VALUES (GEN_ID(), @name, @year)', { name: 'r1', year: 1974 });

const { rows } = await client.query<{ id: string; name: string; year: number }>(
  'SELECT id, name, year FROM robots WHERE year = @year',
  { year: 1974 },
);
```

`@name` and `@year` are parameters. The driver sends their values apart from the SQL text. See [Parameters](https://github.com/camusdb/camusdb-ts/blob/main/docs/parameters.md).

## Documentation

The links are absolute because npm shows this file as the package page.

| Document | Contents |
| --- | --- |
| [Glossary](https://github.com/camusdb/camusdb-ts/blob/main/docs/glossary.md) | The terms that the documents use |
| [Connection](https://github.com/camusdb/camusdb-ts/blob/main/docs/connection.md) | Options, connection strings, endpoint pools, shared state |
| [Authentication](https://github.com/camusdb/camusdb-ts/blob/main/docs/authentication.md) | Users, passwords, tokens |
| [Transport](https://github.com/camusdb/camusdb-ts/blob/main/docs/transport.md) | REST or gRPC |
| [Learned routing](https://github.com/camusdb/camusdb-ts/blob/main/docs/learned-routing.md) | Send statements to the node that leads the data |
| [Parameters](https://github.com/camusdb/camusdb-ts/blob/main/docs/parameters.md) | Bind values, and state their types |
| [Data types](https://github.com/camusdb/camusdb-ts/blob/main/docs/data-types.md) | Column types, 64-bit integers, NUMERIC, INTERVAL, JSONB, dates, vectors |
| [Large values](https://github.com/camusdb/camusdb-ts/blob/main/docs/large-values.md) | Compression and storage outside the row |
| [Reading data](https://github.com/camusdb/camusdb-ts/blob/main/docs/reading-data.md) | `query`, streaming, the query result cache |
| [Writing data](https://github.com/camusdb/camusdb-ts/blob/main/docs/writing-data.md) | `execute`, `insert`, `RETURNING`, `ON CONFLICT`, `UPSERT` |
| [Databases and DDL](https://github.com/camusdb/camusdb-ts/blob/main/docs/databases-and-ddl.md) | Databases, branches, schema statements, `TRUNCATE`, sequences |
| [Transactions](https://github.com/camusdb/camusdb-ts/blob/main/docs/transactions.md) | Transactions, isolation, retries, pipelines |
| [Prepared statements](https://github.com/camusdb/camusdb-ts/blob/main/docs/prepared-statements.md) | Automatic and explicit preparation |
| [C# extensions](https://github.com/camusdb/camusdb-ts/blob/main/docs/csharp-extensions.md) | Procedures, triggers, extension functions, inline functions |
| [Backups](https://github.com/camusdb/camusdb-ts/blob/main/docs/backups.md) | Online backups |
| [Node stats](https://github.com/camusdb/camusdb-ts/blob/main/docs/node-stats.md) | Disk, CPU, and memory of a node |
| [Errors and cancellation](https://github.com/camusdb/camusdb-ts/blob/main/docs/errors.md) | `CamusError`, error codes, `AbortSignal`, timeouts |
| [OpenTelemetry](https://github.com/camusdb/camusdb-ts/blob/main/docs/opentelemetry.md) | Spans and metrics |
| [Security](https://github.com/camusdb/camusdb-ts/blob/main/docs/security.md) | What the driver does to keep credentials safe |
| [Development](https://github.com/camusdb/camusdb-ts/blob/main/docs/development.md) | Build and test the driver |

## License

MIT. See [LICENSE](LICENSE).
