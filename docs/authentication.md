# Authentication

How the driver logs in, and how it manages the bearer token.

Authentication is off on a CamusDB server by default. With no credentials, the driver sends no `Authorization` header.

## Log in with a user and a password

For a server started with `CAMUSDB_AUTH_ENABLED=true`:

```ts
const client = new CamusClient({
  endpoint: 'https://db.example:5095',
  database: 'test',
  user: 'app',
  password: 'app-secret',
});
```

The first statement logs in. You write no other code.

## Log in at run time

Use this when the password comes from a secret store:

```ts
await client.login('app', await secrets.get('camus-password'));

client.accessToken; // the token from the login
await client.logout();
```

`logout` revokes the token and keeps the credentials. The next statement logs in again.

## Use a token from elsewhere

```ts
const client = new CamusClient({ endpoint, database, accessToken: token });
```

The driver sends this token as it is, and never renews it. When the server refuses the token, the error comes to you.

## How the driver manages the token

- **One login for all clients.** Clients with the same user and the same deployment share one token. A login is slow on the server, and the server limits the logins of each account.
- **Renewal in the background.** At 80% of the token lifetime, the driver logs in again in the background. Statements continue with the current token.
- **When a statement waits.** A statement waits for a login only when there is no token, or when the token is at 95% of its lifetime.
- **Failed renewal.** The driver tries a failed background renewal again after 5 seconds.
- **No lifetime from the server.** The driver uses `tokenLifetimeSeconds`, and renews at 80% of it.
- **Lifetime limit.** The driver uses a lifetime of 24 hours at most, whatever the server reports.
- **Busy server.** The server refuses a login with `CADB0518` when it is busy, or when the account is at its login rate limit. The driver tries again up to three times, after about 250 ms, 750 ms, and 1.5 s. A refused login runs no statement, so a new try is safe.
- **Refused token.** On `CADB0516`, the driver gets a new token and sends the statement one more time.
- **No privilege.** The driver never retries `CADB0517`, because a new login cannot give a privilege.

## Error codes

| Code | Meaning |
| --- | --- |
| `CADB0516` | The server refused the token. |
| `CADB0517` | The user does not have the privilege. |
| `CADB0518` | The server is busy, or the account is at its login rate limit. |

See [Security](security.md) for the rules about `http://` endpoints.
