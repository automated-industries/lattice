import type { BelongsToRelation, Row, TableDefinition } from '../types.js';
import type { EntityContextDefinition, EntityFileSource } from '../schema/entity-context.js';
import { frontmatter, slugify } from '../render/markdown.js';

/**
 * Derive a clean, legible, DB-aligned `Context/` tree for a workspace's tables
 * with zero per-entity configuration. The convention:
 *
 *   table  → folder            (`files`  → `Context/Files/`)
 *   row    → sub-folder        (`Context/Files/<slug>/`)
 *   self   → `<ENTITY>.md`     (singular, upper — `FILE.md`)
 *   relation → `<RELATED>.md`  (the related table name, upper — `PROJECTS.md`)
 *
 * So a file that belongs to projects gets `Context/Files/<slug>/PROJECTS.md`,
 * and each project gets `Context/Projects/<slug>/FILES.md` — the folder tree is
 * a faithful projection of the rows and their relations. Tables that already
 * have an entity context (declared in the config or added programmatically)
 * are left untouched, so this never overrides an explicit layout.
 *
 * Pure: takes table definitions, returns entity-context definitions. The caller
 * registers the ones whose tables lack a context.
 */
export function deriveCanonicalContexts(
  tables: readonly { name: string; definition: TableDefinition }[],
): { table: string; definition: EntityContextDefinition }[] {
  // Index reverse relations: for each target table, the (childTable, fk) pairs
  // whose belongsTo points at it — these become hasMany rollups on the parent.
  const childrenOf = new Map<string, { table: string; foreignKey: string }[]>();
  for (const { name, definition } of tables) {
    for (const rel of belongsToRelations(definition)) {
      const list = childrenOf.get(rel.table) ?? [];
      list.push({ table: name, foreignKey: rel.foreignKey });
      childrenOf.set(rel.table, list);
    }
  }
  const byName = new Map(tables.map((t) => [t.name, t.definition] as const));

  const out: { table: string; definition: EntityContextDefinition }[] = [];
  for (const { name, definition } of tables) {
    // HARD exclusions, fail-closed: never derive a context for the encrypted
    // secrets store (rendering would dump ciphertext), the conversation tables,
    // or internal bookkeeping — regardless of what a caller feeds in. Runtime
    // derivation call sites depend on this being enforced HERE.
    if (
      name === 'secrets' ||
      name === 'chat_threads' ||
      name === 'chat_messages' ||
      name.startsWith('_lattice') ||
      name.startsWith('__lattice')
    ) {
      continue;
    }
    // LINK tables (junctions) never get their OWN canonical context — they are
    // relationship plumbing, not documents. Their content still surfaces: each
    // endpoint's context renders the junction as a manyToMany rollup of the
    // REMOTE rows (via childrenOf below). Gating HERE — inside the derivation —
    // keeps every caller (owner open, member open, openWorkspace) consistent by
    // construction; previously the member path excluded junctions and the owner
    // path did not, so Context/<Junction>/ trees rendered on one surface only.
    if (isLinkTable(name, definition)) continue;
    const files: EntityContextDefinition['files'] = {};

    // The entity's own context.
    files[`${singularUpper(name)}.md`] = {
      source: { type: 'self' } satisfies EntityFileSource,
      render: renderSelf(name),
    };

    // belongsTo rollups — the parent rows this entity points to.
    for (const rel of belongsToRelations(definition)) {
      files[`${rel.table.toUpperCase()}.md`] = {
        source: { type: 'belongsTo', table: rel.table, foreignKey: rel.foreignKey },
        render: renderRelated(rel.table),
        omitIfEmpty: true,
      };
    }

    // Child rollups — rows that point back to this entity. A RELATIONSHIP/junction
    // child renders the REMOTE entity via `manyToMany` (so each side shows the
    // OTHER — symmetric by construction: contact→meetings, meeting→contacts); a
    // first-class child renders its own rows via `hasMany`. Rendering a junction
    // as a raw `hasMany` dump surfaces only the FK pointing back at THIS parent
    // (the parent's own id, repeated) and never the remote link — the asymmetry
    // this fixes.
    for (const child of childrenOf.get(name) ?? []) {
      const childDef = byName.get(child.table);
      const childBt = childDef ? belongsToRelations(childDef) : [];
      const [rel0, rel1] = childBt;
      if (childDef && rel0 && rel1 && isRenderJunction(child.table, childDef, childBt)) {
        // localKey = the FK pointing back at THIS entity; remoteKey = the other.
        const localRel = rel0.foreignKey === child.foreignKey ? rel0 : rel1;
        const remoteRel = localRel === rel0 ? rel1 : rel0;
        // File named for the REMOTE entity. A self-referential junction (both FKs
        // point back at this table) would collide on the remote name, so for that
        // case disambiguate the file by the remote FK column.
        const fileKey =
          remoteRel.table === name
            ? `${child.table.toUpperCase()}__${remoteRel.foreignKey.toUpperCase()}.md`
            : `${remoteRel.table.toUpperCase()}.md`;
        files[fileKey] = {
          source: {
            type: 'manyToMany',
            junctionTable: child.table,
            localKey: localRel.foreignKey,
            remoteKey: remoteRel.foreignKey,
            remoteTable: remoteRel.table,
            references: remoteRel.references ?? 'id',
          } satisfies EntityFileSource,
          render: renderRelated(remoteRel.table),
          omitIfEmpty: true,
        };
      } else {
        files[`${child.table.toUpperCase()}.md`] = {
          source: { type: 'hasMany', table: child.table, foreignKey: child.foreignKey },
          render: renderRelated(child.table),
          omitIfEmpty: true,
        };
      }
    }

    out.push({
      table: name,
      definition: {
        directoryRoot: titleCase(name),
        slug: canonicalSlug(definition),
        files,
      },
    });
  }
  // Junction render symmetry is guaranteed by the by-construction derivation
  // above — both endpoints of a render-junction emit the reciprocal manyToMany
  // source — and locked by canonical-context-junction-symmetry.test.ts. It is NOT
  // re-checked at render time: a violation there would crash a user's render for
  // what is at worst a cosmetic asymmetry, and a derivation regression is the
  // kind of thing CI should catch before it ships, not the running GUI.
  return out;
}

