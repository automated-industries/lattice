import type { Lattice } from '../lattice.js';
import {
  installCloudRls,
  enableChangelogRls,
  enableChatPrivacyRls,
  ownPolyfillsByGroup,
  enableRlsForTable,
  backfillOwnership,
} from './rls.js';
import { installCloudSettings } from './settings.js';
import {
  seedColumnPolicyFromYaml,
  regenerateAudienceViewFromDb,
  tableNeedsAudienceView,
} from './audience.js';
import {
  grantMemberTableAccessSql,
  grantMemberBookkeepingSql,
  grantMemberExecuteSql,
} from './member-access.js';
import { NATIVE_INTERNAL_NAMES } from '../framework/native-entities.js';
import { allAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import { registerPostgresPolyfills } from '../db/postgres.js';

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
/**
 * Outcome of {@link reconcileCloudMemberAccess}: the per-table converge is fault-
 * isolated, so a table the connecting role can't manage (e.g. created by a
 * different Postgres role) is SKIPPED with an actionable reason rather than
 * aborting the converge for every other table. `skipped` is empty on a clean run.
 */
export interface CloudMemberAccessReport {
  skipped: { table: string; reason: string }[];
}

/**
 * Turn a per-table converge failure into an actionable reason. An owner mismatch
 * ("must be owner of table X") is the common cause — a table created by a
 * different Postgres role than the one the workspace connects as — so name the
 * real owner, the connected role, and the exact ALTER that fixes it. Any other
 * error falls through to its raw message.
 */
async function explainTableFailure(db: Lattice, table: string, err: unknown): Promise<string> {
  const msg = err instanceof Error ? err.message : String(err);
  // An ALTER on a non-owned table says "must be owner of table X"; a GRANT/REVOKE
  // says "permission denied for table X". Both have the same root cause — the
  // connecting role doesn't own the table — so enrich either with the real owner.
  if (!/must be owner|permission denied/i.test(msg)) return msg;
  try {
    const rows = (await allAsyncOrSync(
      db.adapter,
      `SELECT pg_get_userbyid(c.relowner) AS owner, current_user AS me
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = ?`,
      [table],
    )) as { owner?: string; me?: string }[];
    const r = rows[0];
    if (r?.owner && r.me && r.owner !== r.me) {
      return `owned by Postgres role "${r.owner}", but this workspace connects as "${r.me}" — fix with: ALTER TABLE "${table.replace(/"/g, '""')}" OWNER TO "${r.me}";`;
    }
  } catch {
    /* introspection failed too — fall back to the raw message */
  }
  return msg;
}

export async function reconcileCloudMemberAccess(db: Lattice): Promise<CloudMemberAccessReport> {
  const skipped: { table: string; reason: string }[] = [];
  if (db.getDialect() !== 'postgres') return { skipped };
  const registered = db.getRegisteredTableNames();

  // Per-table fault isolation: a table the connecting role can't ALTER/GRANT
  // (e.g. owned by a different role) is recorded + skipped, never aborting the
  // converge for every OTHER table. Without this, one un-ownable table degraded
  // the whole workspace to "Failed to fetch".
  const tryTable = async (table: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      const reason = await explainTableFailure(db, table, e);
      skipped.push({ table, reason });
      console.warn(`[reconcileCloudMemberAccess] skipped "${table}": ${reason}`);
    }
  };

  // (1) Private-only tables stay never_share (per-owner) on every open.
  for (const t of PRIVATE_ONLY_TABLES) {
    if (!registered.includes(t)) continue;
    await tryTable(t, async () => {
      await runAsyncOrSync(
        db.adapter,
        `SELECT lattice_set_table_never_share('${t.replace(/'/g, "''")}', true)`,
      );
    });
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
    const masked = tableNeedsAudienceView(db.getColumnAudience(table));
    await tryTable(table, async () => {
      for (const sql of grantMemberTableAccessSql(table, { masked })) {
        await runAsyncOrSync(db.adapter, sql);
      }
    });
  }

  // (3) Bookkeeping tables a member reads/writes DIRECTLY (not via an RLS-secured
  // user table, so the loop above skips them) — GUI meta/audit, the identity row,
  // and the per-viewer-filtered changelog. Without these the member's GUI silently
  // degrades to read-only / "save as document". Derived from the central
  // MEMBER_READABLE_BOOKKEEPING registry (one source of truth, asserted by a
  // registry-driven test) and each grant is to_regclass-guarded + idempotent, so a
  // library-only cloud is a no-op and an already-migrated cloud self-heals on open.
  // OWNER_ONLY_BOOKKEEPING is intentionally NOT granted — those are reached only
  // through SECURITY DEFINER functions keyed on session_user.
  for (const sql of grantMemberBookkeepingSql()) {
    await runAsyncOrSync(db.adapter, sql);
  }

  // (4) Polyfill functions a member's queries depend on (the audit-table
  // strftime() default, audience json_extract()). The owner created them in
  // secureCloud; grant EXECUTE explicitly so a member never has to (and cannot,
  // post-revoke) CREATE them itself. Non-fatal: a library cloud that never
  // registered the polyfills simply has nothing to grant.
  try {
    await runAsyncOrSync(db.adapter, grantMemberExecuteSql());
  } catch (err) {
    console.warn(
      '[reconcileCloudMemberAccess] could not grant EXECUTE on polyfills (will retry next open):',
      err instanceof Error ? err.message : String(err),
    );
  }

  // (5) Schema convergence: 3.3.x soft-delete filters reads/counts with
  // `WHERE deleted_at IS NULL`, so a user entity table that lacks the column
  // (e.g. migrated from a pre-soft-delete SQLite) breaks the render and exact
  // counts. Add it idempotently to every user table missing it — owner-only
  // ALTER, matching the TEXT type new tables get (schema-ops.createUserEntity).
  for (const table of registered) {
    if (table.startsWith('__lattice_') || table.startsWith('_lattice_')) continue;
    const cols = db.getRegisteredColumns(table);
    if (cols && !('deleted_at' in cols)) {
      await tryTable(table, async () => {
        const q = `"${table.replace(/"/g, '""')}"`;
        await runAsyncOrSync(
          db.adapter,
          `ALTER TABLE ${q} ADD COLUMN IF NOT EXISTS "deleted_at" TEXT`,
        );
      });
    }
  }

  // (`__lattice_changelog` is granted via the MEMBER_READABLE_BOOKKEEPING registry
  // in step (3) — its per-viewer RLS policy, installed by `enableChangelogRls`,
  // filters reads so the base grant is safe, not a leak.)
  return { skipped };
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

/**
 * Neutralize any legacy/unrecognized column audience to 'owner' (strictly more
 * restrictive — never widens). The `role:` / `subject:` / `source:` column-audience
 * clauses were removed; a stray spec from an older build would otherwise make the
 * audience compiler throw and break that table's mask-view regeneration. Idempotent;
 * a no-op when the policy table or such rows are absent.
 */
async function convergeLegacyColumnAudience(db: Lattice): Promise<void> {
  await runAsyncOrSync(
    db.adapter,
    `DO $$ BEGIN
       IF to_regclass('__lattice_column_policy') IS NOT NULL THEN
         UPDATE "__lattice_column_policy" SET "audience" = 'owner'
          WHERE "audience" IS NOT NULL
            AND "audience" NOT IN ('', 'everyone', 'row-audience', 'owner');
       END IF;
     END $$;`,
  );
}

export async function secureCloud(db: Lattice): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  // Create the SQLite-compat polyfills (json_extract / strftime / pgcrypto) as
  // the OWNER, up front — installCloudRls revokes CREATE ON SCHEMA from PUBLIC,
  // after which a scoped member can neither create these nor CREATE OR REPLACE
  // the owner's, so they must exist before any member connects (otherwise member
  // queries that use them, e.g. the audit timestamp default, fail). Idempotent +
  // non-fatal. EXECUTE is granted to the member group in reconcileCloudMemberAccess
  // (below) — don't rely on the default PUBLIC grant, which a hardened cloud may
  // have revoked.
  await registerPostgresPolyfills((sql) => runAsyncOrSync(db.adapter, sql));
  await installCloudRls(db);
  await ownPolyfillsByGroup(db); // group-own the polyfills so any member can upgrade them
  await installCloudSettings(db);
  await db.ensureObservationSubstrate();
  await enableChangelogRls(db);
  await enableChatPrivacyRls(db); // per-author RESTRICTIVE lock on chat tables
  // Neutralize any legacy column-audience spec BEFORE regenerating mask views
  // (secureNewCloudTable → regenerateAudienceViewFromDb compiles each audience).
  await convergeLegacyColumnAudience(db);
  const registered = db.getRegisteredTableNames();
  for (const table of registered) {
    await secureNewCloudTable(db, table, db.getPrimaryKey(table));
  }
  // Private-only tables (`secrets` + the assistant's internal chat tables) are
  // forced never_share; member grants for both user tables AND the GUI/identity
  // bookkeeping tables, the polyfill EXECUTE grants, and the deleted_at schema
  // convergence are all reconciled here — so the one-time secure cutover lands the
  // exact same state an owner open converges to (reconcileCloudMemberAccess runs
  // on every owner open too, so an already-migrated cloud self-heals).
  await reconcileCloudMemberAccess(db);
}
