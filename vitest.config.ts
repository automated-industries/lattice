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
        'src/teams/cli-commands.ts',
        'src/schema/entity-context.ts',
        'src/config/types.ts',
        'src/db/adapter.ts',
        'src/lifecycle/index.ts',
        // direct-ops.ts implements the postgres:// branch of each cloud
        // team operation by opening `new Lattice(cloudUrl)` against the
        // operator's cloud Postgres. The branches can't run against the
        // SQLite-backed test harness — they throw immediately on URL
        // validation. The dispatchers that route to these functions are
        // covered by `tests/unit/teams-dispatch.test.ts`; the SQL
        // behaviour itself is exercised manually against a real cloud
        // Postgres at release time.
        'src/teams/direct-ops.ts',
        // Same story: `registerDirectViaPostgres` is the postgres://
        // branch of `register`, gated on a real Postgres connection.
        'src/teams/register-direct.ts',
        // Team-cloud ownership glue (resolveTeamContext / isVisibleInTeam /
        // shareEntityWithTeam). These only run when the active GUI database
        // is a team-enabled postgres:// cloud — they open/query the cloud
        // directly and short-circuit against the SQLite test harness, same
        // as direct-ops.ts. The pure ownership helpers they build on are
        // unit-tested in tests/integration/direct-ops.test.ts; the SQL
        // behaviour is exercised manually against a real cloud at release.
        'src/gui/team-context.ts',
      ],
      thresholds: {
        lines: 80,
      },
    },
  },
});
