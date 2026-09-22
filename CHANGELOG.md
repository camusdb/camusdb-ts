# Changelog

Every notable change to this package is written here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- gRPC batch stream frames. The operations that wait together are written as a single stream
  message, so the fixed cost of a message is paid once per frame rather than once per operation.
  The client packs a frame only for a server that announced frames on that very stream, and it
  reads a response frame at any time. A frame never waits for more operations, a lone operation
  stays a plain single message, and a frame gives no atomicity and no ordering that the stream does
  not already give. At most 256 operations and 1 MiB of estimated payload share one frame. The new
  `requestFrames` option, `RequestFrames` in a connection string, turns frames off.
- gRPC batch stream rotation on a token renewal. A stream presents its bearer token once, when it
  opens, and then outlives it. The next statement on a stream whose credential was replaced now
  opens a fresh stream under the new token, and retires the old one. A retired stream takes no new
  work, keeps serving the transactions that began on it, and closes when the last of them ends. The
  new `streamDrainTimeoutMs` option, `StreamDrainTimeout` in a connection string, bounds that wait,
  because a transaction its caller abandoned would otherwise hold the stream, and its locks, open
  for good. A statement of a transaction that finishes on a retired stream runs inline rather than
  prepared, because the slot's registration belongs to the stream that replaced it.
- Large-value storage. `CamusColumnStorage` names the four column storage strategies as the SQL
  keywords the server accepts, `setColumnStorageStatement` and `rewriteStorageStatement` compose the
  two statements, and `client.rewriteStorage` converts the rows a table already stores. A strategy
  decides the form of future writes only, so it never changes a query result. Three server codes
  come with the feature: `ColumnStorageNotApplicable` (`CADB0414`), `LargeValueCorrupt`
  (`CADB0540`), and `LargeValueNotResolved` (`CADB0541`). A server that predates large-value storage
  refuses the `STORAGE` clause as a parse error, so the live cases for it are opt-in with
  `CAMUS_LIVE_LARGE_VALUES=true`.
- Sequences. `CREATE SEQUENCE`, `ALTER SEQUENCE`, and `DROP SEQUENCE` now go to the DDL route. An
  older client sent them to the data route. `createSequenceStatement`, `dropSequenceStatement`,
  `nextValueExpression`, and `selectNextValueStatement` compose the text, and
  `client.nextSequenceValue` draws one value as a `bigint`. A CamusDB sequence never cycles, so the
  options have no `cycle`. The helper never writes `NO MINVALUE`, because the server reads it as
  the smallest 64-bit value and not as the default. Sequences need a server from 0.13.2 on.
- `CamusErrorCode.EndpointUnreachable` (`CADB0001`). The driver raises it when a request never
  reached a server, so the same work is safe to run again on another endpoint.

### Changed

- The gRPC pump now starts after the turn that queued an operation, rather than inside it. Several
  statements issued in one turn then reach one drain, and share one frame. The delay is one
  microtask, so no round trip is added.
- An operation whose caller cancelled it before it was written is no longer sent. A rollback and a
  close are still written, because each one releases what the server holds.

### Fixed

- A UUID string declared as an object id now travels as a `Uuid`. `camus.array(uuids, ColumnType.Id)`
  sent each element as 36 characters of `Id` text, which equals no stored value. So `IN` returned
  no rows, `NOT IN` returned every row, and `=` failed. A UUID is 16 bytes and an ObjectId is 12,
  so a UUID can never be an ObjectId. Such an array now has the `Uuid` element type. An ObjectId
  string keeps the `Id` type. `camus.id` still refuses a UUID, and its message now names
  `camus.uuid`.
- `validateIdentifier` now refuses an identifier that ends with a backslash, as `validateSqlLiteral`
  already refused a literal that does. CamusDB's lexer reads a backslash and the character after it
  as one unit, so such a name consumed its own closing backtick and the statement parsed as
  something else. It reached `CREATE DATABASE … BRANCH FROM …` and the two column storage
  statements, whose names can come from an application's own input.
- `CamusTokenProvider.login` no longer lets a login it replaced publish its token. A renewal that
  was already in flight used to overwrite the new identity's token, and its completion used to drop
  the reference to the newer login, which let a third login start against a rate-limited endpoint.
  A login now authenticates as the identity it started with, and only the current identity's login
  writes the cached token.
- A column or a parameter named `__proto__` now reaches the wire and the row. Plain assignment set
  the record's prototype instead, so the value was dropped and, when it was an object, every
  property lookup on the row saw its members. The gRPC parameter encoder, the REST parameter
  encoder, and the row mapper all install an own property now.
- `RowMapper` no longer overwrites a real column with a deduped key. `SELECT id, id_2, id` produced
  the keys `id`, `id_2`, `id_2`, and the genuine `id_2` column was lost. The deduped key now steps
  past every name a column already claims.
- `uuidToBytes` now tests the whole run of digits before it reads any of it. `Number.parseInt` stops
  at the first character it cannot read, so a malformed pair such as `0g` put a wrong byte on the
  wire instead of raising an error. `bytesToHalves` now reports a clear `TypeError` for an input
  that is not 16 bytes.
