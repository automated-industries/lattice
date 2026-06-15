import type { Lattice } from '../lattice.js';
import {
  installCloudRls,
  enableChangelogRls,
  enableRlsForTable,
  backfillOwnership,
  MEMBER_GROUP,
} from './rls.js';
import { installCloudSettings } from './settings.js';
import {
  seedColumnPolicyFromYaml,
  regenerateAudienceViewFromDb,
  tableNeedsAudienceView,
} from './audience.js';
import { NATIVE_INTERNAL_NAMES } from '../framework/native-entities.js';
import { allAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';

/**
 * Tables that are PRIVATE to their owner on a cloud and must never be bulk-shared:
 * the assistant's internal conversation storage (so one member's chat can never
 * reach another) plus `secrets`. Forced `never_share` on every secure/owner open.
 */
const PRIVATE_ONLY_TABLES: readonly string[] = [...NATIVE_INTERNAL_NAMES, 'secrets'];

/**
 * Converge per-table member ACCESS on a cloud — ungated and with NO data-row
 * scans (so it is safe to run on every owner open, not just the one-time secure
 * cutover). It self-heals two drift classes the version-gated per-table securing
 * (`enableRlsForTable`, recorded as `internal:cloud-rls:table:<t>:v3`) cannot:
 *
 *  1. PRIVACY — force `never_share` on {@link PRIVATE_ONLY_TABLES}. The assistant's
 *     `chat_threads`/`chat_messages` are per-author private; without this a bulk
 *     "share everything" (or a restore that stamped them `everyone`) exposes one
 *     member's chat to the whole team. Idempotent: re-privatizes only rows still
 *     shared.
 *  2. GRANTS — re-issue the member-group GRANT for every RLS-secured user table.
 *     A migration/restore that recorded the per-table securing migration but
 *     dropped the GRANT (e.g. a `pg_dump --no-privileges` round-trip) otherwise
 *     leaves members unable to read a table that still shows as shared. Granting
 *     is limited to RLS-secured tables so it can never widen a non-RLS table.
 *
 * No-op off Postgres.
 */
export async function reconcileCloudMemberAccess(db: Lattice): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  const registered = db.getRegisteredTableNames();

  // (1) Private-only tables stay never_share (per-owner) on every open.
  for (const t of PRIVATE_ONLY_TABLES) {
    if (!registered.includes(t)) continue;
    await runAsyncOrSync(
      db.adapter,
      `SELECT lattice_set_table_never_share('${t.replace(/'/g, "''")}', true)`,
    );
  }

  // (2) Re-issue member grants for every RLS-secured user table (ungated). Only
  // RLS-on tables are granted, so a table that isn't yet secured can never be
  // accidentally opened wide to members here.
  const rlsRows = (await allAsyncOrSync(
    db.adapter,
    `SELECT c.relname AS name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relrowsecurity`,
  )) as { name: string }[];
  const rlsOn = new Set(rlsRows.map((r) => r.name));

  for (const table of registered) {
    if (table.startsWith('__lattice_') || table.startsWith('_lattice_')) continue;
    if (!rlsOn.has(table)) continue;
    if (db.getPrimaryKey(table).length === 0) continue;
    const q = `"${table.replace(/"/g, '""')}"`;
    const masked = tableNeedsAudienceView(db.getColumnAudience(table));
    if (masked) {
      // Member reads the cell-masking view; base SELECT stays revoked.
      const v = `"${`${table}_v`.replace(/"/g, '""')}"`;
      await runAsyncOrSync(db.adapter, `GRANT SELECT ON ${v} TO ${MEMBER_GROUP}`);
      await runAsyncOrSync(db.adapter, `GRANT INSERT, UPDATE, DELETE ON ${q} TO ${MEMBER_GROUP}`);
    } else {
      await runAsyncOrSync(
        db.adapter,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${q} TO ${MEMBER_GROUP}`,
      );
    }
  }
}

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
  // Private-only tables (`secrets` + the assistant's internal chat tables) are
  // forced never_share, and member grants are reconciled, here too — so the
  // one-time secure cutover lands the same access state an owner open converges to.
  await reconcileCloudMemberAccess(db);
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
