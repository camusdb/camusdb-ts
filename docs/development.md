# Development

How to build and test the driver.

```shell
npm install
npm run build         # compile to dist/
npm test              # the offline tests
npm run test:coverage
npm run test:live     # the tests that need a running server
npm run lint
npm run typecheck
npm run format
```

## Offline tests

The offline tests need no CamusDB server. They use a real HTTP server on a loopback port.

## Live tests

The live tests run against a real server, over both transports. Set the server with these variables:

| Variable | Default |
| --- | --- |
| `CAMUS_LIVE_ENDPOINT` | `http://localhost:5095` |
| `CAMUS_LIVE_GRPC_ENDPOINT` | `http://localhost:5096` |
| `CAMUS_LIVE_DATABASE` | `camusdb_ts_live` |
| `CAMUS_LIVE_USER`, `CAMUS_LIVE_PASSWORD` | none, for a server with authentication off |

Each test makes its own table and drops it after, so a run leaves nothing behind.
