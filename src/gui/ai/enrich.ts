import type { Lattice } from '../../lattice.js';
import type { FileJunction } from '../data.js';
import { isNativeEntity } from '../../framework/native-entities.js';
import { STRUCTURAL } from '../file-row.js';
import { createRow, updateRow, linkRows, type MutationCtx } from '../mutations.js';
import { recordLineage } from '../lineage-store.js';
import {
  aggressivenessToTemperature,
  clarifyFloor,
  getClarifyThreshold,
  DEFAULT_AGGRESSIVENESS,
} from '../assistant-routes.js';
import { enqueueQuestion } from '../questions.js';
import { resolveLlmClient } from './provider.js';
import {
  summarizeText,
  classifyLinks,
  extractObjects,
  extractionTruncationNote,
  rephraseClarifyQuestion,
  type CatalogEntity,
  type ClassifyMatch,
  type ExtractedObject,
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

/** At most this many clarification questions may be enqueued per ingested file. */
const MAX_QUESTIONS_PER_FILE = 2;

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
 * True when the deterministic structured importer owns row creation for this
 * file — tabular by TYPE (spreadsheet/CSV), or the importer actually RAN on it
 * (a .docx/.pptx with substantive embedded tables). The LLM object extractor
 * must not also manufacture rows from such a file: two modellers on one
 * document is the duplication that produced a lossy hand-authored copy beside
 * the faithful import. Gated on whether the importer ran — not on extension —
 * so a prose document the importer declined still gets LLM extraction.
 * Exported pure so the gate itself is unit-testable.
 */
export function deterministicRowOwner(name: string, structuredImportRan: boolean): boolean {
  return /\.(xlsx?|csv|tsv)$/i.test(name) || structuredImportRan;
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
  // When the source file was ingested PRIVATE, every derived write must force
  // itself private too: the forced-visibility GUC is transaction-local, so the
  // file insert's stamp does NOT bleed into these separate writes — each derived
  // entity row, junction link, and fallback note would otherwise fall back to
  // its own table default (shared-to-everyone on a cloud) and leak the private
  // file's contents + relationships.
  privateMode = false,
  // Materialize record-to-record links for each extracted object, per the extractor's
  // stated `links` — to the other co-extracted objects (a meeting ↔ its attendees) AND
  // to the existing records the classifier matched. Same shape as createUserJunction.
  // Omit → no cross-object linking (each object still links to the source file).
  createObjectJunction?: (
    tableA: string,
    tableB: string,
  ) => Promise<{
    junction: string;
    tableA: string;
    aFk: string;
    tableB: string;
    bFk: string;
  } | null>,
  // True when the deterministic structured importer already ran for THIS file
  // (autoImportStructured returned a result — silent import or a proposal). The
  // LLM object extractor must not ALSO manufacture rows from the same file: two
  // modellers on one document is exactly the duplication that produced a lossy
  // hand-authored copy beside the faithful import. Gated on whether the importer
  // actually RAN — not on file extension — so a prose .docx the importer declined
  // still gets LLM extraction.
  structuredImportRan = false,
): Promise<ClassifyMatch[]> {
  if (!text.trim()) return [];
  let client;
  try {
    client = await resolveLlmClient(db);
  } catch (e) {
    // internal guideline: never swallow. A client-init failure (e.g. the Anthropic SDK
    // not installed) means NO auto-link for this file — say so loudly + visibly instead
    // of returning [] in silence.
    const msg = (e as Error).message;
    console.error('[ingest] auto-link unavailable — model client init failed:', msg);
    mctx.feed.publish({
      table: 'files',
      op: 'update',
      rowId: fileId,
      source: mctx.source,
      summary: `Couldn't auto-link "${name}": AI client unavailable`,
    });
    return [];
  }
  if (!client) {
    // No provider configured → auto-link can't run. Log it (rather than feed-spamming
    // local non-AI users) so "why didn't it link?" is answerable from the log.
    console.warn('[ingest] auto-link skipped — no model provider configured');
    return [];
  }
  // Force private on derived writes when the source file is private (see the
  // privateMode param doc). undefined ⇒ inherit the table default, as before.
  const forceVis: 'private' | undefined = privateMode ? 'private' : undefined;
  const temperature = aggressivenessToTemperature(aggressiveness);
  // Parallelize the three per-file LLM round-trips. They are input-independent —
  // each takes only the document text + a snapshot of the catalog/schema, and the
  // description is consumed only as a post-call side-effect — so running them at
  // once collapses the per-file LLM wall-clock from their sum toward the single
  // slowest call (~2–3×). Hoist buildCatalog/buildSchema so each is built ONCE
  // before the calls. Every side-effect below runs AFTER settle, in the SAME order
  // as before, and preserves the prior semantics EXACTLY — in particular: a
  // classify failure still zeroes auto-links AND skips extract + the note fallback
  // and returns []; an extract failure still only warns and keeps the links + note
  // fallback; the description is still best-effort and independent.
  // A spreadsheet / CSV is materialized FAITHFULLY (every row) by the deterministic
  // structured importer (autoImportStructured → materializeImport) — the single owner of
  // tabular row creation. The prose-oriented LLM object extractor must NOT also manufacture
  // rows from the same file: pointed at a 53-row workbook it emitted a lossy 3-row summary,
  // and two parallel paths creating rows from one file is exactly the duplication to avoid.
  // So for tabular files the extractor is disabled and the importer owns the data. (The
  // other enrichment — a description + auto-linking the file to related records — still runs.)
  const deterministicOwner = deterministicRowOwner(name, structuredImportRan);
  const extractGate = !!createEntity && aggressiveness >= 0.4 && !deterministicOwner;
  // buildCatalog READS every user table; a transient DB read failure here must not
  // throw out of this best-effort enricher — that would leave the already-saved file
  // row un-enriched AND make callers (e.g. chat auto-ingest) believe the whole ingest
  // failed, so they skip the "already saved" signal and the user's content gets
  // re-created. Degrade to an empty catalog: classify then returns [] (auto-link
  // skipped), while the description + object extraction still run.
  let catalog: CatalogEntity[] = [];
  try {
    catalog = await buildCatalog(db, descriptions);
  } catch (e) {
    console.warn('[ingest] catalog build failed; skipping auto-link:', (e as Error).message);
  }
  const schema = buildSchema(db);
  const [descR, matchesR, proposedR] = await Promise.allSettled([
    summarizeText(client, text, name, temperature, untrusted),
    classifyLinks(client, text, name, catalog, temperature, untrusted),
    extractGate
      ? extractObjects(client, text, name, schema, temperature, untrusted)
      : Promise.resolve<ExtractedObject[]>([]),
  ]);

  // (1) Description — best-effort + independent of the other two, as before.
  let description = '';
  if (descR.status === 'fulfilled') {
    description = descR.value.trim();
    if (description) {
      try {
        await updateRow(mctx, 'files', fileId, { description });
      } catch (e) {
        console.warn('[ingest] LLM description failed:', (e as Error).message);
      }
    }
  } else {
    console.warn('[ingest] LLM description failed:', (descR.reason as Error).message);
  }

  // (2) A classify FAILURE means zero auto-links AND skips extract + the note
  // fallback, returning [] — reproducing the old outer try/catch that wrapped
  // classify + extract together (same feed note).
  if (matchesR.status === 'rejected') {
    const msg = matchesR.reason instanceof Error ? matchesR.reason.message : 'unknown';
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
  try {
    const matches = matchesR.value;
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
          await linkRows(
            mctx,
            jx.junction,
            {
              id: crypto.randomUUID(),
              [jx.fileFk]: fileId,
              [jx.otherFk]: m.id,
            },
            forceVis,
          );
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
    // Same predicate as extractGate above (kept inline so TS narrows createEntity
    // to defined for the createEntity(...) call in the loop) — including the
    // deterministic-owner exclusion, so a workbook or an already-imported document
    // never manufactures rows here.
    if (createEntity && aggressiveness >= 0.4 && !deterministicOwner) {
      try {
        // Re-throw a rejected extract into this same catch so the old
        // "object extraction failed" warn (and keep links + note fallback) holds.
        if (proposedR.status === 'rejected') throw proposedR.reason;
        const proposed = proposedR.value;
        // Disclose partial coverage when the document exceeded the extraction
        // window budget — only a prefix was scanned for structured objects, so
        // surface that rather than silently under-extracting an oversized file.
        const truncNote = extractionTruncationNote(name, text.length);
        if (truncNote) {
          mctx.feed.publish({
            table: 'files',
            op: 'update',
            rowId: fileId,
            source: mctx.source,
            summary: truncNote,
          });
        }
        const allowNewEntity = aggressiveness >= 0.5;
        const existing = new Set(db.getRegisteredTableNames().filter((t) => !isNativeEntity(t)));
        // Ask-when-marginal gate: each extracted object carries the model's 0-1
        // confidence in its target-entity decision. At or above the clarify
        // threshold the object is materialized exactly as before; in
        // [floor, threshold) nothing is created — a short question is enqueued
        // instead (capped per file); below the floor the object is dropped
        // silently, like the low-aggressiveness paths. A MISSING confidence is
        // treated as 1.0, so a model that never emits the field (and every
        // pre-existing flow) behaves identically to before.
        const clarifyThreshold = getClarifyThreshold();
        const floor = clarifyFloor(clarifyThreshold);
        let questionsAsked = 0;
        // Every object actually created this pass (label → its entity + row id), so a
        // second pass can materialize the relationships the extractor stated between them.
        const createdObjects: { label: string; entity: string; rowId: string; links: string[] }[] =
          [];
        for (const obj of proposed) {
          const confidence = obj.confidence ?? 1;
          if (confidence < clarifyThreshold) {
            if (confidence >= floor && questionsAsked < MAX_QUESTIONS_PER_FILE) {
              questionsAsked++;
              // Rephrase the structural prompt into business-forward language the
              // user actually thinks in ("Do you want to group all your driver's
              // licenses together?" not "add records to <entity>"). Best-effort:
              // on any failure `phrased` is null and the structural text stands, so
              // the question is never blocked or dropped — only its wording upgraded.
              // The stored context/action is unchanged: the options are recorded as
              // the answer, the action stays `none`.
              const phrased = await rephraseClarifyQuestion(
                client,
                name,
                obj.entity,
                temperature,
                untrusted,
              );
              // v1 is deliberately conservative: the answer RECORDS the user's
              // intent — no deferred action re-triggers the skipped extraction
              // automatically — and only a free-form answer is persisted, as
              // the (already existing) target entity's definition.
              await enqueueQuestion(mctx.db, mctx.feed, {
                source: 'enrich',
                question: phrased
                  ? phrased.question
                  : `Is "${name}" meant to add records to ${obj.entity}?`,
                options: phrased
                  ? [phrased.yes, phrased.no]
                  : ['Yes, add them', 'No, keep it as just a file'],
                context: {
                  action: { kind: 'none' },
                  enrich: existing.has(obj.entity)
                    ? [{ target: 'table_definition', table: obj.entity }]
                    : [],
                  // Name the file this question is about so the card displays
                  // "Re: <filename>" and can navigate to the source file.
                  subject: { table: 'files', rowId: fileId, label: name },
                },
                feedSource: mctx.source,
              });
            }
            continue; // marginal or noise — never create/act on this decision
          }
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
            const { id: rowId } = await createRow(mctx, entity, row, forceVis);
            createdCount++;
            createdObjects.push({ label: obj.label, entity, rowId, links: obj.links ?? [] });
            // Provenance: record that this object row was EXTRACTED from the
            // source file (raw tier) — durable, additive lineage bookkeeping.
            await recordLineage(mctx.db.adapter, [
              {
                objectTable: entity,
                objectId: rowId,
                sourceKind: 'file',
                sourceTable: 'files',
                sourceId: fileId,
                tier: 'raw',
                relation: 'extracted_from',
              },
            ]);
            // Link the source file to the new object (auto-create the junction).
            // Force the junction private too when the source file is private:
            // even when the extracted object REUSES an existing SHARED entity,
            // the private-file↔entity association itself must not leak through an
            // 'everyone'-default junction row.
            const ent = entity;
            const jx =
              junctions.find((j) => j.otherTable === ent) ??
              (createJunction ? await createJunction(ent) : null);
            if (jx) {
              await linkRows(
                mctx,
                jx.junction,
                {
                  id: crypto.randomUUID(),
                  [jx.fileFk]: fileId,
                  [jx.otherFk]: rowId,
                },
                forceVis,
              );
            }
          } catch (e) {
            console.warn(`[ingest] create ${entity} from document failed:`, (e as Error).message);
          }
        }
        // Second pass: materialize the relationships the extractor stated for each
        // extracted object — to the OTHER co-extracted objects AND to the EXISTING
        // records the classifier matched. So an extracted meeting links to an attendee
        // whether that person was co-extracted in this pass or already existed as a
        // record. Deterministic: the engine links the pairs the extractor named (by
        // label); there is no per-object-type rule. Gated on a junction creator + at
        // least one created object.
        if (createObjectJunction && createdObjects.length > 0) {
          // A label is NOT unique — two records in different tables can share it
          // ("Apollo" the person vs "Apollo" the project) — so a bare label must never
          // be guessed: linking the wrong record silently corrupts the graph. Group
          // candidates by label WITHOUT overwriting, keeping co-extracted and existing
          // records separate.
          type Target = { entity: string; rowId: string };
          const push = (map: Map<string, Target[]>, k: string, v: Target): void => {
            const arr = map.get(k);
            if (arr) arr.push(v);
            else map.set(k, [v]);
          };
          const coByLabel = new Map<string, Target[]>();
          for (const o of createdObjects)
            push(coByLabel, o.label.toLowerCase(), { entity: o.entity, rowId: o.rowId });
          const existingByLabel = new Map<string, Target[]>();
          for (const m of matches) {
            const rec = catalog
              .find((c) => c.table === m.table)
              ?.records.find((r) => r.id === m.id);
            if (rec)
              push(existingByLabel, rec.label.toLowerCase(), { entity: m.table, rowId: m.id });
          }
          // The extractor's `links` name labels from its OWN output, so a CO-EXTRACTED
          // object is the intended target and wins; fall through to an EXISTING record
          // ONLY when the label named no co-extracted object at all. Either way link only
          // when exactly ONE linkable candidate exists — 0 or >1 (a collision) is skipped,
          // not guessed. Self and same-entity pairs (a table-to-itself junction, which
          // createUserJunction refuses) are excluded before counting.
          const resolve = (label: string, o: Target): Target | null => {
            const rawCo = (coByLabel.get(label) ?? []).filter((t) => t.rowId !== o.rowId);
            const coLinkable = rawCo.filter((t) => t.entity !== o.entity);
            if (coLinkable.length === 1) return coLinkable[0] ?? null;
            if (coLinkable.length > 1) return null; // ambiguous among co-extracted
            // A co-extracted match existed but wasn't linkable (same entity) — don't
            // substitute a same-labelled existing record; that's a different thing.
            if (rawCo.length > 0) return null;
            const ex = (existingByLabel.get(label) ?? []).filter(
              (t) => t.rowId !== o.rowId && t.entity !== o.entity,
            );
            return ex.length === 1 ? (ex[0] ?? null) : null;
          };

          const done = new Set<string>();
          for (const o of createdObjects) {
            for (const targetLabel of o.links) {
              const t = resolve(targetLabel.toLowerCase(), { entity: o.entity, rowId: o.rowId });
              if (!t) continue;
              const key = [o.rowId, t.rowId].sort().join('|');
              if (done.has(key)) continue;
              done.add(key);
              try {
                const jx = await createObjectJunction(o.entity, t.entity);
                if (!jx) continue;
                const oFk = jx.tableA === o.entity ? jx.aFk : jx.bFk;
                const tFk = jx.tableA === o.entity ? jx.bFk : jx.aFk;
                await linkRows(
                  mctx,
                  jx.junction,
                  { id: crypto.randomUUID(), [oFk]: o.rowId, [tFk]: t.rowId },
                  forceVis,
                );
              } catch (e) {
                console.warn(
                  `[ingest] cross-link ${o.entity} ↔ ${t.entity} failed:`,
                  (e as Error).message,
                );
              }
            }
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
        const { id: noteId } = await createRow(
          mctx,
          'notes',
          {
            id: crypto.randomUUID(),
            title,
            body,
            source_file_id: fileId,
          },
          forceVis,
        );
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
