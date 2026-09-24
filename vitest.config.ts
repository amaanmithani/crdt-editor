import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The CLI entrypoint only wires env vars to startSyncServer (which is tested).
      exclude: ['src/server/main.ts', 'src/**/index.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 75, statements: 75, functions: 75, branches: 75 },
    },
  },
});
