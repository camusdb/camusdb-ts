import { defineConfig } from 'vitest/config';

/**
 * The suite that runs against a real CamusDB server.
 *
 * It runs its cases one file at a time, and one case at a time, because they share a database and a
 * server: two cases creating a table at once would contend on the same schema lock and report a
 * transient failure that says nothing about the driver.
 */
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    retry: 0,
  },
});
