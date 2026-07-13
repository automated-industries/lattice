/**
 * Owner-published entity/render LAYOUT sharing for a cloud.
 *
 * On a cloud, the entity + render layout (`entities:` + `entityContexts:`) lives
 * ONLY in the owner's local config — a joined member's generated config has
 * `entities: {}`, so the member's CLI / GUI render produces a degraded or empty
 * context tree even though they can read every RLS-permitted row.
 *
 * This module closes that gap with two halves:
 *   - {@link publishSharedSchema}: the owner persists its `entities:` /
 *     `entityContexts:` blocks into the members-readable `__lattice_shared_schema`
 *     singleton (schema CONFIG, not row data — safe to share). Run on owner-open
 *     and on migrate.
 *   - {@link hydrateMemberConfigFromCloud}: a member, BEFORE its Lattice is
 *     constructed, hydrates its local config FILE from that table — keeping its
 *     own scoped `db:` / `name:` lines — so both the CLI and GUI then render the
 *     full owner layout.
 *
 * Postgres-only: a cloud is always Postgres. Every entry point is a no-op on
 * SQLite / a non-postgres `db:`.
 */
import { Lattice } from '../lattice.js';
import { getAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import { loadConfigDoc, saveConfigDoc } from '../gui/config-io.js';
import { isPostgresUrl } from './url.js';

/**
 * Owner-side: persist the current config's `entities:` / `entityContexts:` blocks
 * into the members-readable `__lattice_shared_schema` singleton. No-op off Postgres
 * and a no-op when the config has no entities (so we never clobber a good published
 * spec with an empty one). Errors propagate — callers wrap this in their existing
 * converge try/catch, so a failure is surfaced, not swallowed.
 */
export async function publishSharedSchema(db: Lattice, configPath: string): Promise<void> {
  if (db.getDialect() !== 'postgres') return;
  const cfg = loadConfigDoc(configPath).toJSON() as {
    entities?: Record<string, unknown>;
    entityContexts?: Record<string, unknown>;
    computed?: Record<string, unknown>;
  };
  const entities = cfg.entities ?? {};
  if (Object.keys(entities).length === 0) return;
  // Self-heal the additive computed_json column before writing it: the RLS
  // bootstrap adds it on the owner's converge, but publish is also reachable
  // right after a runtime computed-table edit — an older cloud whose converge
  // has not re-run yet must not fail the publish. Idempotent.
  await runAsyncOrSync(
    db.adapter,
    `ALTER TABLE "__lattice_shared_schema" ADD COLUMN IF NOT EXISTS "computed_json" TEXT`,
  );
  // Sanitize the published layout: a not-yet-upgraded owner config can carry
  // legacy ROOT-level outputFile values (STATES.md at the Context root — the
  // orphan-rollup bug). Members hydrate this spec verbatim, so publish the
  // healed shape (same rewrite as the config upgrade) rather than replicating
  // the breakage into every member's workspace. Rewrite ONLY the EXACT upper-cased
  // legacy default the buggy create path wrote — never a deliberately-authored
  // lowercase filename (e.g. the documented `outputFile: tickets.md`).
  for (const [name, def] of Object.entries(entities)) {
    if (def && typeof def === 'object') {
      const d = def as { outputFile?: unknown };
      if (typeof d.outputFile === 'string' && d.outputFile === `${name.toUpperCase()}.md`) {
        d.outputFile = `.schema-only/${name}.md`;
      }
    }
  }
  await runAsyncOrSync(
    db.adapter,
    `INSERT INTO "__lattice_shared_schema" ("id","entities_json","contexts_json","computed_json","updated_at")
       VALUES ('singleton', $1, $2, $3, $4)
       ON CONFLICT ("id") DO UPDATE SET
         "entities_json" = EXCLUDED."entities_json",
         "contexts_json" = EXCLUDED."contexts_json",
         "computed_json" = EXCLUDED."computed_json",
         "updated_at"    = EXCLUDED."updated_at"`,
    [
      JSON.stringify(entities),
      JSON.stringify(cfg.entityContexts ?? null),
      JSON.stringify(cfg.computed ?? null),
      new Date().toISOString(),
    ],
  );
}

/**
 * Member-side: hydrate the member's config FILE from the owner-published layout in
 * `__lattice_shared_schema`, preserving the member's own `db:` / `name:` lines and
 * comments. Returns true iff it actually wrote a layout. No-op (returns false) off
 * Postgres, when the member's config already has entities, or when nothing was
 * published yet.
 *
 * Best-effort: a connection / read problem is caught + logged and returns false —
 * NOT masking a silent failure, because the very next `db.init()` in the caller
 * opens the same connection and surfaces a real connectivity error loudly.
 */
export async function hydrateMemberConfigFromCloud(
  configPath: string,
  dbUrl: string,
  encryptionKey: string,
): Promise<boolean> {
  if (!isPostgresUrl(dbUrl)) return false;
  // Don't overwrite an already-populated config — the owner (and any member who
  // already hydrated) keeps its own layout.
  const existing = loadConfigDoc(configPath).toJSON() as { entities?: Record<string, unknown> };
  if (Object.keys(existing.entities ?? {}).length > 0) return false;

  try {
    const peek = new Lattice({ config: configPath }, { encryptionKey });
    try {
      await peek.init({ introspectOnly: true });
      // The shared-schema table only exists on a secured cloud; guard so a plain
      // Postgres / fresh DB is a clean no-op.
      const reg = await getAsyncOrSync(
        peek.adapter,
        "SELECT to_regclass('__lattice_shared_schema') AS reg",
      );
      if (reg?.reg == null) return false;
      const row = await getAsyncOrSync(
        peek.adapter,
        'SELECT "entities_json","contexts_json" FROM "__lattice_shared_schema" WHERE "id" = $1',
        ['singleton'],
      );
      if (row?.entities_json == null) return false;
      const entities = JSON.parse(row.entities_json as string) as Record<string, unknown>;
      if (Object.keys(entities).length === 0) return false;
      // Write into the config FILE, preserving db:/name:/comments.
      const doc = loadConfigDoc(configPath);
      doc.setIn(['entities'], entities);
      if (row.contexts_json != null) {
        const ctx = JSON.parse(row.contexts_json as string) as unknown;
        if (ctx) doc.setIn(['entityContexts'], ctx);
      }
      // Computed-table definitions ride the same published layout. Read in a
      // SEPARATE guarded query: on a cloud published before the computed_json
      // column existed, this read fails — the member must still hydrate
      // entities/contexts rather than lose the whole layout.
      try {
        const computedRow = await getAsyncOrSync(
          peek.adapter,
          'SELECT "computed_json" FROM "__lattice_shared_schema" WHERE "id" = $1',
          ['singleton'],
        );
        if (computedRow?.computed_json != null) {
          const computed = JSON.parse(computedRow.computed_json as string) as Record<
            string,
            unknown
          > | null;
          if (computed && Object.keys(computed).length > 0) doc.setIn(['computed'], computed);
        }
      } catch (e) {
        console.warn(
          '[hydrateMemberConfigFromCloud] skipped computed-table hydration (pre-computed cloud?):',
          (e as Error).message,
        );
      }
      saveConfigDoc(configPath, doc);
      return true;
    } finally {
      peek.close();
    }
  } catch (e) {
    console.warn(
      '[hydrateMemberConfigFromCloud] could not hydrate member schema:',
      (e as Error).message,
    );
    return false;
  }
}
