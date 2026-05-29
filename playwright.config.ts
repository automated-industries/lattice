import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level tests for the `lattice gui` SPA. Each spec boots its own
 * in-process `startGuiServer({ port: 0 })` against a temp SQLite config (see
 * tests/e2e/helpers.ts) — there is no shared `webServer`, so specs are fully
 * isolated and need no external services or LLM keys.
 *
 * e2e specs are named `*.spec.ts` so vitest's `*.test.ts` glob never collects
 * them and Playwright never collects the vitest suite.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
