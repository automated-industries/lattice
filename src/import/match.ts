/**
 * Match an inferred import schema against the tables already in a workspace, so
 * a re-uploaded file is recognized as a NEW PERIOD of a document already
 * imported — not a brand-new set of tables. Each inferred entity is fingerprinted
 * by its column-name set and matched to the best existing table by containment
 * (robust to added columns + renames of a few columns). When enough of the upload
 * maps onto existing tables, it's a "known document": the importer can stamp it
 * as a dated snapshot into those tables instead of creating duplicates.
 *
 * Pure + dependency-free (takes a plain list of existing tables, not a `Lattice`)
 * so it's unit-testable and reusable from any door (import panel + assistant).
 */

import { normalizeName } from './infer.js';
import type { DetectedView, ProposedSchema } from './types.js';

/** Bookkeeping columns the importer adds — excluded from signature comparison. */
const BOOKKEEPING = new Set(['id', 'as_of', 'content_key', 'deleted_at']);

/** Share of an inferred entity's columns that must land in an existing table to match. */
const MATCH_THRESHOLD = 0.6;

export interface ExistingTable {
  name: string;
  columns: string[];
}

export interface EntityMatch {
  /** Inferred entity name (from the new upload). */
  from: string;
  /** Existing table it matches. */
  to: string;
  /** 0..1 — share of the inferred entity's columns present in the existing table. */
  overlap: number;
}

export interface SchemaMatch {
  /** Per-entity matches above the threshold (best existing table for each). */
  matches: EntityMatch[];
  /** Rename map (inferred name → existing table name) for names that differ. */
  rename: Record<string, string>;
  matchedCount: number;
  totalEntities: number;
  /**
   * True when enough of the upload maps onto existing tables to treat it as a
   * re-import of a document already in the workspace (i.e. a new dated snapshot).
   */
  isKnownDocument: boolean;
}

/** Data columns of a table/entity (drops bookkeeping + junction FK columns). */
function signature(columns: string[]): Set<string> {
  const out = new Set<string>();
  for (const c of columns) {
    const n = normalizeName(c);
    if (!n || BOOKKEEPING.has(n) || n.endsWith('_id')) continue;
    out.add(n);
  }
  return out;
}

/** Containment: share of `a`'s members present in `b`. */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const c of a) if (b.has(c)) hit++;
  return hit / a.size;
}

/**
 * Match the inferred {@link ProposedSchema} against the workspace's existing
 * tables. `existing` should already exclude native/system tables (the caller has
 * the registry); junctions/dimensions are harmless — their tiny signatures won't
 * reach the threshold against a real data entity.
 */
export function matchSchemaToExisting(
  existing: ExistingTable[],
  plan: ProposedSchema,
): SchemaMatch {
  const ex = existing.map((t) => ({ name: t.name, sig: signature(t.columns) }));
  const matches: EntityMatch[] = [];
  const rename: Record<string, string> = {};
  for (const ent of plan.entities) {
    const sig = signature(ent.columns.map((c) => c.name));
    if (sig.size === 0) continue;
    let best: { name: string; overlap: number } | null = null;
    for (const t of ex) {
      // Same (normalized) name ⇒ definitively the same table, regardless of overlap.
      if (normalizeName(t.name) === normalizeName(ent.name)) {
        best = { name: t.name, overlap: 1 };
        break;
      }
      const overlap = containment(sig, t.sig);
      if (overlap > (best?.overlap ?? 0)) best = { name: t.name, overlap };
    }
    if (best && best.overlap >= MATCH_THRESHOLD) {
      matches.push({ from: ent.name, to: best.name, overlap: best.overlap });
      if (best.name !== ent.name) rename[ent.name] = best.name;
    }
  }
  const totalEntities = plan.entities.length;
  const matchedCount = matches.length;
  // A re-import when at least half the inferred entities land on existing tables.
  const isKnownDocument = totalEntities > 0 && matchedCount >= Math.ceil(totalEntities / 2);
  return { matches, rename, matchedCount, totalEntities, isKnownDocument };
}

/**
 * Apply a {@link SchemaMatch} rename map to a plan + its views, so materialize
 * writes into the matched existing tables. Names absent from the map pass through
 * unchanged (dimensions, unmatched entities). Linkage `toEntity` may be a
 * dimension; renaming only hits names in the map, so dimensions are untouched.
 */
export function renameEntities(
  plan: ProposedSchema,
  views: DetectedView[],
  rename: Record<string, string>,
): { plan: ProposedSchema; views: DetectedView[] } {
  if (Object.keys(rename).length === 0) return { plan, views };
  const r = (n: string): string => rename[n] ?? n;
  return {
    plan: {
      ...plan,
      entities: plan.entities.map((e) => ({ ...e, name: r(e.name) })),
      dimensions: plan.dimensions.map((d) => ({ ...d, fromEntities: d.fromEntities.map(r) })),
      linkages: plan.linkages.map((l) => ({
        ...l,
        fromEntity: r(l.fromEntity),
        toEntity: r(l.toEntity),
        ...(l.junction ? { junction: l.junction } : {}),
      })),
    },
    views: views.map((v) => ({ ...v, name: r(v.name), master: r(v.master) })),
  };
}
