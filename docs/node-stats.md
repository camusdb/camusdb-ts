# Node stats

`client.nodeStats()` gives the disk, CPU, and memory of one node, over REST or gRPC.

```ts
const stats = await client.nodeStats(); // the next endpoint of the pool
const data = stats.dataVolume!;          // the disk that holds the data

console.log(`${data.availableBytes} bytes free of ${data.totalBytes}`);
console.log(`writes refused: ${data.belowWatermark}`);

for (const endpoint of client.endpoints) {
  const node = await client.nodeStats(endpoint); // one call for each node
  console.log(`${node.address}: ${node.cpu.processCpuPercent}% CPU`);
}
```

- **One node.** Each call reports one node. `address` is the endpoint that answered.
- **Listed endpoints only.** `nodeStats(endpoint)` accepts only an endpoint from `client.endpoints`. Other endpoints throw `TypeError`.
- **`-1` is unknown.** A value that the node cannot read is `-1`, and `errors` tells you why. An older server sends no value for some fields, and these are `-1` too.
- **`belowWatermark`.** When it is `true`, the free disk is below `min_free_disk_bytes`, and writes on that node fail with `CADB0536`.
- **Privilege.** With authentication on, the user needs the superuser attribute or the `MONITOR` privilege: `GRANT MONITOR ON *.* TO monitoring;`. Other users get `CADB0517`.
- **Cost.** The call is cheap. You can call it each minute.
