import type { Lattice } from '../lattice.js';
import {
  installCloudRls,
  enableChangelogRls,
  enableRlsForTable,
  backfillOwnership,
  MEMBER_GROUP,
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
/**
 * Secure ONE user table on a cloud: stamp current-role ownership of existing
 * rows, FORCE per-row RLS, and (re)build the audience cell-masking view. Idempotent
 * + additive. The per-table half of {@link secureCloud}, factored out so tables
 * created at RUNTIME (data-model panel / assistant / ingest) are secured the same
 * way — otherwise a runtime table on a secured cloud has RLS OFF (wide open).
 * `backfillOwnership` runs BEFORE `enableRlsForTable` so a non-superuser owner can
 * still SELECT every row to stamp it before FORCE RLS filters the table. No-op on
 * SQLite, on bookkeeping tables, or on an unkeyable table.
 */
export async function secureNewCloudTable(
  db: Lattice,
  table: string,
  pk: readonly string[],
): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  if (table.startsWith('__lattice_') || table.startsWith('_lattice_')) return;
  if (pk.length === 0) return;
  await backfillOwnership(db, table, pk);
  await enableRlsForTable(db, table, pk);
  const cols = db.getRegisteredColumns(table);
  if (cols) {
    await seedColumnPolicyFromYaml(db, table, db.getColumnAudience(table));
    await regenerateAudienceViewFromDb(db, table, Object.keys(cols), pk);
  }
}

export async function secureCloud(db: Lattice): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  await installCloudRls(db);
  await installCloudSettings(db);
  await db.ensureObservationSubstrate();
  await enableChangelogRls(db);
  const registered = db.getRegisteredTableNames();
  for (const table of registered) {
    await secureNewCloudTable(db, table, db.getPrimaryKey(table));
  }
  // `secrets` is never shareable by default (a private-only table): the share/grant
  // functions refuse it and new rows are forced private, at the data-model level.
  if (registered.includes('secrets')) {
    await runAsyncOrSync(db.adapter, `SELECT lattice_set_table_never_share('secrets', true)`);
  }
  // GUI-direct system table grant. The per-table loop above skips every
  // `__lattice_*` table, but `__lattice_user_identity` is the one such table a
  // member reads/writes DIRECTLY on connect (gui/server.ts + userconfig-routes.ts)
  // to record "who is sitting here". Without this grant a member hits
  // "permission denied for table __lattice_user_identity" and cannot drive the
  // GUI at all. Idempotent; re-securing an existing cloud retro-applies it.
  // NOTE: it is a single `id='singleton'` row mirroring the connecting user, so
  // concurrent members currently clobber it — a follow-up should re-key it per
  // role (id = current_user) with own-row RLS. The grant is the blocker fix.
  //
  // The GUI creates `__lattice_user_identity` at workspace-open, which runs
  // BEFORE the owner triggers secureCloud — so in the app path it exists here. A
  // library-only cutover (no GUI) has no such table, so grant only when present;
  // the cutover stays a single idempotent call either way.
  await runAsyncOrSync(
    db.adapter,
    `DO $LATTICE$ BEGIN
       IF to_regclass('__lattice_user_identity') IS NOT NULL THEN
         EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "__lattice_user_identity" TO ${MEMBER_GROUP}';
       END IF;
     END $LATTICE$`,
  );
}
