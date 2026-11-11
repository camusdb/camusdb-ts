# Errors and cancellation

## `CamusError`

Each database failure is a `CamusError` with a `CADBxxxx` code in `code`.

```ts
import { CamusError, CamusErrorCode } from 'camusdb';

try {
  await client.execute('INSERT INTO robots (id) VALUES (@id)', { id });
} catch (error) {
  if (CamusError.is(error) && error.code === CamusErrorCode.DatabaseAlreadyExists) {
    // …
  }

  throw error;
}
```

- Use `code` in your logic. The message text can change.
- `CamusErrorCode` names the codes that the driver uses. Other codes from the server come to you unchanged.
- The driver cleans each message from the server: it masks text that looks like a credential, changes control characters to spaces, and limits the length.

| Code | Meaning |
| --- | --- |
| `CADB0000` | A general error. The driver uses it when the server gave no code. |
| `CADB0001` | The driver did not send the request, because the node did not answer. See [Endpoint pool](connection.md#endpoint-pool). |
| `CADB0502`, `CADB0504`, `CADB0505` | Retryable conflicts. See [Retries](transactions.md#retries). |
| `CADB0509` | The commit result is not known yet. See [Unknown commit result](transactions.md#unknown-commit-result). |

Other pages list the codes of their feature.

## Cancellation and timeouts

Each method that calls the server accepts an `AbortSignal`. Most also accept a timeout for one statement.

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

await client.query('SELECT * FROM robots', undefined, {
  signal: controller.signal,
  timeoutSeconds: 30,
});
```

When you cancel, the driver throws the abort error as it is. It does not mark the node as unreachable.
