# Backups

Take online backups with the backup API of a node.

- A backup includes all databases of the server, not only the database of the client.
- With authentication on, the user must be a superuser.
- The backup API is REST only. A gRPC client must set `backupEndpoint` to the HTTP endpoint of the node.

```ts
const full = await client.backups.takeFullBackup();
const incremental = await client.backups.takeIncrementalBackup(full.backupId);
const coordinated = await client.backups.takeCoordinatedBackup(); // a cluster backup; send it to the coordinator node

const catalog = await client.backups.listBackups();
const chain = await client.backups.getChain(incremental.backupId);

const preview = await client.backups.previewGarbageCollection(); // what retention would delete
const run = await client.backups.collectGarbage(); // delete old backups and orphaned files
```

- **Check the chain.** An incremental backup needs all the backups before it. `getChain` lists them. Each entry has `isInvalid` and `invalidReason`.
- **Substitution.** `wasSubstituted` is `true` when the server took a different kind of backup. `substitutionReason` tells you why.
- **Restore.** A restore is an offline operator procedure. The driver cannot do it.
