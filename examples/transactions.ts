/**
 * Money moves between two accounts, atomically, with a retry that is safe to run twice.
 *
 * Run it against a local CamusDB with:
 *
 *   npx tsx examples/transactions.ts
 */

import { CamusClient, CamusError, CamusLocking, CamusObjectId } from '../src/index.js';

const client = new CamusClient({
  endpoint: process.env.CAMUS_ENDPOINT ?? 'http://localhost:8082',
  database: process.env.CAMUS_DATABASE ?? 'test',
});

await client.executeDdl(`
  CREATE TABLE IF NOT EXISTS accounts (
    id ID PRIMARY KEY,
    owner STRING NOT NULL,
    balance INT64 NOT NULL
  )
`);

const from = CamusObjectId.generateAsString();
const to = CamusObjectId.generateAsString();

await client.insert('accounts', { id: from, owner: 'alice', balance: 1000 });
await client.insert('accounts', { id: to, owner: 'bob', balance: 0 });

/**
 * The unit of work runs again from the start after a lost conflict, so it must be safe to run more
 * than once. Reading and writing the database is; sending an email would not be.
 */
async function transfer(amount: number): Promise<void> {
  await client.transaction(
    async (txn) => {
      const source = await client.queryOne<{ balance: number }>(
        'SELECT balance FROM accounts WHERE id = @id',
        { id: from },
        { transaction: txn },
      );

      if (source === undefined) throw new Error('the source account is gone');
      if (source.balance < amount) throw new Error('not enough balance');

      await client.execute(
        'UPDATE accounts SET balance = balance - @amount WHERE id = @id',
        { amount, id: from },
        { transaction: txn },
      );

      await client.execute(
        'UPDATE accounts SET balance = balance + @amount WHERE id = @id',
        { amount, id: to },
        { transaction: txn },
      );
    },
    {
      maxAttempts: 5,
      transactionOptions: { locking: CamusLocking.Optimistic },
    },
  );
}

await transfer(250);

const balances = await client.query<{ owner: string; balance: number }>(
  'SELECT owner, balance FROM accounts WHERE id IN (@from, @to)',
  { from, to },
);

console.log(balances.rows);

// A transaction that does not fit in one function. `await using` rolls it back if the block leaves
// without a commit.
{
  await using txn = await client.beginTransaction();

  await client.execute(
    'UPDATE accounts SET balance = balance + 1 WHERE id = @id',
    { id: to },
    { transaction: txn },
  );

  await txn.commit();
}

try {
  await transfer(1_000_000);
} catch (error) {
  console.log('refused:', error instanceof Error ? error.message : String(error));

  if (CamusError.is(error)) console.log('code:', error.code);
}

await client.close();
