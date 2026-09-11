/**
 * The shortest useful program: connect, create a table, write, and read.
 *
 * Run it against a local CamusDB with:
 *
 *   npx tsx examples/basic.ts
 */

import { CamusClient, CamusObjectId } from '../src/index.js';

interface Robot {
  id: string;
  name: string;
  type: string;
  year: number;
  price: number;
  enabled: boolean;
}

const client = new CamusClient({
  endpoint: process.env.CAMUS_ENDPOINT ?? 'http://localhost:8082',
  database: process.env.CAMUS_DATABASE ?? 'test',
});

await client.createDatabase(undefined, { ifNotExists: true });

await client.executeDdl(`
  CREATE TABLE IF NOT EXISTS robots (
    id ID PRIMARY KEY,
    name STRING NOT NULL,
    type STRING NOT NULL,
    year INT64 NOT NULL,
    price FLOAT64 NOT NULL,
    enabled BOOL NOT NULL
  )
`);

// A bound value never becomes SQL text, so it cannot change what the statement means.
const inserted = await client.execute(
  `INSERT INTO robots (id, name, type, year, price, enabled)
   VALUES (@id, @name, @type, @year, @price, @enabled)`,
  {
    id: CamusObjectId.generateAsString(),
    name: 'r1',
    type: 'mechanical',
    year: 1974,
    price: 1500.5,
    enabled: true,
  },
);

console.log(`inserted ${String(inserted.affectedRows)} row(s)`);

const { rows, columns } = await client.query<Robot>(
  'SELECT id, name, type, year, price, enabled FROM robots WHERE year >= @year',
  { year: 1970 },
);

console.log(columns.map((column) => `${column.name}: ${column.typeName}`).join(', '));

for (const robot of rows) {
  console.log(`${robot.name} (${robot.type}, ${String(robot.year)}) — ${String(robot.price)}`);
}

const total = await client.scalar<number>('SELECT COUNT(*) FROM robots');

console.log(`total: ${String(total)}`);

await client.close();
