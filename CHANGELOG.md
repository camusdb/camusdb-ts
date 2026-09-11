# Changelog

Every notable change to this package is written here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
