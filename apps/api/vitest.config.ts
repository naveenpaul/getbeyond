import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: ['node_modules', 'dist', '**/*.e2e-spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/**/*.module.ts',
        'src/**/dto/**',
        'src/**/__generated__/**',
        'prisma/generated/**',
        'src/**/*.spec.ts',
        'src/**/*.e2e-spec.ts',
        // Framework wiring around a third-party library client. After the
        // applyOrgScope() extraction, this file is constructor + NestJS
        // lifecycle hooks + a thin $extends() delegation. The substantive
        // logic lives in org-scope.ts (100% covered). End-to-end behavior
        // (does scoped() actually inject orgId at runtime?) lands as an
        // integration test when T1 brings up a real DB in CI.
        'src/common/prisma/prisma.service.ts',
      ],
      thresholds: {
        // CLAUDE.md: 95%+ line coverage on logic files.
        // PR merge is blocked below threshold via CI workflow.
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
      reportOnFailure: true,
    },
  },
});
