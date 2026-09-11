import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The live suite needs a running server, so it has a configuration and a command of its own.
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/transport/grpc/**'],
    },
  },
});
