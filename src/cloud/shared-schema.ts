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
 * Entity keys that are NOT layout and must never travel from one person's
 * workspace into another's.
 *
 * The shared layout describes SHAPE — which columns exist, how a row renders.
 * Every member receives it verbatim into their own config file and then opens
 * against it, so anything in it acts with the receiving person's authority, on
 * the receiving person's machine.
 *
 * `embeddings:` names an address to send row text to and an environment variable
 * to send as the credential for it. Shipped as layout, one person's choice of
 * endpoint would make every other person's machine post their rows to it, with
 * whatever their named variable holds attached — an address and a credential
 * chosen by someone else. Whether a workspace computes embeddings, where, and
 * with whose key stays a local decision: each person declares it in their own
 * config, which is the same file, under their own hand.
 */
const OFF_MACHINE_ENTITY_KEYS: ReadonlySet<string> = new Set(['embeddings']);

/**
 * The entity block with the non-layout keys removed. Applied on the way OUT
 * (never published) and again on the way IN (so a layout published by an older
 * build, or written straight into the table, still cannot carry one).
 */
function stripOffMachineKeys(entities: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(entities)) {
    if (def === null || typeof def !== 'object' || Array.isArray(def)) {
      out[name] = def;
      continue;
    }
    out[name] = Object.fromEntries(
      Object.entries(def as Record<string, unknown>).filter(
        ([key]) => !OFF_MACHINE_ENTITY_KEYS.has(key),
      ),
    );
  }
  return out;
}

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
  const entities = stripOffMachineKeys(cfg.entities ?? {});
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
 * What {@link hydrateMemberConfigFromCloud} did, and — when it did nothing — why.
 *
 * A plain true/false could not tell "there was nothing to do" apart from "I could
 * not find out", and those two demand opposite responses. Nothing-to-do is the
 * ordinary case for a local workspace and is fine to proceed from. Could-not-find-
 * out means the caller is about to open a workspace whose layout it does not have,
 * which is destructive rather than degraded: a reconcile against an empty schema
 * reads every previously-rendered context as removed. Collapsed into one boolean
 * that the caller then ignored, the second case proceeded exactly like the first.
 */
export type MemberSchemaHydration =
  /** Not a shared workspace (not a Postgres `db:`) — nothing to hydrate, ever. */
  | { outcome: 'not-shared' }
  /** The config already carries a layout of its own; it is left untouched. */
  | { outcome: 'already-populated' }
  /** A shared workspace whose owner has not published a layout yet. */
  | { outcome: 'not-published' }
  /** The published layout was written into the config file. */
  | { outcome: 'hydrated' }
  /** A shared workspace whose layout could NOT be read. `reason` says what failed. */
  | { outcome: 'unavailable'; reason: string };

/**
 * Member-side: hydrate the member's config FILE from the owner-published layout in
 * `__lattice_shared_schema`, preserving the member's own `db:` / `name:` lines and
 * comments.
 *
 * Never throws — the outcome is RETURNED, because "could not read the layout" is a
 * decision for the caller (an open that is about to render is fine to continue; an
 * open that is about to reconcile is not) rather than something to decide here.
 * What it must never do is report a failure as a no-op, which is what a bare
 * `false` did.
 */
export async function hydrateMemberConfigFromCloud(
  configPath: string,
  dbUrl: string,
  encryptionKey: string,
): Promise<MemberSchemaHydration> {
  if (!isPostgresUrl(dbUrl)) return { outcome: 'not-shared' };
  // Don't overwrite an already-populated config — the owner (and any member who
  // already hydrated) keeps its own layout.
  const existing = loadConfigDoc(configPath).toJSON() as { entities?: Record<string, unknown> };
  if (Object.keys(existing.entities ?? {}).length > 0) return { outcome: 'already-populated' };

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
      if (reg?.reg == null) return { outcome: 'not-published' };
      const row = await getAsyncOrSync(
        peek.adapter,
        'SELECT "entities_json","contexts_json" FROM "__lattice_shared_schema" WHERE "id" = $1',
        ['singleton'],
      );
      if (row?.entities_json == null) return { outcome: 'not-published' };
      const entities = stripOffMachineKeys(
        JSON.parse(row.entities_json as string) as Record<string, unknown>,
      );
      if (Object.keys(entities).length === 0) return { outcome: 'not-published' };
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
      return { outcome: 'hydrated' };
    } finally {
      peek.close();
    }
  } catch (e) {
    return { outcome: 'unavailable', reason: (e as Error).message };
  }
}