/**
 * Should a child table render as a RELATIONSHIP (resolve the REMOTE entity via
 * `manyToMany`) instead of a raw child-row dump (`hasMany`)? True for a table that
 * connects exactly two entities: a PURE junction (only the two FK columns + system
 * columns) OR a PAYLOAD-bearing junction whose PRIMARY KEY is exactly the two FK
 * columns (its identity IS the endpoint pair — e.g. `contact_meeting(contact_id,
 * meeting_id, role, rsvp)`). A first-class entity that merely carries two FKs keeps
 * its own `id` PK + content columns and renders its own rows (`hasMany`), never
 * collapsed into the remote side.
 */
function isRenderJunction(name: string, def: TableDefinition, bt: BelongsToRelation[]): boolean {
  return isLinkTableWith(name, def, bt);
}

/**
 * THE shared link-table classifier — the one predicate deciding whether a table
 * is relationship plumbing (renders as manyToMany into its endpoints, never gets
 * its own context) or a first-class entity. Exported so the GUI lifecycle and any
 * other classification site can agree with the render derivation by construction.
 */
export function isLinkTable(name: string, def: TableDefinition): boolean {
  return isLinkTableWith(name, def, belongsToRelations(def));
}

function isLinkTableWith(name: string, def: TableDefinition, bt: BelongsToRelation[]): boolean {
  if (bt.length !== 2) return false;
  const fks = new Set(bt.map((r) => r.foreignKey));
  if (fks.size !== 2) return false; // the two FKs must be distinct columns
  const pk = Array.isArray(def.primaryKey)
    ? def.primaryKey
    : def.primaryKey != null
      ? [def.primaryKey]
      : [];
  // (a) composite PK = exactly the two FK columns → the row's identity is the pair.
  if (pk.length === 2 && pk.every((c) => fks.has(c))) return true;
  // (b) pure junction: every column is one of the two FKs or a system column.
  const SYSTEM = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);
  if (Object.keys(def.columns).every((c) => fks.has(c) || SYSTEM.has(c))) return true;
  // (c) a GUI-created junction keeps the `<a>_<b>` naming of its two endpoints.
  // Payload columns added later (auto-added enrichment columns) must not silently
  // promote it to a first-class entity — that flip is what turned clean m2m
  // rollups into raw <JUNCTION>.md dumps and gave junctions their own folders.
  const [a, b] = bt.map((r) => r.table);
  return name === `${String(a)}_${String(b)}` || name === `${String(b)}_${String(a)}`;
}

