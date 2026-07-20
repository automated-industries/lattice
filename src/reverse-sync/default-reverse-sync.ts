/**
 * Default reverse-sync derivation — turns an edited rendered `.md` file back into
 * column updates WITHOUT a hand-written {@link EntityFileSpec.reverseSync}.
 *
 * Covers the round-trippable parts of a rendered file:
 *  - the YAML frontmatter block (structured `key: value` fields), and
 *  - `key: value` lines in the body (the shape the built-in/default entity
 *    templates emit), via the same parser the reverse-seed recovery path uses.
 *
 * Only columns that already exist on the row and whose value actually changed are
 * emitted; system/pk columns are never written. Free-form prose that doesn't
 * parse to a known column simply yields no update (the caller surfaces a notice)
 * — it is never guessed at, so a lossy/custom render can't corrupt the row.
 */
import { parse as parseYaml } from 'yaml';
import type { Row } from '../types.js';
import type { ReverseSyncUpdate } from '../schema/entity-context.js';
import { parseEntityProfileContent } from '../reverse-seed/engine.js';

/** Never written back from a file — identity / bookkeeping / render artifacts. */
const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'deleted_at', 'generated_at']);

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export interface ParsedFile {
  fields: Record<string, unknown>;
  body: string;
}

/**
 * Split a rendered file's leading `---\n…\n---` YAML frontmatter from its body.
 * Returns null when there is no frontmatter. The render-injected `generated_at`
 * key is dropped (it is never a column).
 */
export function parseFrontmatter(content: string): ParsedFile | null {
  const m = FRONTMATTER_RE.exec(content);
  if (m === null) return null;
  const block = m[1];
  if (block === undefined) return null;
  let fields: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(block);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fields = parsed as Record<string, unknown>;
    }
  } catch {
    return null; // malformed frontmatter — treat as no frontmatter (caller skips)
  }
  delete fields.generated_at;
  return { fields, body: content.slice(m[0].length) };
}

function norm(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- primitive after the object guard
  return String(v);
}

/**
 * Build the (table, pk, set) update for the columns whose parsed value differs
 * from the current row. Only existing, non-system, non-pk columns are considered.
 * Returns `[]` (no update) when nothing meaningfully changed.
 */
export function diffToUpdates(
  table: string,
  pk: Record<string, unknown>,
  parsed: Record<string, unknown>,
  row: Row,
): ReverseSyncUpdate[] {
  const pkCols = new Set(Object.keys(pk));
  const set: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (SYSTEM_COLUMNS.has(key) || pkCols.has(key)) continue;
    if (!(key in row)) continue; // only round-trip real columns
    const stored = norm(row[key]);
    const next = norm(val);
    if (stored === next) continue; // unchanged (type-tolerant compare)
    // Truncation guard: the body parser reads a `- **key:** value` bullet one
    // line at a time, so a MULTI-LINE stored value parses back to only its first
    // line. Never overwrite a multi-line field with just its first line — that is
    // a parse artifact, not a real edit, and would silently drop the rest.
    // (Defense-in-depth kept even alongside the multi-line round-trip renderer.)
    const nl = stored.indexOf('\n');
    if (nl > -1 && !next.includes('\n') && stored.slice(0, nl) === next) continue;
    set[key] = val;
  }
  if (Object.keys(set).length === 0) return [];
  return [{ table, pk, set }];
}

export interface DeriveContext {
  table: string;
  pkCols: string[];
  /** Parse `key: value` lines from the body too (default true). */
  parseBody?: boolean;
}

/**
 * Derive DB updates from an edited file's content for the given row. Merges
 * frontmatter fields with body `key: value` fields (frontmatter wins on
 * conflict) and diffs against the row. Returns `[]` when nothing round-trippable
 * changed.
 */
export function deriveUpdatesFromFile(
  content: string,
  row: Row,
  ctx: DeriveContext,
): ReverseSyncUpdate[] {
  const fm = parseFrontmatter(content);
  const body = fm ? fm.body : content;
  let fields: Record<string, unknown> =
    ctx.parseBody === false ? {} : parseEntityProfileContent(body);
  if (fm) fields = { ...fields, ...fm.fields }; // explicit frontmatter wins
  const pk: Record<string, unknown> = {};
  for (const c of ctx.pkCols) pk[c] = row[c];
  return diffToUpdates(ctx.table, pk, fields, row);
}
