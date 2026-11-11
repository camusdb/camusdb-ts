# C# extensions

The server can run C# code as stored procedures, row triggers, and scalar functions. The code comes from an extension assembly (a .NET DLL that the operator installs on the server), or from an [inline function](#inline-functions) in the SQL. The driver needs no setup.

## Procedures

Run a procedure with `CALL`. A procedure returns no rows. `execute` gives the number of rows that the procedure changed:

```ts
const { affectedRows } = await client.execute('CALL transfer(@from, @to, @amount)', {
  from: 'alice',
  to: 'bob',
  amount: 30,
});
```

`call` writes the `CALL` statement for you. It puts the parameters in the order of the object keys, because a procedure takes its arguments by position:

```ts
await client.call('transfer', { from: 'alice', to: 'bob', amount: 30 });
// runs CALL transfer(@from, @to, @amount)
```

- The procedure name must be a letter or `_`, then letters, digits, or `_`. Other names throw `TypeError`.
- A parameter name must be ASCII letters, digits, or `_`, with an optional `@` first. Other names throw `CADB0400`.
- JavaScript puts a key that is a whole number, such as `'0'`, before the other keys. So use names, not numbers.
- A procedure has input parameters only. It has no output parameters and no return value.
- `query`, `queryOne`, `scalar`, and `queryStream` also accept `CALL`. The result has no rows.
- `CALL` runs in the `transaction` option, if you give one. An error rolls back all writes of the procedure.
- `CALL` needs a superuser.

## Triggers

`CREATE TRIGGER` and `DROP TRIGGER` are DDL:

```ts
await client.execute(
  "CREATE TRIGGER audit ON orders AFTER INSERT, UPDATE, DELETE EXTERNAL NAME 'MyCompany.Ext.AuditTrigger'",
);
```

## Extension functions

Call an extension function as a built-in function: `SELECT slugify(title) FROM posts`.

- `SHOW EXTENSIONS` lists the assemblies of a node. It needs a superuser.
- `CREATE EXTENSION`, `ALTER EXTENSION`, and `DROP EXTENSION` are DDL.

## Inline functions

An inline function is a scalar function whose C# body is in `CREATE FUNCTION`, between dollar quotes (`$$ … $$`). You install no DLL.

- The user needs the `CREATE` privilege on the database.
- The server setting `inline_functions_enabled` must be `true`.

```ts
await client.execute(`
  CREATE OR REPLACE FUNCTION slugify(s STRING) RETURNS STRING LANGUAGE csharp AS $$
      return s.Trim().ToLowerInvariant().Replace(' ', '-');
  $$`);

const posts = await client.query('SELECT slugify(title) AS slug FROM posts');
```

- `CREATE [OR REPLACE] FUNCTION`, `DROP FUNCTION`, and `ALTER FUNCTION ... OWNER TO` are DDL. Use `execute`. A pipeline refuses them.
- The driver sends the body as you write it. If the body contains `$$`, use a tagged quote: `$fn$ ... $fn$`.
- In a JavaScript template literal, `$$` needs no escape. Only `${` starts a substitution.
- `SHOW FUNCTIONS` and `SHOW CREATE FUNCTION name` return rows.
- With `traceQueryText: 'sanitized'`, the body shows as `?` in `db.query.text`.
- Types: `INT64`, `FLOAT64`, `FLOAT32`, `BOOL`, `STRING`, `UUID`, `BYTES`, `DATETIME`, `NUMERIC`, and `ARRAY(E)`. See [Data types](data-types.md).

## Error codes

The driver retries none of these codes.

| Code | Meaning |
| --- | --- |
| `CADB0817` | This node does not have the extension of the trigger, or has a different build of it. |
| `CADB0818` | A trigger threw an exception. |
| `CADB0822` | A procedure threw an exception. |
| `CADB0809` | An inline function threw an exception. |
| `CADB0838` | The inline function body does not compile. |
| `CADB0839` | The body uses a type or a member that is not allowed. |
| `CADB0840` | A call used too much time, memory, array space, or stack. |
| `CADB0841` | Inline functions are off on the server. |
| `CADB0842` | A function with that name exists. |
| `CADB0843` | No function has that name. |
| `CADB0844` | A view or a `CHECK` uses the function. |
| `CADB0845` | This node cannot compile the function. |

After a serializable conflict, the server can run a statement again. So a trigger or a procedure can run more than one time. See `docs/csharp-extensions.md` in the server repository for all rules.
