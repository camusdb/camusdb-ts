# Connection

How to make a client, its options, and the connection string.

## Make a client

Use an options object or a connection string. Each option has one connection-string key.

```ts
import { CamusClient } from 'camusdb';

const a = new CamusClient({ endpoint: 'http://localhost:8082', database: 'test' });
const b = CamusClient.fromConnectionString('Endpoint=http://localhost:8082;Database=test');
```

A client opens no socket of its own, so it is cheap to make. See [What a client shares](#what-a-client-shares).

## Options

| Option | Key | Default | Description |
| --- | --- | --- | --- |
| `endpoint` | `Endpoint` | required | A node URL, or several: an array, or a comma-separated list. See [Endpoint pool](#endpoint-pool). |
| `database` | `Database` | required | The database that each request uses. |
| `timeoutSeconds` | `Timeout` | `10` | The request timeout in seconds. |
| `protocol` | `Protocol` | `rest` | `rest` or `grpc`. See [Transport](transport.md). |
| `user` | `User` | | The user to log in as. Key aliases: `UserId`, `Uid`, `Username`. See [Authentication](authentication.md). |
| `password` | `Password` | | The password of `user`. Key alias: `Pwd`. |
| `accessToken` | `AccessToken` | | A bearer token from elsewhere. The driver sends it as it is. |
| `tokenLifetimeSeconds` | `TokenLifetime` | `600` | How long to use a token when the server does not say. |
| `maxAutoPrepare` | `MaxAutoPrepare` | `128` | How many statements to keep prepared. `0` turns it off. See [Prepared statements](prepared-statements.md). |
| `autoPrepareMinUsages` | `AutoPrepareMinUsages` | `2` | How many runs of the same SQL before the driver prepares it. |
| `channelPoolSize` | `ChannelPoolSize` | `8` | gRPC only: streams for each endpoint. The stream count, not the number of clients, limits the statements that run at the same time. See [Transport](transport.md#how-grpc-works). |
| `coalescingThreshold` | `CoalescingThreshold` | `10` | gRPC only. `1` turns coalescing off. |
| `coalescingDelayMs` | `CoalescingDelay` | `0` | gRPC only: the coalescing wait in milliseconds. `0` is off. |
| `requestFrames` | `RequestFrames` | `true` | gRPC only: send statements that wait together as one message. |
| `streamDrainTimeoutMs` | `StreamDrainTimeout` | `300000` | gRPC only: how long a retired stream stays open for its transactions. |
| `httpVersion` | `HttpVersion` | `1.1` | Only `1.1` is accepted. See the note below. |
| `backupEndpoint` | `BackupEndpoint` | next pool endpoint | The HTTP endpoint of the backup API. Required with `grpc`. See [Backups](backups.md). |
| `backupTimeoutSeconds` | `BackupTimeout` | `300` | The backup request timeout in seconds. |
| `allowInsecureCredentials` | `AllowInsecureCredentials` | `false` | Allow credentials to a remote `http://` endpoint. See [Security](security.md). |
| `routingMode` | `RoutingMode` | `auto` | `auto`, `learned`, or `off`. See [Learned routing](learned-routing.md). |
| `routingNodes` | `RoutingNodes` | | The map from node identities to endpoints. |
| `routingMaxHintAgeMs` | `RoutingMaxHintAge` | `5000` | The longest time to use a learned route. |
| `defaultTransactionOptions` | `IsolationLevel`, `TransactionMode`, `Locking` | server default | Defaults for each transaction and autocommit statement. See [Transactions](transactions.md#concurrency-options). |
| `int64` | `Int64` | `auto` | `auto`, `number`, or `bigint`. See [Data types](data-types.md#64-bit-integers). |
| `jsonb` | `Jsonb` | `parse` | `parse` or `text`. See [Data types](data-types.md#jsonb). |
| `traceQueryText` | `TraceQueryText` | `false` | The SQL text on spans: `false`, `true`, or `'sanitized'`. See [OpenTelemetry](opentelemetry.md). |

**`HttpVersion`.** Node's `fetch` sends HTTP/1.1 only. The driver refuses `2` and `3` with a `CamusError`. Any other value reads as `1.1`. The .NET driver accepts `2` and `3`, so remove the key from a string that you share with a .NET service. gRPC always uses HTTP/2.

## Connection string rules

- Keys are not case-sensitive, and the driver trims them.
- A key that occurs two times is an error.
- An unquoted value is trimmed, and it ends at the next `;`.
- Put a value in single or double quotes to keep a `;` or spaces. Write the quote two times to include it.

```ts
CamusClient.fromConnectionString("Endpoint=https://db.example:5095;Database=test;User=app;Password='pa;ss''word'");
// The password is: pa;ss'word
```

## Log a configuration

Do not log a raw connection string. `client.toString()` and `redactConnectionString` mask `Password`, `Pwd`, and `AccessToken`:

```ts
import { redactConnectionString } from 'camusdb';

redactConnectionString('Endpoint=https://db:5095;Database=test;User=app;Password=secret');
// 'Endpoint=https://db:5095;Database=test;User=app;Password=***'
```

## Endpoint pool

With several endpoints, each request goes to the next endpoint in the list:

```ts
const client = new CamusClient({
  endpoint: ['http://a:8082', 'http://b:8082', 'http://c:8082'],
  database: 'test',
});
```

- An endpoint that does not answer is skipped for 30 seconds.
- When all endpoints are skipped, the driver uses the one that is nearest to the end of its 30 seconds.
- The error code tells you if the request left the client:
  - `CADB0001`: the driver did not send the request. You can send it again to another endpoint.
  - `CADB0000`: the connection failed after the driver sent the request. The result is not known. Do not run a commit again from `BEGIN`.

## What a client shares

All clients in one process share this state:

| State | Shared by clients with the same |
| --- | --- |
| Endpoint rotation and health | Endpoint list |
| Bearer token | User and deployment |
| Transport and prepared statements | User, deployment, and gRPC stream options |
| Learned routes | Deployment and routing options |

So a new client for each request still uses the open connections, the token, and the prepared statements.

`client.close()` releases nothing today. To close the shared gRPC channels when the process stops:

```ts
import { CamusTransportPool } from 'camusdb';

await CamusTransportPool.closeAll();
```
