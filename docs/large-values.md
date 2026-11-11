# Large values

A server with large-value storage can compress a large `STRING`, `BYTES`, or `ARRAY` value (LZ4), or keep it outside its row. Results and parameters do not change. Two things do change:

- A query that does not name a column that is outside the row does not read it.
- An update of a different column does not write the large value again.

## Storage strategies

Each such column has a storage strategy. The names come from PostgreSQL.

| Strategy | Compresses | Moves out of the row | Use it for |
| --- | --- | --- | --- |
| `EXTENDED` (default) | When it is smaller | At 2048 bytes or more (`large_value_threshold_bytes`) | Text, JSON, documents |
| `MAIN` | When it is smaller | Never | Values that compress and that most queries read |
| `EXTERNAL` | Never | At the threshold or more | Images and archives that queries often skip |
| `PLAIN` | Never | Never | Embeddings that a KNN (nearest-neighbor) query reads on each row |

Set the strategy in `CREATE TABLE`, or change it with `SET STORAGE`:

```ts
import { CamusColumnStorage, setColumnStorageStatement } from 'camusdb';

await client.executeDdl(
  `CREATE TABLE docs (
     id         OID PRIMARY KEY NOT NULL,
     body       STRING,
     thumbnail  BYTES STORAGE ${CamusColumnStorage.External},
     embedding  BYTES(3072) STORAGE ${CamusColumnStorage.Plain}
   )`,
);

await client.executeDdl(setColumnStorageStatement('docs', 'thumbnail', CamusColumnStorage.Plain));
```

## Convert existing rows

`SET STORAGE` applies to new writes only. To convert the rows that exist, call `rewriteStorage`. The time increases with the table size, so give a long timeout:

```ts
await client.rewriteStorage('docs', { timeoutSeconds: 3600 });
```

- `rewriteStorage('docs', { inline: true })` puts all values back in their rows, without compression. Do this on each table before you install an older server that has no large-value storage.
- The server runs the rewrite in its own small transactions. You cannot run it in your transaction, and a rollback cannot undo it.
- If the rewrite stops, run it again. It continues after the last batch that committed.
- A write to a row in the current batch can fail with the retryable `CADB0502`.

## Costs

- **Embeddings.** A 768-dimension float32 embedding is 3072 bytes, so `EXTENDED` moves it out of the row. Then a KNN query does one more read for each batch. Use `STORAGE PLAIN` for an embedding column that KNN queries read.
- **Mutation limit.** Each value outside the row is one more key. So an insert or a delete of a row with `k` such values costs `k` more mutations, and fewer rows fit in one transaction.

## Error codes

| Code | Meaning |
| --- | --- |
| `CADB0414` | The column type has no variable-length value, so a storage strategy does not apply. |
| `CADB0540` | A stored value did not decompress, or its checksum is wrong. |
| `CADB0541` | A server defect. Report it. |
| `CADB0504` | A read without a snapshot saw a row change too many times. It is retryable. `withRetry` and `client.transaction` retry it. |
