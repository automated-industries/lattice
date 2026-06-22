/**
 * Data governance primitives — provenance and trust.
 *
 * **Provenance** records, immutably, where a row came from: how it was ingested,
 * the source URI, and when. Stamped at creation and frozen — an update that tries
 * to change a provenance column fails loudly, so the lineage a risk/compliance
 * reviewer signs off on can't be quietly rewritten.
 *
 * **Trust** gates untrusted ingest: a table opted into trust gives every new row a
 * `_trust_state` (default `unverified`), and a verification workflow
 * (`markRowForReview` / `verifyRow`) moves rows to `needs_review` / `verified`.
 * Downstream consumers can filter to verified rows only.
 *
 * Both are opt-in per table and add no overhead to tables that don't use them.
 */

export type ProvenanceField = 'ingested_via' | 'source_uri' | 'ingested_at';

export interface ProvenanceConfig {
  /**
   * Which immutable provenance columns to add and stamp. Defaults to all three
   * (`ingested_via`, `source_uri`, `ingested_at`). `ingested_at` is auto-stamped
   * on insert when not supplied.
   */
  fields?: ProvenanceField[];
}

export type TrustState = 'unverified' | 'needs_review' | 'verified';

export interface TrustConfig {
  /** State assigned to a row on insert. Default `'unverified'`. */
  defaultState?: TrustState;
}

export const ALL_PROVENANCE_FIELDS: readonly ProvenanceField[] = [
  'ingested_via',
  'source_uri',
  'ingested_at',
];

/** Trust bookkeeping columns (internal-prefixed-ish, opt-in per table). */
export const TRUST_COLUMNS: Record<string, string> = {
  _trust_state: 'TEXT',
  _verified_by: 'TEXT',
  _verified_at: 'TEXT',
  _review_reason: 'TEXT',
};

/** Resolve a `provenance` config (boolean | object) to its column list. */
export function resolveProvenanceFields(
  config: boolean | ProvenanceConfig | undefined,
): ProvenanceField[] {
  if (!config) return [];
  if (config === true) return [...ALL_PROVENANCE_FIELDS];
  return config.fields && config.fields.length > 0 ? config.fields : [...ALL_PROVENANCE_FIELDS];
}

/** The DDL column spec map a provenance config contributes. */
export function provenanceColumns(
  config: boolean | ProvenanceConfig | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of resolveProvenanceFields(config)) out[f] = 'TEXT';
  return out;
}

/** Resolve a `trust` config (boolean | object) to its default state. */
export function resolveTrustDefault(config: boolean | TrustConfig | undefined): TrustState | null {
  if (!config) return null;
  if (config === true) return 'unverified';
  return config.defaultState ?? 'unverified';
}

/**
 * Thrown when an update tries to change an immutable provenance column. Lineage
 * is creation-time only; surfacing this loudly prevents silent provenance drift.
 */
export class ProvenanceImmutableError extends Error {
  constructor(
    readonly table: string,
    readonly column: string,
  ) {
    super(
      `Provenance column "${column}" on "${table}" is immutable — it is stamped at ` +
        `creation and cannot be changed by update().`,
    );
    this.name = 'ProvenanceImmutableError';
  }
}
