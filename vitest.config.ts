import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 10000,
    // Tests that touch ~/.ag/memory.md (global state) must not run in parallel
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/cli.ts', 'src/cli/**'],
      thresholds: {
        // Per-file thresholds for tested modules; global thresholds stay achievable
        statements: 20,
        branches: 15,
        functions: 20,
        lines: 20,
      },
    },
  },
});
