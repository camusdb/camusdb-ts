# Glossary

The terms that the other pages use.

| Term | Meaning |
| --- | --- |
| Node | One CamusDB server process. A cluster has several nodes. |
| Endpoint | The URL of one node, such as `http://localhost:8082`. |
| Endpoint pool | The list of endpoints that one client sends requests to, in turn. |
| Transport | How the driver talks to a node: REST or gRPC. |
| REST | One HTTP request with a JSON body for each statement. The default transport. |
| gRPC | A binary protocol over HTTP/2. The driver keeps long-lived streams open and sends many statements on them. |
| Route | The server URL path that a request goes to, such as the query route or the DDL route. The driver picks the route from the first words of the SQL. |
| DDL | Data definition language: statements that change the schema, such as `CREATE TABLE`. |
| Write | `INSERT`, `UPSERT`, `UPDATE`, `DELETE`, or `CALL`. |
| Autocommit statement | A statement that runs outside an explicit transaction. The server runs it in its own short transaction. |
| Serializable conflict | Two transactions changed the same data. The server aborts one of them with a retryable code. |
| Round trip | One request to the server and its reply. |
| Prepared statement | A statement that the server parsed once and keeps under a handle. Later runs send the handle and the values, not the SQL text. |
| Pipeline | A list of statements of one transaction that the driver sends together, in one round trip. |
| Bearer token | The string that proves who you are. The driver gets it from a login and sends it with each request. |
| `CADBxxxx` | A CamusDB error code, for example `CADB0502`. |
| Ticks | The .NET time unit: 100 nanoseconds. CamusDB stores dates as ticks since 0001-01-01 UTC. |
| HLC | Hybrid logical clock: the server time stamp that orders events across nodes. |
