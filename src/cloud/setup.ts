import type { Lattice } from '../lattice.js';
import {
  installCloudRls,
  enableChangelogRls,
  enableRlsForTable,
  backfillOwnership,
} from './rls.js';
import { installCloudSettings } from './settings.js';
import { seedColumnPolicyFromYaml, regenerateAudienceViewFromDb } from './audience.js';
import { runAsyncOrSync } from '../db/adapter.js';

/**
 * Turn a Postgres database into a secured Lattice cloud, in place: install the
 * RLS bootstrap + the observation substrate, then for every registered user
 * table stamp the current role as owner of the existing rows and force RLS (plus
 * a cell-masking view for any audience columns). Idempotent and additive — safe
 * to run on a fresh migration target OR on an already-populated Postgres that
 * isn't a cloud yet (the "secure this cloud" cutover). No-op on SQLite.
 *
 * Must run as a role that owns the tables and can create roles (a cloud
 * owner / DBA). `backfillOwnership` runs BEFORE `enableRlsForTable` so a
 * non-superuser owner can still SELECT every row to stamp it before FORCE RLS
 * filters the table to rows it already owns.
 */
export async function secureCloud(db: Lattice): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  await installCloudRls(db);
  await installCloudSettings(db);
  await db.ensureObservationSubstrate();
  await enableChangelogRls(db);
  const registered = db.getRegisteredTableNames();
  for (const table of registered) {
    // RLS bookkeeping + GUI-internal tables are definer-managed, not per-row RLS.
    if (table.startsWith('__lattice_') || table.startsWith('_lattice_')) continue;
    const pk = db.getPrimaryKey(table);
    if (pk.length === 0) continue; // unkeyable table — no per-row RLS
    await backfillOwnership(db, table, pk);
    await enableRlsForTable(db, table, pk);
    const cols = db.getRegisteredColumns(table);
    if (cols) {
      // Seed the YAML-declared audiences into the canonical __lattice_column_policy
      // (once), then build the mask view FROM the DB so it's cloud-canonical.
      await seedColumnPolicyFromYaml(db, table, db.getColumnAudience(table));
      await regenerateAudienceViewFromDb(db, table, Object.keys(cols), pk);
    }
  }
  // `secrets` is never shareable by default (a private-only table): the share/grant
  // functions refuse it and new rows are forced private, at the data-model level.
  if (registered.includes('secrets')) {
    await runAsyncOrSync(db.adapter, `SELECT lattice_set_table_never_share('secrets', true)`);
  }
}