function belongsToRelations(def: TableDefinition): BelongsToRelation[] {
  return Object.values(def.relations ?? {}).filter(
    (r): r is BelongsToRelation => r.type === 'belongsTo',
  );
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** `files` → `Files`, `project_files` → `Project_files` (first char upper). */
function titleCase(table: string): string {
  if (table.length === 0) return table;
  return table.charAt(0).toUpperCase() + table.slice(1);
}

/** Best-effort singularization, upper-cased: `files`→`FILE`, `entities`→`ENTITY`. */
function singularUpper(table: string): string {
  let s = table;
  if (/ies$/i.test(s)) s = s.replace(/ies$/i, 'y');
  else if (/(ch|sh|ss|x|z)es$/i.test(s)) s = s.replace(/es$/i, '');
  else if (/s$/i.test(s) && !/ss$/i.test(s)) s = s.replace(/s$/i, '');
  return s.toUpperCase();
}

/**
 * Stable, legible per-row slug. Prefers a `slug`/`name`/`title` column, falls
 * back to the primary key value. Never returns an empty string.
 */
function canonicalSlug(def: TableDefinition): (row: Row) => string {
  const cols = new Set(Object.keys(def.columns));
  const pkCol = Array.isArray(def.primaryKey) ? def.primaryKey[0] : def.primaryKey;
  const pk = typeof pkCol === 'string' && pkCol.length > 0 ? pkCol : 'id';
  const prefer = ['slug', 'name', 'title'].filter((c) => cols.has(c));
  return (row: Row): string => {
    // Slugify FIRST, then test — an all-punctuation/emoji name slugifies to ''
    // and must not collapse every such row into the table-root folder.
    for (const c of prefer) {
      const s = slugify(toText(row[c]));
      if (s.length > 0) return s;
    }
    const idSlug = slugify(toText(row[pk]) || toText(row.id));
    return idSlug.length > 0 ? idSlug : 'row';
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const HIDDEN_COLS = new Set(['deleted_at', '_reward_total', '_reward_count']);

/**
 * Render one field as a Markdown bullet. Single-line values stay on the bullet
 * line (`- **key:** value`). A multi-line value keeps its first line inline and
 * writes each remaining line as a 2-space-indented CONTINUATION line, so the whole
 * value round-trips through {@link parseEntityProfileContent} instead of being
 * silently truncated to its first line on the next reverse-sync. Interior empty
 * lines are written blank (no marker) and recovered by the parser's look-ahead.
 */
export function renderFieldBullet(k: string, v: unknown): string {
  const text = toText(v);
  if (!text.includes('\n')) return `- **${k}:** ${text}`;
  const [first = '', ...rest] = text.split('\n');
  const cont = rest.map((line) => (line === '' ? '' : `  ${line}`)).join('\n');
  return `- **${k}:** ${first}\n${cont}`;
}

/**
 * Give RUNTIME-registered tables (connector models, imported database tables —
 * registered via defineLate, so never in the parsed config) the same canonical
 * per-record contexts config tables get at open. Pure over {name, definition};
 * idempotent (existing contexts are never overridden); the hard exclusions
 * inside deriveCanonicalContexts (secrets/chat/internal) apply by construction.
 */
export function ensureRuntimeEntityContexts(
  db: {
    entityContexts(): Map<string, EntityContextDefinition>;
    defineEntityContext(table: string, definition: EntityContextDefinition): unknown;
  },
  models: readonly { table: string; definition: TableDefinition }[],
): void {
  const existing = db.entityContexts();
  const derived = deriveCanonicalContexts(
    models.map((m) => ({ name: m.table, definition: m.definition })),
  );
  for (const { table, definition } of derived) {
    if (!existing.has(table)) db.defineEntityContext(table, definition);
  }
}

/**
 * A minimal, single-table canonical context: the per-record self file only,
 * with a column-exclusion set and a character budget. Used for tables whose
 * rows carry columns too heavy to dump into markdown (a file's extracted
 * text) but that still deserve a rendered per-record context.
 */
export function boundedSelfContext(
  name: string,
  definition: TableDefinition,
  opts: { excludeColumns?: Set<string>; budget?: number } = {},
): EntityContextDefinition {
  return {
    directoryRoot: titleCase(name),
    slug: canonicalSlug(definition),
    files: {
      [`${singularUpper(name)}.md`]: {
        source: { type: 'self' } satisfies EntityFileSource,
        render: renderSelf(name, opts),
      },
    },
  };
}

/**
 * Render a single entity row as a titled, frontmatter-tagged detail block.
 * `opts.excludeColumns` drops columns from the rendered output entirely (e.g. a
 * file's multi-megabyte extracted_text — the markdown context is a summary, not
 * a dump), and `opts.budget` caps the whole self block's character length.
 */
function renderSelf(
  table: string,
  opts?: { excludeColumns?: Set<string>; budget?: number },
): (rows: Row[]) => string {
  const exclude = opts?.excludeColumns;
  const budget = opts?.budget;
  return (rows: Row[]): string => {
    const row = rows[0];
    if (!row) return '';
    const title = rowLabel(row) || singularUpper(table);
    const fields = Object.entries(row)
      .filter(
        ([k, v]) => !HIDDEN_COLS.has(k) && !exclude?.has(k) && v != null && toText(v).length > 0,
      )
      .map(([k, v]) => renderFieldBullet(k, v))
      .join('\n');
    let out = `${frontmatter({ [`${table}_id`]: toText(row.id) })}# ${title}\n\n${fields}\n`;
    if (budget && out.length > budget) out = out.slice(0, budget) + '\n\u2026\n';
    return out;
  };
}

/** Render a list of related rows (one bullet per row). */
function renderRelated(table: string): (rows: Row[]) => string {
  return (rows: Row[]): string => {
    if (rows.length === 0) return '';
    const items = rows.map((r) => `- ${rowLabel(r) || '(row)'}`).join('\n');
    return `# ${titleCase(table)}\n\n${items}\n`;
  };
}

/**
 * A row's human label. Tries the conventional name columns first, then short
 * descriptive ones, then the id, and finally — for rows with none of those, most
 * commonly a junction row that is only foreign keys — the first non-empty field
 * as `key: value`. Only a completely empty row yields ''. This is what keeps a
 * relation list from rendering as a wall of literal "(row)" placeholders.
 */
function rowLabel(row: Row): string {
  for (const k of ['name', 'title', 'label', 'original_name', 'subject', 'slug']) {
    const v = toText(row[k]);
    if (v) return v;
  }
  for (const k of ['summary', 'description', 'body', 'content', 'url', 'path']) {
    const v = toText(row[k]);
    if (v) return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  }
  const id = toText(row.id);
  if (id) return id;
  // Last resort: a junction / FK-only row — surface the first meaningful field
  // (skip timestamps + the soft-delete marker) so it isn't a bare "(row)".
  for (const [k, val] of Object.entries(row)) {
    if (k === 'id' || k === 'deleted_at' || k.endsWith('_at')) continue;
    const v = toText(val);
    if (v) return `${k}: ${v}`;
  }
  return '';
}

/** Safe stringification of an unknown DB cell value. */
function toText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return '';
}
