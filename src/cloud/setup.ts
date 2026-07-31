import type { Lattice } from '../lattice.js';
import {
  installCloudRls,
  enableChangelogRls,
  enableChatPrivacyRls,
  enableGuiAuditRls,
  enableLineageRls,
  ownPolyfillsByGroup,
  enableRlsForTable,
  memberGroupFor,
} from './rls.js';
import { installCloudSettings } from './settings.js';
import {
  seedColumnPolicyFromYaml,
  regenerateAudienceViewFromDb,
  regenerateMemberReadView,
  tableNeedsAudienceView,
  loadAllColumnPolicy,
} from './audience.js';
import {
  grantMemberTableAccessBatchSql,
  grantMemberBookkeepingSql,
  grantMemberExecuteSql,
} from './member-access.js';
import { NATIVE_INTERNAL_NAMES } from '../framework/native-entities.js';
import { allAsyncOrSync, getAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import { registerPostgresPolyfills } from '../db/postgres.js';
import { hasFilePresigner, grantPresignerToMemberGroup } from './file-presign.js';
import { assertNotManaged, MANAGED_REFUSAL } from './managed-guard.js';

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
 * (`enableRlsForTable`, recorded as `internal:cloud-rls:table:<t>:v5`) cannot:
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
  // This cloud's own member group (per (database, schema) — see memberGroupFor).
  // Resolved once and threaded into every grant so install / provision / reconcile
  // all converge on the SAME group for this cloud.
  const group = await memberGroupFor(db);

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

  // Decide masked-ness from the DB-canonical column policy (the source the <t>_v views
  // are built from), NOT the in-memory config-derived schema audience. The in-memory
  // map never reflects a column masked at RUNTIME (e.g. the GUI "mark secret" path), so
  // reading it here would take the unmasked grant path and re-GRANT members base SELECT
  // on a runtime-masked table — re-exposing the column the owner hid. One query for all.
  const columnPolicy = await loadAllColumnPolicy(db);

  // The masking views that actually EXIST. A `<t>_v` view is physical evidence
  // that `<t>` is masked, and it is evidence the policy read above cannot forge:
  // the two are written by the same operation, so they disagree only when
  // something moved one without the other — a rename or a restore that carried
  // the table but not its column policy. Resolving that disagreement by taking
  // the unmasked branch below would GRANT members raw SELECT on the base table,
  // silently un-masking every column the owner marked secret. So when the view
  // says masked and the policy says otherwise, this refuses the table, names it,
  // and leaves the mask exactly as it stands. Computed tables are views too and
  // one could be named `<t>_v` legitimately, so they are excluded.
  const viewRows = (await allAsyncOrSync(
    db.adapter,
    `SELECT c.relname AS name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind = 'v'`,
  )) as { name: string }[];
  const computedViews = new Set(db.getComputedTableNames());
  const maskViews = new Set(viewRows.map((r) => r.name).filter((name) => !computedViews.has(name)));

  // Masking evidence STRANDED UNDER A NAME THE TABLE NO LONGER HAS.
  //
  // Both checks the grant loop makes — "is there a policy for this table" and "is
  // there a `<t>_v` view for this table" — are keyed to the table's CURRENT name,
  // so neither can see a mask left behind by a rename that moved the table without
  // its policy. Postgres binds a view to the table it selects FROM by identity, not
  // by name, so the stale `<old>_v` keeps masking the table under its new name
  // while both reads above come back empty and the table looks unmasked.
  //
  // The binding the rename could not break is what makes it findable: resolve each
  // `_v` view to the table it actually reads, and any view whose name does not
  // match that table's current name is drift. That is name-independent, so it also
  // catches workspaces that drifted BEFORE the rename paths were hardened — which
  // exist in the wild — rather than only renames performed from here on.
  const viewBaseRows = (await allAsyncOrSync(
    db.adapter,
    `SELECT v.relname AS view_name, t.relname AS base_name
       FROM pg_rewrite r
       JOIN pg_class v ON v.oid = r.ev_class
       JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass
       JOIN pg_class t ON t.oid = d.refobjid AND t.relkind = 'r'
       JOIN pg_namespace n ON n.oid = v.relnamespace
      WHERE n.nspname = current_schema() AND v.relkind = 'v' AND t.oid <> v.oid
      GROUP BY 1, 2`,
  )) as { view_name: string; base_name: string }[];
  /** Current table name → the mask views reading it under some OTHER name. */
  const strandedMasks = new Map<string, string[]>();
  for (const row of viewBaseRows) {
    if (!row.view_name.endsWith('_v')) continue; // a mask view is always `<t>_v`
    if (computedViews.has(row.view_name)) continue;
    if (row.view_name === `${row.base_name}_v`) continue; // named for what it reads
    const list = strandedMasks.get(row.base_name) ?? [];
    list.push(row.view_name);
    strandedMasks.set(row.base_name, list);
  }
  // A policy row keyed to a name no table answers to, with no view left to point
  // at the table it belongs to, cannot be attributed to anything — so it cannot be
  // acted on, only reported. (The tables it could name are unaffected: whatever
  // they are, they carry no masking evidence of their own.)
  const orphanPolicy = [...columnPolicy.keys()].filter(
    (name) =>
      !registered.includes(name) &&
      !maskViews.has(`${name}_v`) &&
      tableNeedsAudienceView(columnPolicy.get(name) ?? {}),
  );
  if (orphanPolicy.length > 0) {
    console.warn(
      `[reconcileCloudMemberAccess] column policy recorded for ${orphanPolicy
        .map((n) => `"${n}"`)
        .join(', ')}, which no table in this workspace answers to`,
    );
  }

  for (const table of registered) {
    if (table.startsWith('__lattice_') || table.startsWith('_lattice_')) continue;
    if (!rlsOn.has(table)) continue;
    if (db.getPrimaryKey(table).length === 0) continue;
    // Repair, then replace, then revoke — as ONE fault-isolated unit.
    //
    // Ordering is the safety property, not a detail. Step (c) takes base SELECT
    // away; step (b) builds the thing that replaces it. Keeping them in a single
    // `tryTable` means a failure in (b) skips (c) as well, so a table only ever
    // loses its old read path once the new one exists. Between (b) and (c) a member
    // transiently holds BOTH — never neither.
    //
    // This is also what upgrades a workspace that is leaking right now. Earlier
    // versions granted members raw base SELECT whenever the column policy read back
    // empty, which is what a rename left behind. The two guards that used to sit
    // here only REFUSED such a table — they withheld new grants while the exposure
    // already standing stayed exactly as it was. Refusing does not un-leak anything;
    // revoking does.
    await tryTable(table, async () => {
      // (a) A mask stranded under a name the table no longer answers to. The
      // evidence is `pg_rewrite`, which binds a view to the table it actually reads
      // by identity — so it is trustworthy even though every name-keyed lookup has
      // already come back empty.
      const stranded = strandedMasks.get(table) ?? [];
      for (const staleView of stranded) {
        const oldName = staleView.slice(0, -2);
        // Re-attach the policy the rename failed to carry. Gated on the CURRENT
        // name having no policy at all, so this can never overwrite a deliberate one.
        const here = columnPolicy.get(table) ?? {};
        if (Object.keys(here).length === 0 && (columnPolicy.get(oldName) ?? null) !== null) {
          await runAsyncOrSync(
            db.adapter,
            `UPDATE "__lattice_column_policy" SET "table_name" = ? WHERE "table_name" = ?`,
            [table, oldName],
          );
          columnPolicy.set(table, columnPolicy.get(oldName) ?? {});
          columnPolicy.delete(oldName);
        }
        await runAsyncOrSync(
          db.adapter,
          `DROP VIEW IF EXISTS "${staleView.replace(/"/g, '""')}" CASCADE`,
        );
        const reason =
          `"${staleView}" was masking this table under the name "${oldName}", which it no longer ` +
          `has — the masking was left behind by a rename that moved the table without its column ` +
          `policy. The policy was re-attached to "${table}" and the stale view rebuilt. If a COLUMN ` +
          `was also renamed, its masking cannot be recovered from the view alone; re-mark it.`;
        skipped.push({ table, reason });
        console.warn(`[reconcileCloudMemberAccess] repaired "${table}": ${reason}`);
      }

      // (b) The relation members read this table through. Always built — masking
      // where the policy says so, pass-through where it does not.
      await regenerateMemberReadView(
        db,
        table,
        Object.keys(db.getRegisteredColumns(table) ?? {}),
        db.getPrimaryKey(table),
        stranded.length > 0 ? { recreate: true } : {},
      );

      // (c) Writes on the base, reads on the view, base SELECT revoked. One
      // round-trip; `tryTable` still isolates a failure to this table and records it.
      await runAsyncOrSync(db.adapter, grantMemberTableAccessBatchSql(table, undefined, group));
    });
  }

  // (2b) Computed tables are read-only VIEWS: RLS cannot attach to a view, so
  // they are excluded from the relkind='r' loop above, and row filtering is
  // compiled INTO each view via lattice_row_visible predicates instead. The
  // ops layer grants member SELECT when it creates a view, but the view is
  // dropped + recreated whenever its definition changes (including the open
  // path's content-hash migration) — which destroys its grants. Re-issue the
  // member-group SELECT here so members keep reading computed tables across
  // reopens and redefinitions.
  for (const view of db.getComputedTableNames()) {
    await tryTable(view, async () => {
      await runAsyncOrSync(db.adapter, `GRANT SELECT ON "${view.replace(/"/g, '""')}" TO ${group}`);
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
  for (const sql of grantMemberBookkeepingSql(group)) {
    await runAsyncOrSync(db.adapter, sql);
  }

  // (4) Polyfill functions a member's queries depend on (the audit-table
  // strftime() default, audience json_extract()). The owner created them in
  // secureCloud; grant EXECUTE explicitly so a member never has to (and cannot,
  // post-revoke) CREATE them itself. Non-fatal: a library cloud that never
  // registered the polyfills simply has nothing to grant.
  try {
    await runAsyncOrSync(db.adapter, grantMemberExecuteSql(group));
  } catch (err) {
    console.warn(
      '[reconcileCloudMemberAccess] could not grant EXECUTE on polyfills (will retry next open):',
      err instanceof Error ? err.message : String(err),
    );
  }

  // (4b) Seamless cloud file bytes: if the in-database SigV4 presigner is installed
  // (the owner enabled S3), grant EXECUTE to the member group so EVERY current AND
  // future member can presign their own visible files with no key. The grant is
  // idempotent and re-applied on every reconcile (open/join), so a member who joins
  // AFTER S3 was enabled still receives it — closing the one-shot-at-config gap. The
  // owner-only secret table is never granted (the function reads it as DEFINER). No-op
  // when the presigner isn't installed; self-heals next open if the grant fails.
  try {
    if (await hasFilePresigner(db.adapter)) {
      await grantPresignerToMemberGroup(db.adapter, group);
    }
  } catch (err) {
    console.warn(
      '[reconcileCloudMemberAccess] could not grant EXECUTE on the file presigner (will retry next open):',
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

  // (6) Backwards-compat: a cloud provisioned BEFORE per-cloud member groups has
  // its members in the legacy CLUSTER-GLOBAL `lattice_members`, not this cloud's
  // own group — so after upgrade they would lose access. Re-grant THIS cloud's
  // group to each of its OWN members. Scoped to the cloud-local invite registry
  // (`__lattice_member_invites`) JOINed to real roles — deliberately NOT the
  // cluster-global legacy group, which is shared across clouds and would
  // cross-pollinate members between unrelated clouds. Idempotent (GRANT to an
  // existing member is a no-op); fault-isolated so one bad row never aborts the
  // converge. `group` is a validated `lattice_m_<hex>` identifier; `format('%I')`
  // safely quotes both it and each role name.
  await tryTable('(member-regrant)', async () => {
    await runAsyncOrSync(
      db.adapter,
      `DO $LATTICE_REGRANT$
       DECLARE r record;
       BEGIN
         IF to_regclass('__lattice_member_invites') IS NULL THEN RETURN; END IF;
         FOR r IN
           SELECT DISTINCT i."role" AS role
             FROM "__lattice_member_invites" i
             JOIN pg_roles pr ON pr.rolname = i."role"
            WHERE i."role" IS NOT NULL
         LOOP
           EXECUTE format('GRANT %I TO %I', '${group}', r.role);
         END LOOP;
       END $LATTICE_REGRANT$;`,
    );
  });

  return { skipped };
}

/**
 * Turn a Postgres database into a secured Lattice cloud, in place: install the
 * RLS bootstrap + the observation substrate, then for every registered user
 * table stamp ownership of the existing rows and force RLS (plus a cell-masking
 * view for any audience columns). Idempotent and additive — safe to run on a
 * fresh migration target OR on an already-populated Postgres that isn't a cloud
 * yet (the "secure this cloud" cutover). No-op on SQLite.
 *
 * Must run as a role that owns the tables and can create roles (a cloud
 * owner / DBA), which need not be a superuser: the ownership stamp runs with the
 * policies lifted, inside the same transaction that applies them, so an owner
 * without BYPASSRLS can still see every row it is stamping.
 */
/**
 * Does this relation hold rows OF ITS OWN — i.e. is it a table rather than a view?
 *
 * Per-row ownership only means something for a relation that stores its own rows.
 * A view stores none: it reads them from the tables underneath, and those tables
 * are secured in their own right, so the rows a view exposes are already governed.
 * Postgres agrees — it rejects both `ALTER … ENABLE ROW LEVEL SECURITY` and a
 * per-row trigger on a view (and on a materialized view), which is how this
 * surfaced: reconstructing a view registers it through the same call every table
 * goes through, and the securing step then failed the whole registration partway
 * through an import that had already written its rows. Stamping ownership for a
 * view is wrong on its own terms too — it writes owner records keyed to a relation
 * that can never have an owner.
 *
 * An unknown relation (no row in the catalog) answers TRUE, so a genuinely missing
 * table still fails loudly at the securing step rather than being skipped here.
 */
async function ownsItsRows(db: Lattice, table: string): Promise<boolean> {
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT c.relkind AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = ?`,
    [table],
  )) as { kind?: unknown } | undefined;
  const kind = typeof row?.kind === 'string' ? row.kind : null;
  // 'r' ordinary table, 'p' partitioned table, 'f' foreign table. Anything else
  // ('v' view, 'm' materialized view, …) does not own rows.
  return kind === null || kind === 'r' || kind === 'p' || kind === 'f';
}

/**
 * Secure ONE user table on a cloud: stamp ownership of the existing rows, FORCE
 * per-row RLS, and (re)build the audience cell-masking view. Idempotent
 * + additive. The per-table half of {@link secureCloud}, factored out so tables
 * created at RUNTIME (data-model panel / assistant / ingest) are secured the same
 * way — otherwise a runtime table on a secured cloud has RLS OFF (wide open).
 * Stamping the existing rows is part of {@link enableRlsForTable}'s own SQL, which
 * is the only place it can be done correctly for an owner without BYPASSRLS. No-op
 * on SQLite, on bookkeeping tables, on an unkeyable table, or on a relation that
 * owns no rows of its own ({@link ownsItsRows}).
 */
export async function secureNewCloudTable(
  db: Lattice,
  table: string,
  pk: readonly string[],
): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  if (table.startsWith('__lattice_') || table.startsWith('_lattice_')) return;
  if (pk.length === 0) return;
  if (!(await ownsItsRows(db, table))) return;
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

/** What a caller already knows about its own session, so it need not be inferred. */
export interface SecureCloudOptions {
  /**
   * Whether this session's workspaces are owned by a deployment's manager.
   * Omitted ⇒ read from the session. A MANAGER provisioning a tenant it owns
   * passes `false` — it is the one party for whom this is the right move.
   */
  managed?: boolean;
}

/**
 * Install row-level security and the member role model on a cloud database.
 *
 * REFUSED ON A MANAGED SESSION, and the refusal lives here rather than in the
 * callers. Where a deployment's manager provisions and secures the tenant, doing
 * it again locally is not an idempotent repeat: it re-stamps row ownership and
 * re-privatizes rows that were shared, on a database that was already set up for
 * the account. The check existed in the request handler and in the command
 * wrapper — and this function is PUBLISHED, so the doors that had it were the two
 * a manager's own runtime never uses. See the managed guard.
 */
export async function secureCloud(db: Lattice, opts: SecureCloudOptions = {}): Promise<void> {
  assertNotManaged(opts.managed, MANAGED_REFUSAL.secure);
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
  await enableGuiAuditRls(db); // row-visibility lock on the GUI audit log (raw row data) — see row_id IS NULL OR lattice_row_visible
  await enableLineageRls(db); // defense-in-depth: lock the lineage substrate (RLS, no member grant)
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
