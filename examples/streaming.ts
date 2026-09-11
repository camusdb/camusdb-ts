/**
 * A result too large to hold in memory, read one row at a time.
 *
 * Run it against a local CamusDB with:
 *
 *   npx tsx examples/streaming.ts
 */

import { CamusClient, CamusObjectId } from '../src/index.js';

const client = new CamusClient({
  endpoint: process.env.CAMUS_ENDPOINT ?? 'http://localhost:8082',
  database: process.env.CAMUS_DATABASE ?? 'test',
});

await client.executeDdl(`
  CREATE TABLE IF NOT EXISTS events (
    id ID PRIMARY KEY,
    kind STRING NOT NULL,
    at DATETIME NOT NULL
  )
`);

for (let i = 0; i < 200; i++) {
  await client.insert('events', {
    id: CamusObjectId.generateAsString(),
    kind: i % 2 === 0 ? 'read' : 'write',
    at: new Date(),
  });
}

interface Event {
  id: string;
  kind: string;
  at: Date;
}

// `await using` releases the response even if the loop leaves early or throws.
await using stream = await client.queryStream<Event>('SELECT id, kind, at FROM events WHERE kind = @kind', {
  kind: 'write',
});

// The schema is known before the first row arrives.
console.log(stream.columns.map((column) => column.name).join(', '));

let counted = 0;

for await (const event of stream) {
  counted++;

  if (counted <= 3) console.log(event.id, event.kind, event.at.toISOString());
  if (counted >= 50) break;
}

console.log(`read ${String(counted)} row(s) without holding the whole result`);

await client.close();
