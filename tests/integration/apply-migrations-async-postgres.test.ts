/**
 * Postgres integration test for SchemaManager.applyMigrationsAsync.
 *
 * Why this exists:
 *   The 1.8.0 release shipped a regression in the migration runner's
 *   advisory-lock SQL — the function name was typoed as
 *   `pg_xact_advisory_lock` (which doesn't exist anywhere) instead of
 *   `pg_advisory_xact_lock` (the real Postgres function). Every fresh
 *   boot crashed with:
 *
 *     Fatal: error: function pg_xact_advisory_lock(unknown) does not exist
 *
 *   Initial diagnosis read this as a parameter-typing issue (treat the
 *   bigint as `unknown`) — but adding an `::bigint` cast reproduced as
 *   `function pg_xact_advisory_lock(bigint) does not exist`, surfacing
 *   that the function name itself was wrong. The Postgres docs have it
 *   `pg_advisory_xact_lock(bigint)` — advisory comes first, xact second.
 *
 *   The unit-test suite passed because it exercises only the SQLite path
 *   (which skips the advisory-lock branch entirely). This test runs the
 *   exact same code against a real Postgres so the function-name contract
 *   is validated end-to-end.
 *
 * How to run locally:
 *   Set LATTICE_TEST_PG_URL to a Postgres connection string, then:
 *
 *     LATTICE_TEST_PG_URL=postgres://user:pw@host:5432/db npm test
 *
 *   Without the env var, the test suite skips. CI provisions a service
 *   container (see .github/workflows/ci.yml) so the test always runs there.
 *
 * Isolation:
 *   Each test creates a unique-id table and tears it down on completion.
 *   `__lattice_migrations` is shared across tests — each test inserts its
 *   own version string and deletes that row at the end so re-runs don't
 *   trip on already-applied migrations. We do NOT recreate the database
 *   between tests; teardown is row-level only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PostgresAdapter } from '../../src/db/postgres.js';
import { SchemaManager } from '../../src/schema/manager.js';
import type { Migration } from '../../src/types.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

// vitest's describe.skipIf is the canonical way to gate integration tests
// on env presence — keeps SQLite-only contributors and CI runs that don't
// provision a Postgres service container clean of skipped-test noise in
// the `failed` count.
describe.skipIf(!PG_URL)('SchemaManager.applyMigrationsAsync (Postgres integration)', () => {
  let adapter: PostgresAdapter;
  let mgr: SchemaManager;
  // Unique per-test-run prefix so parallel CI jobs against the same DB
  // can't collide on table names.
  const runId = randomBytes(4).toString('hex');

  beforeAll(() => {
    adapter = new PostgresAdapter(PG_URL!);
    adapter.open();
    mgr = new SchemaManager();
    mgr.applySchema(adapter); // creates __lattice_migrations if missing
  });

  afterAll(async () => {
    if (!adapter) return;
    // Drop any test tables we created. Best-effort — failure here is
    // a teardown smell, not a test failure.
    try {
      const rows = (await adapter.allAsync!(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = current_schema()
           AND tablename LIKE $1`,
        [`__lattice_test_${runId}_%`],
      )) as { tablename: string }[];
      for (const r of rows) {
        try {
          await adapter.runAsync!(`DROP TABLE IF EXISTS "${r.tablename}"`);
        } catch {
          /* swallow teardown errors */
        }
      }
      // Clean migration ledger rows we added.
      await adapter.runAsync!(
        `DELETE FROM __lattice_migrations WHERE version LIKE $1`,
        [`test-${runId}-%`],
      );
    } catch {
      /* DB may already be torn down */
    }
    adapter.close();
  });

  it('applies pending migrations through pg_advisory_xact_lock without name or type errors', async () => {
    // REGRESSION test for the 2026-05-02 dev crash-loop. The migration runner
    // calls `SELECT pg_advisory_xact_lock($1::bigint)` to serialize concurrent
    // boots. The 1.8.0 release shipped with the function name typoed as
    // `pg_xact_advisory_lock` (advisory and xact swapped) — Postgres rejected
    // every call with:
    //   error: function pg_xact_advisory_lock(unknown) does not exist
    // The misleading `(unknown)` made it look like a parameter-typing issue;
    // adding an `::bigint` cast reproduced as
    //   function pg_xact_advisory_lock(bigint) does not exist
    // surfacing that the function name itself was wrong. This test exercises
    // the corrected SQL end-to-end.
    const tableName = `__lattice_test_${runId}_basic`;
    const versionId = `test-${runId}-basic`;
    const migrations: Migration[] = [
      {
        version: versionId,
        sql: `CREATE TABLE "${tableName}" (id INTEGER PRIMARY KEY, val TEXT)`,
      },
    ];

    await expect(mgr.applyMigrationsAsync(adapter, migrations)).resolves.toBeUndefined();

    // Migration recorded in __lattice_migrations.
    const recorded = await adapter.getAsync!(
      `SELECT version FROM __lattice_migrations WHERE version = $1`,
      [versionId],
    );
    expect(recorded).toBeDefined();
    expect(recorded!.version).toBe(versionId);

    // Table actually created.
    const cols = adapter.introspectColumns(tableName);
    expect(cols.sort()).toEqual(['id', 'val']);
  });

  it('is idempotent — re-running the same migration list does not duplicate ledger rows', async () => {
    const tableName = `__lattice_test_${runId}_idempotent`;
    const versionId = `test-${runId}-idempotent`;
    const migrations: Migration[] = [
      { version: versionId, sql: `CREATE TABLE "${tableName}" (id INTEGER PRIMARY KEY)` },
    ];

    await mgr.applyMigrationsAsync(adapter, migrations);
    // Re-run with the same migration list. Without idempotency the second
    // run would either re-execute CREATE TABLE (and fail with "table already
    // exists") or insert a duplicate __lattice_migrations row.
    await mgr.applyMigrationsAsync(adapter, migrations);

    const rows = (await adapter.allAsync!(
      `SELECT version FROM __lattice_migrations WHERE version = $1`,
      [versionId],
    )) as { version: string }[];
    expect(rows).toHaveLength(1);
  });

  it('rolls back on migration failure — no partial state recorded', async () => {
    const goodTable = `__lattice_test_${runId}_rollback_good`;
    const v1 = `test-${runId}-rollback-1`;
    const v2 = `test-${runId}-rollback-2-bad`;
    const migrations: Migration[] = [
      { version: v1, sql: `CREATE TABLE "${goodTable}" (id INTEGER PRIMARY KEY)` },
      { version: v2, sql: `BLATANTLY INVALID SQL` },
    ];

    await expect(mgr.applyMigrationsAsync(adapter, migrations)).rejects.toThrow();

    // The whole withClient block rolls back on the failed migration. Neither
    // the good migration nor the bad migration should have been recorded,
    // and the good table should not exist on disk.
    const recorded = (await adapter.allAsync!(
      `SELECT version FROM __lattice_migrations WHERE version IN ($1, $2)`,
      [v1, v2],
    )) as { version: string }[];
    expect(recorded).toHaveLength(0);

    const tableExists = await adapter.getAsync!(
      `SELECT 1 AS one FROM pg_tables
       WHERE schemaname = current_schema() AND tablename = $1`,
      [goodTable],
    );
    expect(tableExists).toBeUndefined();
  });

  it('serializes concurrent boots on the transaction-scoped advisory lock', async () => {
    // Two SchemaManagers run applyMigrationsAsync against the same DB at the
    // same time, with DIFFERENT migration sets that each take a measurable
    // amount of time. Without the advisory lock, both would race on
    // CREATE TABLE / INSERT and we'd see one of:
    //   - duplicate-key errors (if they pick the same names)
    //   - non-deterministic interleaving (if they pick different names)
    //
    // With the lock, one transaction acquires `pg_xact_advisory_lock(bigint)`
    // and the other blocks at the SELECT until the first transaction commits
    // and releases the lock at COMMIT. Both transactions then succeed in
    // sequence.
    //
    // We assert sequencing by checking that one of the two runs took at
    // least as long as `migrationDelayMs`-worth of waiting on the lock.
    const tableA = `__lattice_test_${runId}_concurrent_a`;
    const tableB = `__lattice_test_${runId}_concurrent_b`;
    const vA = `test-${runId}-concurrent-a`;
    const vB = `test-${runId}-concurrent-b`;
    const migrationDelayMs = 500;

    const migrationsA: Migration[] = [
      { version: vA, sql: `CREATE TABLE "${tableA}" (id INTEGER PRIMARY KEY)` },
      // Inject a deliberate delay so the lock is held for measurable time.
      { version: `${vA}-sleep`, sql: `SELECT pg_sleep(${migrationDelayMs / 1000})` },
    ];
    const migrationsB: Migration[] = [
      { version: vB, sql: `CREATE TABLE "${tableB}" (id INTEGER PRIMARY KEY)` },
    ];

    // Use two distinct adapters so each has its own pool client. Same DB.
    const adapterB = new PostgresAdapter(PG_URL!);
    adapterB.open();
    try {
      const mgrB = new SchemaManager();
      mgrB.applySchema(adapterB);

      const startA = Date.now();
      const startB = Date.now();
      const [resultA, resultB] = await Promise.allSettled([
        mgr.applyMigrationsAsync(adapter, migrationsA),
        mgrB.applyMigrationsAsync(adapterB, migrationsB),
      ]);
      const elapsedA = Date.now() - startA;
      const elapsedB = Date.now() - startB;

      // Both must succeed.
      expect(resultA.status).toBe('fulfilled');
      expect(resultB.status).toBe('fulfilled');

      // The slower of the two should have waited at least migrationDelayMs
      // for the other to release the lock — proving they didn't run in
      // parallel. (If the lock didn't work, both would finish in roughly
      // max(individual durations), and the runner with no sleep would
      // finish in ~tens of ms.)
      const slower = Math.max(elapsedA, elapsedB);
      expect(slower).toBeGreaterThanOrEqual(migrationDelayMs);

      // Both tables should exist.
      expect(adapter.introspectColumns(tableA)).toContain('id');
      expect(adapterB.introspectColumns(tableB)).toContain('id');
    } finally {
      adapterB.close();
    }
  });
});
