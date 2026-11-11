# OpenTelemetry

The driver reports traces (spans) and metrics through `@opentelemetry/api`. You need no plugin and no driver setting.

## Set up

```shell
npm install @opentelemetry/api @opentelemetry/sdk-node
```

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';

new NodeSDK({ /* exporters */ }).start();
```

- Start the SDK before the first database call.
- The instrumentation scope is `camusdb` (`CAMUS_TELEMETRY_NAME`).
- Without `@opentelemetry/api`, the driver reports nothing.

## Spans

The driver makes one client span for each of these operations:

- A statement: `query` (also `queryOne`, `scalar`, and `nextSequenceValue`), `queryStream`, `execute`, `executeDdl`, `evictCache`, and `evictAllCache`.
- `insert`.
- `BEGIN`, `COMMIT`, and `ROLLBACK`. The retries of an unknown commit (`CADB0509`) are `camusdb.retry` events on one `COMMIT` span.
- A pipeline send, as a `BATCH` span with `db.operation.batch.size` and `camusdb.pipeline.commit`.

The span name is the `db.query.summary`, for example `SELECT orders customers`. When the statement names no table, and for `BEGIN`, `COMMIT`, `ROLLBACK`, and `BATCH`, the name is `{operation} {database}`, for example `SELECT shop`.

| Attribute | Value |
| --- | --- |
| `db.system.name` | `camusdb` |
| `db.namespace` | The database of the client. |
| `db.operation.name` | The first word of the SQL, such as `SELECT` or `INSERT`. Or `BEGIN`, `COMMIT`, `ROLLBACK`, `BATCH`. |
| `db.collection.name` | The table, when the statement names one table only. `insert` always sets it. |
| `db.query.summary` | The operation and the tables, at most 255 characters. Only when the statement names a table. |
| `server.address`, `server.port` | The endpoint that got the operation. |
| `db.query.text` | The SQL text, only when you set `traceQueryText`. |
| `error.type`, `db.response.status_code` | The `CADBxxxx` code of a failure, or the error name. |
| `camusdb.transport` | `rest` or `grpc`. |

The attributes follow the [OpenTelemetry database conventions](https://opentelemetry.io/docs/specs/semconv/database/).

- The driver span is a child of the active span. The HTTP or gRPC spans are children of the driver span. This needs a context manager, which `NodeSDK` registers.
- A `queryStream` span ends at the last row, at a read error, or when the stream closes.

## SQL text

SQL text can contain private data, so the driver records it only when you set `traceQueryText`:

| `traceQueryText` | `db.query.text` |
| --- | --- |
| `false` (default) | Not recorded |
| `'sanitized'` | Each literal value is `?`: strings, numbers, bytes, and dollar-quoted text. Comments are removed. A list of two or more `?` is `?, ...`. |
| `true` | The text as sent |

The driver never records parameter values. `@p0` stays `@p0`.

The driver finds tables with a simple scan, not a full parse. It takes the name after `FROM`, `JOIN`, `INTO`, `UPDATE`, or `TABLE`. A comma join names only its first table. A common table expression counts as a table.

## Metrics

`db.client.operation.duration` is a histogram of the operation time in seconds. Its attributes are `db.system.name`, `db.namespace`, `db.operation.name`, `server.address`, `server.port`, `error.type`, and `db.response.status_code`.

| Metric | Type | Attributes | Counts |
| --- | --- | --- | --- |
| `camusdb.client.auth.logins` | Counter | `camusdb.login.mode`, `error.type` | Each login. The mode is `blocking` (a statement waited), `background` (a renewal), or `explicit` (`login`). |
| `camusdb.client.operation.retries` | Counter | `camusdb.retry.kind`, `error.type`, `db.namespace`, `db.operation.name` | Each retry. The kind is `finalize` (a commit or rollback after `CADB0509`), `autocommit` (`withRetry`), `transaction` (`client.transaction`), `token_renewal` (after `CADB0516`), or `create_database`. |
| `camusdb.client.endpoint.quarantines` | Counter | `server.address`, `server.port` | Each time the driver skips an endpoint for 30 seconds. |
| `camusdb.client.endpoint.quarantined` | Gauge | `server.address`, `server.port` | `1` while the driver skips the endpoint, else `0`. |
| `camusdb.client.prepared_statement.lookups` | Counter | `db.namespace`, `camusdb.prepared_statement.result` | Each run of a statement that can be prepared: `hit`, `registered`, or `miss`. |
| `camusdb.client.prepared_statement.registrations` | Counter | `db.namespace`, `camusdb.prepared_statement.result`, `error.type` | Each registration with an answer: `success`, `refused`, or `unsupported`. |
| `camusdb.client.prepared_statement.evictions` | Counter | `db.namespace` | Each prepared statement that the driver released to make space. |
| `camusdb.client.prepared_statement.count` | UpDownCounter | `db.namespace` | The prepared statements now. |

A blocking login and a retry are also events (`camusdb.login`, `camusdb.retry`) on the active driver span.

If `count` stays at `maxAutoPrepare` and `evictions` increases, increase `maxAutoPrepare`.

The driver makes its metric instruments again when the global meter provider changes. A tracer provider that you register later also gets the spans.
