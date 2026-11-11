# Transport: REST and gRPC

The driver talks to a node over REST (the default) or gRPC. The client API is the same for both.

## Use gRPC

Install the two optional packages:

```shell
npm install @grpc/grpc-js @grpc/proto-loader
```

Then set `protocol`:

```ts
const client = new CamusClient({
  endpoint: 'http://localhost:5096', // the gRPC port of the node
  database: 'test',
  protocol: 'grpc',
  backupEndpoint: 'http://localhost:8082', // the HTTP port, for backups
});
```

## Differences

| | REST | gRPC |
| --- | --- | --- |
| Requests | One HTTP request for each statement | Many statements on a few shared streams |
| Row streaming | Yes | Yes, on a separate call |
| Prepared statements | Handles for each node | Handles for each stream |
| Backup API | Yes | No. Set `backupEndpoint`. |
| Extra packages | None | `@grpc/grpc-js`, `@grpc/proto-loader` |

## How gRPC works

- **Streams.** For each endpoint, the driver keeps `channelPoolSize` long-lived streams open (default 2). Many statements and transactions share them. The statements of one transaction go on one stream, in order.
- **Read your own writes.** Each reply carries an HLC time stamp. The driver sends the largest one back with each request. So a read sees the earlier writes of the same client, on any node.
- **Frames.** Statements that you start together, such as with one `Promise.all`, go as one stream message, called a frame. A frame never waits for more statements. Set `requestFrames: false` to turn frames off. A server that does not support frames never gets one.
- **Coalescing.** Off by default. With `coalescingDelayMs` above 0, the driver waits that many milliseconds after it sends 2 or more statements, but fewer than `coalescingThreshold`. More statements collect during the wait, so the next frame is fuller.
- **Pipelines.** A [pipeline](transactions.md#pipelines) sends a whole transaction as one frame. This needs a server with frame contract version 2.
- **Token change.** A stream sends its bearer token once, when it opens. When the token changes, the next statement opens a new stream. The old stream takes no new work. It closes when its last transaction ends, or after `streamDrainTimeoutMs`.
- **`channelPoolSize` is not a transaction limit.** Increase it only when many long queries on one endpoint wait for each other.

The `.proto` file in `proto/` is the server's file.
