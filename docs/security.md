# Security

What the driver does to keep credentials and memory safe.

- **No credentials over remote `http://`.** On an `http://` endpoint, the password and the token cross the network as plain text. The driver refuses to send them, except to loopback (`localhost`). Set `allowInsecureCredentials` only when a private link adds TLS for you.
- **The server cannot pick a destination.** Routing advice becomes a destination only through your `routingNodes` map, and only for an endpoint in the pool. See [Learned routing](learned-routing.md).
- **No redirects.** The driver never follows an HTTP redirect, because the redirect would take the token to a different address.
- **Clean error text.** See [Errors](errors.md).
- **Memory limit.** The driver reads at most 256 MiB of one REST response, and 64 MiB of one line of a streamed result. A larger response throws a `CamusError`. Use `queryStream` for large results.
- **Token lifetime limit.** The driver uses a token for 24 hours at most.
- **Control characters.** The driver refuses a control character in a database name or an endpoint.
- **Token key.** The driver shares a token under a salted hash of the credentials, not the password.
- **Bound values.** Use parameters, not string operations, to put values in SQL. See [Parameters](parameters.md).
