import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
        'src/lifecycle/index.ts',
      ],
      thresholds: {
        lines: 80,
      },
    },
  },
});
