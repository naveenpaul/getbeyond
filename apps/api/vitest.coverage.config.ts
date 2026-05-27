import { defineConfig } from 'vitest/config';

/**
 * Combined coverage config: unit + integration in one run.
 *
 * Why this exists separately from vitest.config.ts:
 *   - Unit tests run fast (<3s, no DB). Devs run them on every save.
 *   - Integration tests need a live Postgres + 30s timeouts + serial
 *     execution (TRUNCATE pattern doesn't tolerate parallel file workers).
 *   - Coverage must reflect BOTH: pure-logic files are unit-tested, but
 *     controllers / services / workers / auth wiring are integration-tested.
 *     A unit-only coverage gate forces fake unit tests against mocks, which
 *     tests the mocks instead of the system. The combined gate measures
 *     what's actually verified end-to-end.
 *
 * CLAUDE.md mandates 95%+ line coverage. Per the project guidance, the
 * exclude list calls out files whose runtime behavior is verified by
 * integration tests with a one-line rationale — same convention as
 * vitest.config.ts. We do NOT exclude controllers / services / workers
 * here, because they're now part of the combined run.
 *
 * Setup before running:
 *   1. docker compose up -d postgres
 *   2. createdb getbeyond_test
 *   3. DATABASE_URL=postgresql://postgres:postgres@localhost:5432/getbeyond_test \
 *        pnpm prisma:migrate deploy
 *   4. DATABASE_URL=... pnpm test:coverage
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.integration.spec.ts'],
    exclude: ['node_modules', 'dist', '**/*.e2e-spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests TRUNCATE shared tables in beforeEach. Two specs
    // running in parallel would wipe each other's fixtures mid-test.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        // Bootstrap entry; verified via E2E.
        'src/main.ts',
        // Module wiring — no business logic.
        'src/**/*.module.ts',
        // Decorator-only DTOs (existing convention).
        'src/**/dto/**',
        // Schema-only DTOs in module roots. These define Zod shapes + types
        // re-exported from @getbeyond/shared; the validation behavior is
        // exercised through controller integration tests.
        'src/modules/connectors/csv-import.dto.ts',
        'src/modules/connectors/hubspot-sync.dto.ts',
        'src/modules/invites/invites.dto.ts',
        'src/modules/teammates/researcher/researcher.dto.ts',
        'src/modules/teammates/sdr-drafter/sdr-drafter.dto.ts',
        // Pure type declarations — interface-only files have no runtime
        // surface to cover.
        'src/modules/teammates/runtime/agent-tool.ts',
        // Generated code.
        'src/**/__generated__/**',
        'prisma/generated/**',
        // Test scaffolding lives under src so it can import internals, but
        // it IS the test layer — excluding it from coverage of itself.
        'src/**/*.spec.ts',
        'src/**/*.e2e-spec.ts',
        'src/modules/auth/test-session.ts',
        // Framework wrapper around prisma client. The substantive logic
        // (applyOrgScope) is in org-scope.ts (100% covered). The wrapper's
        // $extends() delegation is verified by every integration spec that
        // exercises a tenant-scoped query.
        'src/common/prisma/prisma.service.ts',
        // pg-boss wrapper — framework wiring around a third-party client.
        // Verified end-to-end via worker integration tests (researcher,
        // sdr-drafter, hubspot-sync, csv-import, draft-action).
        'src/modules/queue/queue.service.ts',
        // S3/MinIO wrapper — framework wiring around @aws-sdk/client-s3.
        // Verified via the csv-import controller suite's S3-spill case
        // (real MinIO container).
        'src/modules/storage/storage.service.ts',
      ],
      thresholds: {
        // CLAUDE.md: 95%+ line coverage on logic files.
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
      reportOnFailure: true,
    },
  },
});
