# Learned routing

Send a statement directly to the node that leads its data. This removes one forward between nodes. It changes no result.

## How it works

1. A server can add routing advice to a reply: the identity of the node that leads the data of the statement.
2. The driver maps that identity to an endpoint with `routingNodes`.
3. The next runs of the same SQL text go to that endpoint.

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

## Modes

| `routingMode` | Behavior |
| --- | --- |
| `auto` (default) | On only when `routingNodes` maps to 2 or more different endpoints. |
| `learned` | On when `routingNodes` maps at least one identity. |
| `off` | Never on. |

## Rules

- **Only listed endpoints.** The driver sends a request only to an endpoint that is in `routingNodes` and in the endpoint pool. It never uses an address from the server.
- **Cache key.** The driver keeps a route for each database, exact SQL text, and statement kind. A route for one SQL text never applies to another text.
- **Age.** A route is used for the shorter of the server's time and `routingMaxHintAgeMs`.
- **Size.** The cache holds 4096 routes and 4 MiB at most.
- **Transactions.** A transaction stays on the endpoint where it started.
- **Skipped endpoints.** A route to a skipped endpoint falls back to the endpoint pool.
- **No retries.** Routing adds no retry.

## Where a routed transaction starts

With routing on, `beginTransaction` sends nothing. The first statement of the transaction sends `BEGIN` to the learned endpoint of that statement. All later statements, and the commit or rollback, go to the same endpoint.

As a result:

- `txnIdPT`, `txnIdCounter`, and `transactionId` are zero until the first statement. `isStarted` tells you if the transaction started.
- A failure to begin comes from the first statement.

To pick the endpoint from a different statement, give it as `affinity`. Then `BEGIN` goes at once, to the learned endpoint of that statement:

```ts
const txn = await client.beginTransaction({ affinity: 'SELECT * FROM robots WHERE id = @id' });
```

## Diagnostics

- `client.learnedRouteCount`: the number of routes in the cache.
- `result.routingAdvice`: the advice that one statement got.
