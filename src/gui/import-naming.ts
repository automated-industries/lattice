import { normalizeName } from '../import/infer-core.js';
import { labelFromFilename } from '../import/name-policy.js';
import { isGenericTableName } from './model-contract.js';

/**
 * Resolve a display name for every table an import is about to create.
 *
 * DETERMINISTIC FIRST. A source key that already means something is kept as-is;
 * a positional one (`Sheet1`, `table_1`, `untitled`) is named from the FILE it
 * came from, uniquified with an ordinal. That ladder alone always produces a
 * complete, non-generic answer, and it is byte-identical to the deterministic
 * source-key fallback the confirm-card apply door re-derives — so a proposal and
 * the apply that follows it never disagree about what the tables are called.
 *
 * A MODEL IS ONLY EVER USED TO BREAK TIES, and only under a hard cap. When two
 * or more positional keys come out of the same file they would all collapse onto
 * the same file-derived label plus an ordinal (`Q3 Report`, `Q3 Report 2`) —
 * which is the positional naming the user complained about, one level up. A
 * single bounded call can name them properly. That call is optional in every
 * sense: no assist configured, no provider, a cap of zero, an error, or a
 * suggestion that fails the name policy all fall back to the deterministic
 * ladder, and the reason is REPORTED on the result rather than logged and
 * forgotten.
 */

/** A model may be consulted at most this many times for one import, total. */
export const MAX_NAME_ASSIST_CALLS = 1;

/** A table the import is about to name. */
export interface ImportNameCandidate {
  /** The key as parsed — a sheet name, a JSON key, a document table label. */
  key: string;
  /** Column headers, when known. Passed to the assist as naming evidence. */
  columns?: string[];
  rowCount?: number;
}

export interface NameAssistInput {
  /** The file the tables came from. */
  sourceName: string;
  /** Only the keys that need a name — never the whole import. */
  keys: string[];
  columnsByKey: Record<string, string[]>;
}

/**
 * A bounded naming helper. Implementations are free to call a model; the
 * resolver guarantees it is invoked at most {@link MAX_NAME_ASSIST_CALLS} times
 * per import and that every suggestion is re-checked against the name policy
 * before it is used.
 */
export interface NameAssist {
  suggest(input: NameAssistInput): Promise<Record<string, string>>;
}

export interface ResolveImportNamesOptions {
  /** Original file name — the label every positional key is derived from. */
  sourceName: string;
  /** Names already in use (registered tables) that a resolved name must avoid. */
  taken?: Iterable<string>;
  /** Absent or null ⇒ deterministic naming only. */
  assist?: NameAssist | null;
  /** Hard cap on assist calls. Defaults to {@link MAX_NAME_ASSIST_CALLS}; 0 disables. */
  maxAssistCalls?: number;
}

export interface ResolvedImportNames {
  /** Source key → resolved display name. One entry per candidate; never generic. */
  names: Record<string, string>;
  assistCalls: number;
  assistUsed: boolean;
  /**
   * True when a tie existed that a model could have named better, but none was
   * available (not configured, capped out, failed). The names are still complete
   * and deterministic — this says the QUALITY degraded, not that anything broke.
   */
  assistUnavailable: boolean;
  /** Everything that went wrong with the assist, verbatim. Empty when it was clean. */
  assistNotes: string[];
}

export async function resolveImportNames(
  candidates: ImportNameCandidate[],
  opts: ResolveImportNamesOptions,
): Promise<ResolvedImportNames> {
  const maxCalls = opts.maxAssistCalls ?? MAX_NAME_ASSIST_CALLS;
  const resolved = new Map<string, string>();
  const assistNotes: string[] = [];
  let assistCalls = 0;
  let assistUsed = false;

  // Every key in the import starts out "taken", exactly as the deterministic
  // source-key fallback does: a positional key must not be renamed onto a name
  // some other key in the same file already carries.
  const taken = new Set<string>();
  for (const t of opts.taken ?? []) taken.add(normalizeName(t));
  for (const c of candidates) taken.add(normalizeName(c.key));

  const positional = candidates.filter((c) => isGenericTableName(c.key));
  for (const c of candidates) {
    if (!isGenericTableName(c.key)) resolved.set(c.key, c.key);
  }

  // A tie: two or more keys from this file would be named from the same label.
  const tie = positional.length > 1;
  if (tie && opts.assist && maxCalls > 0) {
    const columnsByKey: Record<string, string[]> = {};
    for (const c of positional) columnsByKey[c.key] = c.columns ?? [];
    assistCalls++;
    let suggestions: Record<string, string> | null = null;
    try {
      suggestions = await opts.assist.suggest({
        sourceName: opts.sourceName,
        keys: positional.map((c) => c.key),
        columnsByKey,
      });
    } catch (e) {
      // Surfaced on the result (and from there into the import's notices), not
      // swallowed: a naming helper that is silently broken would look exactly
      // like one that was never configured.
      assistNotes.push(
        `Name suggestions were unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (suggestions) {
      for (const c of positional) {
        const raw = suggestions[c.key];
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const suggested = raw.trim();
        if (isGenericTableName(suggested)) {
          assistNotes.push(`Ignored the suggested name "${suggested}" — it is positional.`);
          continue;
        }
        if (taken.has(normalizeName(suggested))) {
          assistNotes.push(
            `Ignored the suggested name "${suggested}" — that name is already used.`,
          );
          continue;
        }
        // The key's own placeholder is released only once the replacement lands,
        // so a suggestion can never take a name another key still holds.
        taken.delete(normalizeName(c.key));
        taken.add(normalizeName(suggested));
        resolved.set(c.key, suggested);
        assistUsed = true;
      }
    }
  }

  // Deterministic ladder for everything still unnamed: the file label plus an
  // ordinal, which is exactly what the apply door re-derives.
  const label = labelFromFilename(opts.sourceName);
  for (const c of positional) {
    if (resolved.has(c.key)) continue;
    taken.delete(normalizeName(c.key));
    let name = label;
    let n = 2;
    while (taken.has(normalizeName(name))) {
      name = `${label} ${String(n)}`;
      n++;
    }
    taken.add(normalizeName(name));
    resolved.set(c.key, name);
  }

  // Emitted in CANDIDATE order (not resolution order) so a caller that rebuilds
  // the source object from this map preserves the file's own key order.
  const names: Record<string, string> = {};
  for (const c of candidates) {
    const name = resolved.get(c.key);
    if (name === undefined) continue;
    // The ladder cannot produce a generic name (labelFromFilename already folds a
    // generic file name onto its own fallback), so a violation here means the
    // policy and the ladder have drifted apart. Fail loudly rather than writing a
    // `table_1` into the model, which is the exact outcome this module prevents.
    if (isGenericTableName(name)) {
      throw new Error(
        `Import naming produced the positional name "${name}" for source key "${c.key}".`,
      );
    }
    names[c.key] = name;
  }

  return {
    names,
    assistCalls,
    assistUsed,
    assistUnavailable: tie && !assistUsed,
    assistNotes,
  };
}
