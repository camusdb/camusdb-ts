# Parameters

How to bind values to a statement.

## Bind values

Write `@name` in the SQL, and give the values as an object. The `@` in the key is optional.

```ts
await client.query('SELECT * FROM robots WHERE year = @year AND name = @name', { year: 1974, name: 'r1' });
```

Always bind values. Do not put values into the SQL text with string operations. A bound value never becomes SQL, so it cannot change the statement.

## The type the driver picks

| JavaScript value | Column type |
| --- | --- |
| `null`, `undefined` | `Null` |
| `boolean` | `Bool` |
| `number` with no fraction, except `-0` | `Integer64` |
| other `number`, and `-0` | `Float64` |
| `bigint` | `Integer64` |
| `string` | `String` |
| `Date` | `DateTime` |
| `Uint8Array`, `Buffer`, `ArrayBuffer` | `Bytes` |
| `Float32Array` | `Bytes`, as a vector |
| `CamusObjectId` | `Id` |
| plain object (`{ … }`) | `Jsonb` |
| array | `Array`. The element type comes from the first element that is not null. If one `number` has a fraction or is `-0`, all `number` elements are `Float64`. |

A string that looks like a UUID is still a `String`. Use `camus.uuid` for a UUID.

## State the type

Use a `camus.*` helper when the type that the driver picks is not the type you need:

```ts
import { camus, ColumnType } from 'camusdb';

await client.query('SELECT * FROM robots WHERE key = @key AND made = @made AND tags = @tags', {
  key: camus.uuid('550e8400-e29b-41d4-a716-446655440000'),
  made: camus.date(new Date('2024-03-15T00:00:00Z')),
  tags: camus.array([], ColumnType.String),
});
```

| Helper | Column type |
| --- | --- |
| `camus.id(value)` | `Id`, from 24 hexadecimal characters |
| `camus.uuid(value)` | `Uuid`, from the hyphenated string |
| `camus.int64(value)` | `Integer64` |
| `camus.float64(value)` | `Float64` |
| `camus.float32(value)` | `Float32` |
| `camus.numeric(value)` | `Numeric`, from a decimal `string`, a `bigint`, or a `number` |
| `camus.jsonb(value)` | `Jsonb`, from JSON text, or from any value |
| `camus.bool(value)` | `Bool` |
| `camus.string(value)` | `String` |
| `camus.bytes(value)` | `Bytes` |
| `camus.vector(values)` | `Bytes`, as float32 elements |
| `camus.date(value)` | `Date`, at UTC midnight |
| `camus.dateTime(value)` | `DateTime` |
| `camus.array(items, elementType)` | `Array` with the element type you give |
| `camus.null()` | `Null` |
| `camus.raw(columnValue)` | The type in the value |

- An empty array needs `camus.array`, because it has no element to get a type from.
- Each helper checks its value, so a bad value fails where you call the helper.
- A UUID string is always a `Uuid`, also in `camus.array(items, ColumnType.Id)`.

See [Data types](data-types.md) for `NUMERIC`, `JSONB`, dates, and vectors.
