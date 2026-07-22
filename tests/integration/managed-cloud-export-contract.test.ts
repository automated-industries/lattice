/**
 * Managed-cloud export contract.
 *
 * latticesql ships a multi-tenant / managed-cloud API: a deployment secures a
 * shared Postgres database as a cloud (RLS + per-cloud member group + ownership),
 * then serves the stock GUI per member. A managed-cloud deployment imports its
 * entry points from the PACKAGE INDEX (`latticesql`) — not internal modules — so
 * the export surface is a public contract: renaming or dropping one of these
 * symbols, or changing its shape, is a silent break for every managed-cloud
 * consumer even though the internal `cloud-*` behavior tests (which import from
 * `src/cloud/*`) stay green.
 *
 * This test pins that contract from the OUTSIDE:
 *   (1) the symbols a managed-cloud deployment consumes are exported from the
 *       index with the expected JS shape — portable, runs on every engine, so a
 *       refactor that drops an index re-export fails loudly here (the ESM/CJS
 *       verify in CI only checks `Lattice`);
 *   (2) their core runtime behavior on a real Postgres — `secureCloud` turns a
 *       plain DB into a locked-down cloud (RLS forced on public tables) and
 *       `memberGroupFor` names the per-cloud member group. Postgres-gated
 *       (skipped without LATTICE_TEST_PG_URL); the throwaway DATABASE is dropped
 *       in afterEach.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
// The point of this test: import the managed-cloud entry points the way a
// downstream deployment does — from the package index, NOT from src/cloud/*.
import { Lattice, registerNativeEntities, secureCloud, memberGroupFor } from '../../src/index.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const databases: string[] = [];
const dbs: Lattice[] = [];

function baseUrlForDb(dbname: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  return u.toString();
}

afterEach(async () => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* best-effort */
    }
  }
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  await admin.end();
});

describe('managed-cloud export contract (index surface)', () => {
  it('re-exports the managed-cloud entry points from the package index with the expected shape', () => {
    // A managed-cloud deployment does exactly: `import { Lattice,
    // registerNativeEntities, secureCloud, memberGroupFor } from 'latticesql'`.
    // Assert each is present with the right JS type so a rename/removal in a
    // refactor breaks HERE (portable — this runs on SQLite CI too) rather than
    // only in the downstream build.
    expect(typeof Lattice, 'Lattice (class) must be exported from the index').toBe('function');
    expect(
      typeof registerNativeEntities,
      'registerNativeEntities must be exported from the index',
    ).toBe('function');
    expect(typeof secureCloud, 'secureCloud must be exported from the index').toBe('function');
    expect(typeof memberGroupFor, 'memberGroupFor must be exported from the index').toBe(
      'function',
    );
    // secureCloud + memberGroupFor are async (the deployment awaits them during
    // provisioning / per-member grant reconciliation).
    expect(secureCloud.constructor.name).toBe('AsyncFunction');
    expect(memberGroupFor.constructor.name).toBe('AsyncFunction');
  });

  it.skipIf(!PG_URL)(
    'secureCloud forces RLS on public tables and memberGroupFor names the member group',
    async () => {
      const dbname = `lattice_mce_${randomBytes(4).toString('hex')}`;
      databases.push(dbname);
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();

      const ownerDb = new Lattice(baseUrlForDb(dbname), { encryptionKey: 'export-contract-key' });
      dbs.push(ownerDb);
      registerNativeEntities(ownerDb);
      ownerDb.define('widget', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
        render: () => '',
        outputFile: 'widget.md',
      });
      await ownerDb.init();

      // The core provisioning behavior a deployment relies on: turn a plain DB
      // into a secured cloud. Must not throw on Postgres.
      await secureCloud(ownerDb);

      // memberGroupFor names the per-cloud member group — a stable, per-database
      // role name the deployment grants members into.
      const group = await memberGroupFor(ownerDb);
      expect(typeof group).toBe('string');
      expect(group).toMatch(/^lattice_m_[0-9a-f]{20}$/);

      // Behavior assertion: RLS is forced on a user table (relrowsecurity +
      // relforcerowsecurity), which is what denies the PostgREST anon/authed
      // roles while the app's BYPASSRLS owner connection is unaffected.
      const probe = new pg.Pool({ connectionString: baseUrlForDb(dbname), max: 1 });
      try {
        const { rows } = await probe.query<{ rls: boolean; force: boolean }>(
          `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = 'widget'`,
        );
        expect(rows.length).toBe(1);
        expect(rows[0].rls, 'secureCloud must enable RLS on public tables').toBe(true);
        expect(rows[0].force, 'secureCloud must FORCE RLS on public tables').toBe(true);
      } finally {
        await probe.end();
      }
    },
  );
});
