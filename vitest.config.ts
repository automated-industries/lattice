import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Provision a disposable Postgres for the `*-postgres.test.ts` suite when no
    // LATTICE_TEST_PG_URL is set and we're not in CI (see tests/setup/). CI's
    // real `postgres:16` service and an explicitly-set URL are used untouched.
    globalSetup: ['./tests/setup/pg-global-setup.ts'],
    setupFiles: ['./tests/setup/pg-env.ts'],
    // Many integration tests boot a full GUI server (sometimes two); under v8
    // coverage instrumentation + parallel worker contention a single boot can
    // approach the 5s default and flake. 15s gives real headroom while still
    // surfacing a genuine hang reasonably fast.
    testTimeout: 15_000,
    // Cloud integration hooks are heavy (boot a GUI server, then secure a cloud:
    // install RLS + mint roles). Under local parallelism against one Postgres
    // they need more than the 10s default; 30s is headroom, not a mask.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**'],
      exclude: [
        'src/index.ts',
        'src/types.ts',
        'src/cli.ts',
        'src/schema/entity-context.ts',
        'src/config/types.ts',
        'src/db/adapter.ts',
        // The library AI client is the lazy-loaded real @anthropic-ai/sdk glue:
        // its createLlmClient()/defaultSender() only run with a real key + the
        // SDK installed, so they can't execute in the harness (same rationale as
        // direct-ops.ts above). The logic that BUILDS on it — organize / vision
        // / crawl / enrich — is unit-tested with injected senders; the live SDK
        // round-trip is exercised by the LATTICE_LIVE_LLM-gated specs.
        'src/ai/llm-client.ts',
      ],
      thresholds: {
        lines: 80,
      },
    },
  },
});
