import { defineConfig } from 'vitest/config';

/**
 * Vitest config for integration tests (live Postgres required).
 *
 * Setup before running:
 *   1. docker compose up -d postgres
 *   2. createdb getbeyond_test  (or any name containing 'test')
 *   3. DATABASE_URL=postgresql://postgres:postgres@localhost:5432/getbeyond_test \
 *        pnpm --filter '@getbeyond/api' prisma:migrate
 *   4. DATABASE_URL=postgresql://postgres:postgres@localhost:5432/getbeyond_test \
 *        pnpm --filter '@getbeyond/api' test:integration
 *
 * Coverage is NOT collected here — integration tests verify integration
 * behavior, not coverage. The unit-test suite is the coverage gate.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    exclude: ['node_modules', 'dist'],
    // Postgres + Prisma round-trips dominate; 30s lets the 10-concurrent
    // upsert test settle even on slow machines without false failures.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Serialize to avoid two integration files truncating shared tables out
    // from under each other when the suite grows beyond one file.
    fileParallelism: false,
  },
});
