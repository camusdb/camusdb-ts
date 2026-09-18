# Changelog

Every notable change to this package is written here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Large-value storage. `CamusColumnStorage` names the four column storage strategies as the SQL
  keywords the server accepts, `setColumnStorageStatement` and `rewriteStorageStatement` compose the
  two statements, and `client.rewriteStorage` converts the rows a table already stores. A strategy
  decides the form of future writes only, so it never changes a query result. Three server codes
  come with the feature: `ColumnStorageNotApplicable` (`CADB0414`), `LargeValueCorrupt`
  (`CADB0540`), and `LargeValueNotResolved` (`CADB0541`). A server that predates large-value storage
  refuses the `STORAGE` clause as a parse error, so the live cases for it are opt-in with
  `CAMUS_LIVE_LARGE_VALUES=true`.
- `CamusErrorCode.EndpointUnreachable` (`CADB0001`). The driver raises it when a request never
  reached a server, so the same work is safe to run again on another endpoint.

### Fixed

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
