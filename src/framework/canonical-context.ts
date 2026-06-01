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

  const out: { table: string; definition: EntityContextDefinition }[] = [];
  for (const { name, definition } of tables) {
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

    // hasMany rollups — the child rows that point back to this entity.
    for (const child of childrenOf.get(name) ?? []) {
      files[`${child.table.toUpperCase()}.md`] = {
        source: { type: 'hasMany', table: child.table, foreignKey: child.foreignKey },
        render: renderRelated(child.table),
        omitIfEmpty: true,
      };
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
  return out;
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

/** Render a single entity row as a titled, frontmatter-tagged detail block. */
function renderSelf(table: string): (rows: Row[]) => string {
  return (rows: Row[]): string => {
    const row = rows[0];
    if (!row) return '';
    const title = rowLabel(row) || singularUpper(table);
    const fields = Object.entries(row)
      .filter(([k, v]) => !HIDDEN_COLS.has(k) && v != null && toText(v).length > 0)
      .map(([k, v]) => `- **${k}:** ${toText(v)}`)
      .join('\n');
    return `${frontmatter({ [`${table}_id`]: toText(row.id) })}# ${title}\n\n${fields}\n`;
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

/** A row's human label: name → title → slug → id (whichever is present). */
function rowLabel(row: Row): string {
  return toText(row.name) || toText(row.title) || toText(row.slug) || toText(row.id);
}

/** Safe stringification of an unknown DB cell value. */
function toText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return '';
}