- `stringifyLossless` now escapes an unpaired surrogate, as `JSON.stringify` does. The half used to
  travel raw, the UTF-8 encoder replaced it with U+FFFD, and the server stored a different string
  than the caller bound. A property whose `toJSON` reports `undefined` is now omitted rather than
  written as null.
- The lossless JSON parser now refuses the text `JSON.parse` refuses: a raw control character inside
  a string, and a number with a leading zero, an empty fraction, or a bare exponent. The same text
  used to decode differently depending on whether a run of 16 digits routed it to this parser.
- A 2xx response whose body is not JSON now reports that, rather than `Empty result returned` with
  the parse failure buried in `cause`. On the login route, an empty body and an unparseable body now
  report `CADB0000`: the empty case used to report `CADB0516`, which drives token invalidation, and
  the unparseable case used to let a raw `SyntaxError` escape.
- A prepared-statement registration that failed without a verdict — a timeout, an unreachable node —
  no longer stops the driver from offering that statement again. Only a refusal from the server is
  terminal now. One network blip used to cost the statement its registration for the life of the
  process.
- A streaming row line that is not valid JSON is now reported as a `CamusError`, as a malformed
  header line already was, and the stream is closed. A line that is neither a row nor a trailer is
  now an error rather than a silent end of stream.
- `isRetryable` now stops after 16 links of a `cause` chain, so a chain that points at itself cannot
  hang the walk.
- The first retry now waits the documented 20 ms base rather than 40 ms.
- `changeDatabase` and configuration resolution now refuse a database name that holds a control
  character. The prepared-statement policy, the gRPC batcher, and the REST prepared-statement cache
  each join a database name and a statement with a newline, so such a name made two distinct pairs
  collide on one cache key.
- `camus.id` now refuses a string that is not 24 hexadecimal digits. Every other typed helper
  already validated its argument, and this one reported its failure from the server instead.
- The gRPC causal token merge now breaks a tie on the node id, which `buildHandle` documents as the
  tie-breaker.
- `announcesFrames` now reads a header version strictly. `Number.parseInt` stops at the first
  character it cannot read, so `1x` announced version 1.
- The gRPC transport now sets an endpoint aside when it stops answering. Only the REST transport
  did this before, so a gRPC client kept every statement pointed at a node that was gone, and
  learned routing kept preferring it. A gRPC failure that never left the client now reports
  `CADB0001`. A connection that failed under a call that was already sent still reports `CADB0000`,
  because that call's outcome is unknown, but the endpoint is set aside all the same.

### Changed

- The minimum Node.js version is now 20.19, or 22.12 on the 22 line. Version 0.1.0 accepted
  20.11. The test toolchain sets this floor: Vitest 4 builds with Vite 8, which does not run
  below it.

## [0.1.0] — 2026-09-11

The first release. It is a full port of the CamusDB .NET connector, with the same wire protocols
and the same server contracts, written as an idiomatic TypeScript API.

### Added

- `CamusClient`, built from an options object or from a connection string.
- Queries: `query`, `queryOne`, `scalar`, and `queryStream`.
- Writes: `execute`, `executeDdl`, and the typed row-level `insert`.
- Transactions: `transaction` with an automatic retry of a lost conflict, and `beginTransaction`
  for a unit of work that does not fit in one function. Both support isolation, read-only mode, and
  optimistic locking.
- Row-incremental streaming over the REST transport, as an async iterable.
- Automatic and explicit prepared statements, with a bounded, shared policy.
- Authentication: a shared bearer token, one login for concurrent callers, proactive renewal, and
  one replay after a rejection.
- Both wire transports. REST is the default; gRPC multiplexes statements over long-lived
  `BatchExecute` streams and carries the session's causal token.
- Endpoint rotation, with an endpoint that stops answering set aside for 30 seconds.
- Learned statement routing, gated by an operator-configured trust map.
- Database administration: create, drop, copy-on-write branches, and the branch and ancestor
  listings.
- The query result cache: hints, verdicts, and eviction.
- The online backup administration API.
- 64-bit integers that stay exact on both transports, in both directions.
- Values: `camus.*` type helpers, `CamusObjectId`, `CamusVector`, and tick conversion.
- `AbortSignal` support and a per-statement deadline on every method that reaches the server.
- A live suite, `npm run test:live`, that runs the whole surface against a real server on both
  transports.

### Fixed

Three defects the live suite found, all carried over from the .NET connector or from the gRPC
call convention:

- **Branching used REST routes the server does not have.** `createBranchDatabase`, `showBranches`
  and `showAncestors` posted to `/create-branch-db`, `/show-branches` and `/show-ancestors`, which
  answer 404: the server implements branching only as SQL. All three now compose the statement, as
  the gRPC transport already did, and both transports share one composition.
- **Every gRPC call was refused before it left the process.** A unary call passed `undefined` where
  grpc-js requires a `Metadata` instance, so it raised `Incorrect arguments passed`. The metadata is
  now always a real instance, carrying the bearer token only when there is one.
- **`cacheHint` accepted family names the server cannot parse.** A hint writes the name into the
  statement unquoted, so a hyphen, a dot or a colon is a syntax error. `cacheHint` now refuses them
  where the name is written. `evictCacheStatement` still accepts them, because `EVICT CACHE` takes
  a quoted string.
