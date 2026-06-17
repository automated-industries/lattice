import type { Lattice } from '../../lattice.js';
import type { FileJunction } from '../data.js';
import { isNativeEntity } from '../../framework/native-entities.js';
import { STRUCTURAL } from '../file-row.js';
import { createRow, updateRow, linkRows, type MutationCtx } from '../mutations.js';
import {
  resolveClaudeAuth,
  aggressivenessToTemperature,
  DEFAULT_AGGRESSIVENESS,
} from '../assistant-routes.js';
import { createAnthropicClient } from './chat.js';
import {
  summarizeText,
  classifyLinks,
  extractObjects,
  type CatalogEntity,
  type ClassifyMatch,
  type SchemaEntity,
} from './summarize.js';

/**
 * LLM enrichment for an ingested file row: replace its heuristic description
 * with an LLM summary, auto-link it to related records, and (at higher
 * aggressiveness) extract structured objects into the schema. Shared by the
 * file/text ingest routes and the assistant's URL-ingest tool.
 *
 * The `untrusted` flag marks text fetched from an external web source so the
 * enrichment prompts wrap it in injection-resistant framing (see summarize.ts).
 */

const LABEL_PREF = ['name', 'title', 'slug', 'label'];

/** True for tables that look like pure many-to-many junctions (only FKs). */
function isLikelyJunction(cols: Record<string, string>): boolean {
  const meaningful = Object.keys(cols).filter((c) => !STRUCTURAL.has(c));
  return meaningful.length > 0 && meaningful.every((c) => c.endsWith('_id'));
}

function labelColumn(cols: Record<string, string>): string | null {
  for (const p of LABEL_PREF) if (p in cols) return p;
  const text = Object.keys(cols).find((c) => !STRUCTURAL.has(c) && !c.endsWith('_id'));
  return text ?? null;
}

/**
 * Build a compact catalog of user records for the classifier: each non-native,
 * non-internal, non-junction entity with a sample of its rows (id + a label).
 */
async function buildCatalog(
  db: Lattice,
  descriptions: Record<string, string>,
): Promise<CatalogEntity[]> {
  const out: CatalogEntity[] = [];
  for (const name of db.getRegisteredTableNames()) {
    if (name.startsWith('_lattice_') || name.startsWith('__lattice_')) continue;
    if (isNativeEntity(name)) continue;
    const cols = db.getRegisteredColumns(name);
    if (!cols || isLikelyJunction(cols)) continue;
    const label = labelColumn(cols);
    const rows = (await db.query(name, { limit: 25 })) as Record<string, unknown>[];
    const records = rows
      .filter((r) => !r.deleted_at)
      .map((r) => ({ id: String(r.id), label: label ? String(r[label] ?? r.id) : String(r.id) }));
    if (records.length > 0) {
      out.push({
        table: name,
        records,
        ...(descriptions[name] ? { description: descriptions[name] } : {}),
      });
    }
  }
  return out;
}

/** The user's current entity schema (name + columns), for the object extractor. */
function buildSchema(db: Lattice): SchemaEntity[] {
  const out: SchemaEntity[] = [];
  for (const name of db.getRegisteredTableNames()) {
    if (name.startsWith('_lattice_') || name.startsWith('__lattice_')) continue;
    if (isNativeEntity(name)) continue;
    const cols = db.getRegisteredColumns(name);
    if (!cols || isLikelyJunction(cols)) continue;
    out.push({ table: name, columns: Object.keys(cols).filter((c) => !STRUCTURAL.has(c)) });
  }
  return out;
}

/**
 * When a Claude token is configured, replace the heuristic description with an
 * LLM summary and surface which existing records the file relates to (as feed
 * notes). Best-effort: any failure logs + leaves the heuristic description.
 */
