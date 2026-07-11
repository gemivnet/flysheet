import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    globalSetup: './test/global-setup.ts',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
  },
});
