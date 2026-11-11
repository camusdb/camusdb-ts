# Data types

The JavaScript value of each column type, and the rules for the types that JavaScript does not have. To bind values, see [Parameters](parameters.md).

## Column types

| Column type | JavaScript value |
| --- | --- |
| `Null` | `null` |
| `Id`, `String` | `string` |
| `Integer64` | `number` or `bigint`. See [64-bit integers](#64-bit-integers). |
| `Float64`, `Float32` | `number` |
| `Bool` | `boolean` |
| `Bytes` | `Uint8Array` |
| `Date`, `DateTime` | `Date`, in UTC. See [Dates](#dates). |
| `Uuid` | `string`, lowercase with hyphens |
| `Numeric` | `string`. See [NUMERIC](#numeric). |
| `Jsonb` | The parsed document, or its JSON text. See [JSONB](#jsonb). |
| `Array` | An array of the values above |

## Floats

- A `Float32` value is the single-precision value that the server stored.
- A negative zero (`-0`) keeps its sign.
- `Infinity`, `-Infinity`, and `NaN` are float values. JSON has no number for them, so REST sends them as the strings `"Infinity"`, `"-Infinity"`, and `"NaN"`. The driver reads and writes this form for you. A server without the PostgreSQL float rule cannot store these values.

## Arrays

An array element has the element type of its column. Over REST, the server sends the element type in the `elementType` field. An older server does not send it. Then:

- A `Date`, `DateTime`, or `Bytes` element reads as its wire value: ticks as a number, or base64 text.
- A `Float64` array with only whole numbers reads as integers.

Use gRPC or a newer server to read these arrays correctly.

## 64-bit integers

A JavaScript `number` is exact only up to 2^53. An `Integer64` can be larger. The driver never puts a 64-bit value through a `number` on the wire. The `int64` option sets how you get the value:

| `int64` | You get |
| --- | --- |
| `auto` (default) | A `number` up to 2^53, and a `bigint` above it |
| `number` | Always a `number`. A value above 2^53 loses precision. |
| `bigint` | Always a `bigint` |

Set it for the client, or for one statement:

```ts
const client = new CamusClient({ endpoint, database, int64: 'bigint' });

await client.query('SELECT n FROM counters', undefined, { int64: 'number' });
```

## NUMERIC

`NUMERIC` (alias `DECIMAL`) is an exact decimal with precision 38 and scale 9. The precision and the scale are fixed, so the server refuses `NUMERIC(P, S)`. The value goes as decimal text on both transports.

- **Read.** You get a `string`, such as `'1.5'`, `'1200'`, or `'0'`. JavaScript has no decimal type. Use `Number(value)` if a rounded value is sufficient, or a decimal library.
- **Bind.** Use `camus.numeric(value)`. A plain `number` binds as `Float64` or `Integer64`, and a comparison with a float is not exact.
- **Rounding.** The server rounds more than 9 fraction digits half away from zero.
- **Range.** A value out of range fails with `CADB0417`.
- **No arrays.** The server has no `ARRAY(NUMERIC)`. The driver refuses one before it sends the request.

```ts
await client.execute('INSERT INTO orders (id, price) VALUES (GEN_ID(), @price)', {
  price: camus.numeric('19.99'),
});
```

## JSONB

`JSONB` (alias `JSON`) holds one JSON document. The SQL follows PostgreSQL `jsonb`: the operators `->`, `->>`, `#>`, `#>>`, `@>`, `<@`, `?`, `?|`, `?&`, `||`, `-`, and `#-`, the `jsonb_*` functions, and GIN indexes (indexes that find the documents that contain a value).

**Bind a document:**

- A plain object binds as `JSONB`.
- For any other document, use `camus.jsonb(value)`. A `string` is JSON text. Other values are serialized.
- `camus.jsonb(null)` is the JSON `null` document. It is not SQL `NULL`.
- An array without `camus.jsonb` binds as an `ARRAY`. The server has no `ARRAY(JSONB)`, so bind a JSON array with `camus.jsonb([...])`.

**Read a document.** The `jsonb` option sets the form:

| `jsonb` | You get |
| --- | --- |
| `parse` (default) | The parsed value. A large integer is a `bigint`. A fraction is a `number`, so `2.50` reads as `2.5`. |
| `text` | The JSON text in the PostgreSQL form: a space after each `:` and `,`, and the keys in stored order (shorter keys first). Numbers keep all digits. `formatJsonb(json)` gives the same form for any JSON text. |

Set it for the client (`jsonb: 'text'` or `Jsonb=text`), for one statement, or for one pipelined query. In `text` mode, a JSON `null` document reads as `'null'`, and SQL `NULL` reads as `null`.

```ts
await client.executeDdl('CREATE TABLE events (id OID PRIMARY KEY NOT NULL, payload JSONB NOT NULL)');
await client.executeDdl('CREATE INDEX events_payload_gin ON events USING GIN (payload)');

await client.execute('INSERT INTO events (id, payload) VALUES (GEN_ID(), @payload)', {
  payload: { kind: 'login', user: { id: 7 } },
});

const result = await client.query("SELECT payload ->> 'kind' AS kind FROM events WHERE payload @> @filter", {
  filter: { kind: 'login' },
});
```

- A GIN index serves `@>`, `<@`, `?`, `?|`, `?&`, and the equality of one key in a `WHERE`. It does not serve a condition under `OR` or `NOT`, a join, or `@>` with `{}`, `[]`, or a scalar. `EXPLAIN` shows `gin-scan(...)` when the server uses the index.
- The `?` operators do not conflict with parameters, because parameters are `@name`. If a tool changes `?`, use `jsonb_exists`, `jsonb_exists_any`, and `jsonb_exists_all`.

| Code | Meaning |
| --- | --- |
| `CADB0418` | The text is not valid JSON. |
| `CADB0419` | The document has more than 512 levels. |

## Dates

`Date` and `DateTime` columns store ticks (100 ns units since 0001-01-01 UTC). A JavaScript `Date` holds milliseconds, so a read loses the digits below one millisecond. To get the exact value, convert the ticks yourself:

```ts
import { ticksToDate, dateToTicks } from 'camusdb';
```

## Vectors

An embedding is a `BYTES` column of packed little-endian float32 values. There is no vector column type.

```ts
import { CamusVector, camus } from 'camusdb';

await client.execute('INSERT INTO docs (id, embedding) VALUES (GEN_ID(), @embedding)', {
  embedding: camus.vector([0.1, 0.2, 0.3]),
});

const row = await client.queryOne<{ embedding: Uint8Array }>('SELECT embedding FROM docs LIMIT 1');
const vector = CamusVector.toFloats(row!.embedding); // Float32Array
```

A `Float32Array` parameter is packed in the same way.

## ObjectIds

An `Id` (`OID`) value is a 12-byte ObjectId, written as 24 lowercase hexadecimal characters. The driver makes them in the same way as the server:

```ts
import { CamusObjectId } from 'camusdb';

const id = CamusObjectId.generateAsString();
```

For large `STRING`, `BYTES`, and `ARRAY` values, see [Large values](large-values.md).