export async function enrichWithLlm(
  mctx: MutationCtx,
  db: Lattice,
  fileId: string,
  text: string,
  name: string,
  junctions: FileJunction[],
  descriptions: Record<string, string>,
  createJunction?: (otherTable: string) => Promise<FileJunction | null>,
  aggressiveness: number = DEFAULT_AGGRESSIVENESS,
  createEntity?: (entity: string, columns: string[]) => Promise<string | null>,
  untrusted = false,
): Promise<ClassifyMatch[]> {
  if (!text.trim()) return [];
  const auth = await resolveClaudeAuth(db);
  if (!auth) {
    // No AI credentials → auto-link can't run. Log it (rather than feed-spamming
    // local non-AI users) so "why didn't it link?" is answerable from the log.
    console.warn('[ingest] auto-link skipped — no AI credentials configured');
    return [];
  }
  let client;
  try {
    client = createAnthropicClient(auth);
  } catch (e) {
    // internal guideline: never swallow. A client-init failure means NO auto-link for this
    // file — say so loudly + visibly instead of returning [] in silence.
    const msg = (e as Error).message;
    console.error('[ingest] auto-link unavailable — Anthropic client init failed:', msg);
    mctx.feed.publish({
      table: 'files',
      op: 'update',
      rowId: fileId,
      source: mctx.source,
      summary: `Couldn't auto-link "${name}": AI client unavailable`,
    });
    return [];
  }
  const temperature = aggressivenessToTemperature(aggressiveness);
  let description = '';
  try {
    description = (await summarizeText(client, text, name, temperature, untrusted)).trim();
    if (description) await updateRow(mctx, 'files', fileId, { description });
  } catch (e) {
    console.warn('[ingest] LLM description failed:', (e as Error).message);
  }
  try {
    const matches = await classifyLinks(
      client,
      text,
      name,
      await buildCatalog(db, descriptions),
      temperature,
      untrusted,
    );
    let linkedCount = 0;
    for (const m of matches) {
      let jx = junctions.find((j) => j.otherTable === m.table);
      let created = false;
      // Materializing a brand-new junction is the most speculative action, so
      // gate it on at least middling aggressiveness; below that, only link into
      // junctions that already exist (and otherwise surface a suggestion).
      if (!jx && createJunction && aggressiveness >= 0.25) {
        // No junction connects files to this entity yet — create one so the
        // relationship can be materialized (audited + revertible schema op).
        try {
          const made = await createJunction(m.table);
          if (made) {
            jx = made;
            created = true;
          }
        } catch (e) {
          // internal guideline: surface — a junction-create failure (e.g. cloud permission)
          // silently breaks auto-link, so make the reason visible, not stderr-only.
          const msg = (e as Error).message;
          console.error(`[ingest] auto-create junction files↔${m.table} failed:`, msg);
          mctx.feed.publish({
            table: 'files',
            op: 'update',
            rowId: fileId,
            source: mctx.source,
            summary: `Couldn't create link table files ↔ ${m.table}: ${msg}`,
          });
        }
      }
      if (jx) {
        // Junction exists (or was just created) — materialize the link. Audited
        // + undoable via the feed. No confirmation prompt.
        try {
          // Always supply the junction PK explicitly: an auto-created junction
          // (defineLate, raw `id TEXT PRIMARY KEY`) has no DB-level uuid default,
          // and Postgres — unlike SQLite — rejects a NULL primary key.
          await linkRows(mctx, jx.junction, {
            id: crypto.randomUUID(),
            [jx.fileFk]: fileId,
            [jx.otherFk]: m.id,
          });
          linkedCount++;
          if (created) {
            mctx.feed.publish({
              table: jx.junction,
              op: 'schema',
              rowId: null,
              source: mctx.source,
              summary: `Created link table files ↔ ${m.table} and linked this file`,
            });
          }
        } catch (e) {
          // internal guideline: surface — a link failure (e.g. cloud RLS/permission) would
          // otherwise leave "nothing linked" with no visible reason.
          const msg = (e as Error).message;
          console.error(`[ingest] auto-link to ${m.table} failed:`, msg);
          mctx.feed.publish({
            table: 'files',
            op: 'update',
            rowId: fileId,
            source: mctx.source,
            summary: `Couldn't auto-link "${name}" to ${m.table}: ${msg}`,
          });
        }
      } else {
        // Could not link (no junction + creation unavailable/declined) —
        // surface as a suggestion instead.
        mctx.feed.publish({
          table: 'files',
          op: 'update',
          rowId: fileId,
          source: mctx.source,
          summary: `Looks related to ${m.table} (${m.id})`,
        });
      }
    }

    // Context Constructor: extract the structured objects the document is ABOUT
    // and build them into the schema — reuse an existing entity, or CREATE a new
    // one (inferred columns) when nothing fits — then create the row and link the
    // file. Active at default aggressiveness; new-entity creation gated at ≥ 0.5.
    // Every write is audited + reversible.
    let createdCount = 0;
    if (createEntity && aggressiveness >= 0.4) {
      try {
        const proposed = await extractObjects(
          client,
          text,
          name,
          buildSchema(db),
          temperature,
          untrusted,
        );
        const allowNewEntity = aggressiveness >= 0.5;
        const existing = new Set(db.getRegisteredTableNames().filter((t) => !isNativeEntity(t)));
        for (const obj of proposed) {
          // Resolve the target entity: reuse an existing one, else create it.
          let entity: string | null = existing.has(obj.entity) ? obj.entity : null;
          if (!entity && allowNewEntity) {
            entity = await createEntity(obj.entity, obj.columns);
            if (entity) existing.add(entity);
          }
          if (!entity) continue;
          // Keep only values that map to real columns on the resolved entity.
          const cols = db.getRegisteredColumns(entity);
          if (!cols) continue;
          const row: Record<string, unknown> = { id: crypto.randomUUID() };
          for (const [k, v] of Object.entries(obj.values)) if (k in cols) row[k] = v;
          // Give the row a human-readable name from the extractor's label so its
          // card shows "Acme Consulting Agreement", not "#fea4b07f" — and so the
          // activity-feed bubble names it. New entities always have a `name`
          // column (see createUserEntity); `title` is set too when present.
          if ('name' in cols && row.name == null) row.name = obj.label;
          if ('title' in cols && row.title == null) row.title = obj.label;
          try {
            // createRow audits + publishes a name-aware bubble ("Added <label>
            // to <entity>") that persists to the activity log and backfills on
            // reload — so no extra, non-persisted feed event is published here.
            const { id: rowId } = await createRow(mctx, entity, row);
            createdCount++;
            // Link the source file to the new object (auto-create the junction).
            const ent = entity;
            const jx =
              junctions.find((j) => j.otherTable === ent) ??
              (createJunction ? await createJunction(ent) : null);
            if (jx) {
              await linkRows(mctx, jx.junction, {
                id: crypto.randomUUID(),
                [jx.fileFk]: fileId,
                [jx.otherFk]: rowId,
              });
            }
          } catch (e) {
            console.warn(`[ingest] create ${entity} from document failed:`, (e as Error).message);
          }
        }
      } catch (e) {
        console.warn('[ingest] object extraction failed:', (e as Error).message);
      }
    }

    // Last resort: nothing linked AND nothing created, at high aggressiveness —
    // capture the source as a native `notes` object so it isn't lost.
    if (
      linkedCount === 0 &&
      createdCount === 0 &&
      aggressiveness >= 0.66 &&
      text.trim().length > 0
    ) {
      try {
        const title = name.replace(/\.[^./\\]+$/, '').trim() || 'Note';
        const body = description.length > 0 ? description : text.slice(0, 2000);
        const { id: noteId } = await createRow(mctx, 'notes', {
          id: crypto.randomUUID(),
          title,
          body,
          source_file_id: fileId,
        });
        mctx.feed.publish({
          table: 'notes',
          op: 'insert',
          rowId: noteId,
          source: mctx.source,
          summary: `Captured "${title}" as a note`,
        });
      } catch (e) {
        console.warn('[ingest] auto-create object failed:', (e as Error).message);
      }
    }
    return matches;
  } catch (e) {
    // internal guideline: surface — classification failing means zero auto-links; make the
    // reason visible in the feed, not just stderr.
    const msg = (e as Error).message;
    console.error('[ingest] classify failed:', msg);
    mctx.feed.publish({
      table: 'files',
      op: 'update',
      rowId: fileId,
      source: mctx.source,
      summary: `Couldn't auto-link "${name}": ${msg}`,
    });
    return [];
  }
}
