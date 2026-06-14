import type { Row } from '../types.js';

/**
 * The per-viewer fold (the "local compile" of the per-viewer enrichment model).
 *
 * Source-gated enrichment is per-viewer: a value derived from a file that one
 * member can't see must not appear for that member. Postgres RLS + the generated
 * mask view handle row visibility and fixed-policy columns; this handles the
 * remaining case — a column whose VALUE differs by which sources you can reach.
 *
 * The compile is a deterministic, programmatic fold (NOT AI): start from the
 * broadly-visible ground-truth projection, then replay the observations the
 * viewer is allowed to see — latest audience-visible observation per attribute
 * wins. Because observations are additive and only the viewer-visible ones
 * contribute, the fold is provably leak-free (sound only for additive/monotonic
 * derivations) and revocation is structural: drop a viewer's access to a source
 * and every value derived from it silently reverts to the prior visible
 * observation (or ground truth), with no residue — no promotion, no copy left
 * behind. Run on the member's local replica over already-audience-gated
 * observations, so hidden observations never reach them (existence-hiding is
 * structural) and egress is paid once at pull, never per read.
 */

/** One attribute-level observation — a single column's value with its provenance. */
export interface Observation {
  /** The column this observation sets. */
  attribute: string;
  /** The value it sets the column to. */
  value: unknown;
  /** Ordering key (ISO timestamp). Latest visible observation per attribute wins. */
  createdAt: string;
  /** `ground_truth` (always visible) or `derived` (gated by its source-set). */
  changeKind?: 'ground_truth' | 'derived' | null;
  /** Source ids that produced a derived value. The observation is visible to a
   *  viewer only if the viewer can see EVERY one of them (intersection-of-sources
   *  reader set — losing any source hides the derived value). */
  sourceRef?: readonly string[] | null;
}

/** What a given member can reach, for deciding observation visibility. */
export interface Viewer {
  /** Source ids (file primary keys) this member can currently see. */
  visibleSources: ReadonlySet<string>;
}

/**
 * Whether a viewer may see an observation. Ground-truth is always visible (it is
 * the broadly-shared projection). A derived observation is visible iff the viewer
 * can see every source it was derived from — so un-sharing or deleting any one
 * source drops it. An unsourced derived observation is treated as hidden (fail
 * closed): a derived value with no recorded provenance can't be proven safe.
 */
export function observationVisible(obs: Observation, viewer: Viewer): boolean {
  if (obs.changeKind !== 'derived') return true;
  const sources = obs.sourceRef ?? [];
  if (sources.length === 0) return false;
  for (const s of sources) {
    if (!viewer.visibleSources.has(s)) return false;
  }
  return true;
}

/**
 * Compile one per-viewer entity: overlay the viewer-visible observations onto the
 * ground-truth projection, latest-per-attribute winning. Pure + deterministic —
 * the same (ground, observations, viewer) always yields the same row, and an
 * observation the viewer can't see never affects the result.
 */
export function foldEntity(ground: Row, observations: readonly Observation[], viewer: Viewer): Row {
  const latestByAttr = new Map<string, Observation>();
  for (const obs of observations) {
    if (!observationVisible(obs, viewer)) continue;
    const prev = latestByAttr.get(obs.attribute);
    // Ties (equal createdAt) resolve to the later array position — a stable,
    // deterministic order the caller controls by passing observations in order.
    if (!prev || prev.createdAt <= obs.createdAt) latestByAttr.set(obs.attribute, obs);
  }
  const result: Row = { ...ground };
  for (const [attr, obs] of latestByAttr) result[attr] = obs.value;
  return result;
}

/**
 * Expand a change-log row's `changes` object into per-attribute observations.
 * The change-log records one row per write with a JSON `changes` map; the fold
 * works per attribute, so each changed field becomes its own observation carrying
 * the write's provenance. (Caller supplies the already-parsed change-log entry.)
 */
export function observationsFromChange(entry: {
  changes: Record<string, unknown> | null;
  createdAt: string;
  changeKind?: 'ground_truth' | 'derived' | null;
  sourceRef?: readonly string[] | null;
}): Observation[] {
  if (!entry.changes) return [];
  return Object.entries(entry.changes).map(([attribute, value]) => ({
    attribute,
    value,
    createdAt: entry.createdAt,
    changeKind: entry.changeKind ?? null,
    sourceRef: entry.sourceRef ?? null,
  }));
}
