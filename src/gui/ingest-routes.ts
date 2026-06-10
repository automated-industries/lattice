import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, resolve, join } from 'node:path';
import type { Lattice } from '../lattice.js';
import { FeedBus } from './feed.js';
import { createRow, updateRow, linkRows, type MutationCtx } from './mutations.js';
import { parseFile, describe, type ExtractResult } from './ai/extract.js';
import { describeImage, describePdf } from '../ai/vision.js';
import { crawlUrl } from '../ai/crawl.js';
import type { FileJunction } from './data.js';
import { isNativeEntity } from '../framework/native-entities.js';
import { attachBlob } from '../framework/blob-store.js';
import {
  resolveClaudeAuth,
  aggressivenessToTemperature,
  DEFAULT_AGGRESSIVENESS,
} from './assistant-routes.js';
import { createAnthropicClient } from './ai/chat.js';
import {
  summarizeText,
  classifyLinks,
  extractObjects,
  type CatalogEntity,
  type ClassifyMatch,
  type SchemaEntity,
} from './ai/summarize.js';

/**
 * Ingest endpoints. "Ingest" means reference a local file (or a pasted text
 * snippet) as a row in the native `files` entity and summarize its contents —
 * no bytes are copied into a blob store; `files.path` holds the local path and
 * the preview/extraction read from there. Writes go through the shared
 * mutation primitives with source='ingest', so each lands in the audit log +
 * activity feed.
 *
 * Localhost trust, like the other GUI routes; team-cloud mode does not mount
 * this dispatcher.
 */

interface IngestContext {
  db: Lattice;
  feed: FeedBus;
  softDeletable: Set<string>;
  /** Junctions connecting `files` to other entities, for classifier auto-link. */
  fileJunctions: FileJunction[];
  /** Entity name → human description, fed to the classifier catalog. */
  entityDescriptions: Record<string, string>;
  /**
   * Create (or fetch) the `files ↔ <otherTable>` junction so the classifier can
   * link even when no relationship exists yet. Audited + revertible (schema
   * op). Returns null when the entity can't be linked (native/junction/unknown).
   * Injected by the server so ingest stays decoupled from config/reopen plumbing.
   */
  createJunction?: (otherTable: string) => Promise<FileJunction | null>;
  /**
   * Create (or fetch) a user entity the Context Constructor inferred from the
   * document. Audited + revertible (schema op). Returns the entity name, or null
   * when it can't be created. Injected by the server.
   */
  createEntity?: (entity: string, columns: string[]) => Promise<string | null>;
  /** Inference aggressiveness 0..1 (drives temperature + auto-junction gating). */
  aggressiveness?: number;
  /**
   * Workspace root (the dir holding `data/`). When set, previewable uploads
   * (images/PDFs, which arrive as bytes with no local path) are retained as a
   * content-addressed blob under `data/blobs/` so the GUI can preview them.
   */
  latticeRoot?: string;
  pathname: string;
  method: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function mimeFor(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve_, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      raw += c;
      if (raw.length > 10_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!raw) {
        resolve_({});
        return;
      }
      try {
        resolve_(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const STRUCTURAL = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);
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
async function enrichWithLlm(
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
): Promise<ClassifyMatch[]> {
  if (!text.trim()) return [];
  const auth = await resolveClaudeAuth(db);
  if (!auth) return [];
  let client;
  try {
    client = createAnthropicClient(auth);
  } catch {
    return [];
  }
  const temperature = aggressivenessToTemperature(aggressiveness);
  let description = '';
  try {
    description = (await summarizeText(client, text, name, temperature)).trim();
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
          console.warn(
            `[ingest] auto-create junction files↔${m.table} failed:`,
            (e as Error).message,
          );
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
              source: 'ingest',
              summary: `Created link table files ↔ ${m.table} and linked this file`,
            });
          }
        } catch (e) {
          console.warn(`[ingest] auto-link to ${m.table} failed:`, (e as Error).message);
        }
      } else {
        // Could not link (no junction + creation unavailable/declined) —
        // surface as a suggestion instead.
        mctx.feed.publish({
          table: 'files',
          op: 'update',
          rowId: fileId,
          source: 'ingest',
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
        const proposed = await extractObjects(client, text, name, buildSchema(db), temperature);
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
          source: 'ingest',
          summary: `Created a new note "${title}" — it didn't fit any existing record`,
        });
      } catch (e) {
        console.warn('[ingest] auto-create object failed:', (e as Error).message);
      }
    }
    return matches;
  } catch (e) {
    console.warn('[ingest] classify failed:', (e as Error).message);
    return [];
  }
}

/**
 * Run {@link enrichWithLlm} for an already-created file row, converting any
 * thrown error into a LOUD, non-silent outcome: the failure is logged
 * to stderr with its stack, recorded durably on the row (`extraction_status =
 * 'enrichment_failed'`, so it's queryable rather than living only in a toast
 * that vanishes), and surfaced to the client. Returns the suggested links on
 * success, or `null` when it has already responded with the failure (caller
 * must `return true` immediately). Shared by the upload + text ingest paths so
 * both handle enrichment failure identically.
 */
async function enrichOrFail(
  mctx: MutationCtx,
  db: Lattice,
  fileId: string,
  text: string,
  name: string,
  ctx: IngestContext,
  res: ServerResponse,
): Promise<ClassifyMatch[] | null> {
  try {
    return await enrichWithLlm(
      mctx,
      db,
      fileId,
      text,
      name,
      ctx.fileJunctions,
      ctx.entityDescriptions,
      ctx.createJunction,
      ctx.aggressiveness,
      ctx.createEntity,
    );
  } catch (e) {
    const err = e as Error;
    console.error(
      `[ingest] enrichment failed for file ${fileId}: ${err.message}\n${err.stack ?? ''}`,
    );
    await updateRow(mctx, 'files', fileId, { extraction_status: 'enrichment_failed' }).catch(
      (e2: unknown) => {
        console.error(
          `[ingest] could not mark enrichment_failed on ${fileId}: ${(e2 as Error).message}`,
        );
      },
    );
    sendJson(res, { id: fileId, extraction_status: 'enrichment_failed', error: err.message }, 201);
    return null;
  }
}

/**
 * For an image, describe it with Claude vision instead of text extraction.
 * Best-effort: returns null when there's no Claude auth, the file isn't an
 * image, or the call fails — the caller then falls back to {@link parseFile}
 * (which marks images `skipped`). `sharp` is loaded lazily inside the vision
 * module, so non-image ingests never touch it.
 */
async function extractImage(
  db: Lattice,
  path: string,
  mime: string,
): Promise<{ text: string; skip: boolean } | null> {
  if (!mime.startsWith('image/')) return null;
  const auth = await resolveClaudeAuth(db);
  if (!auth) return null;
  try {
    const text = await describeImage(auth, path);
    return text.trim() ? { text, skip: false } : null;
  } catch (e) {
    console.warn('[ingest] image vision failed:', (e as Error).message);
    return null;
  }
}

/**
 * Full ingest extraction. Claude vision for images; otherwise markitdown/text
 * via {@link parseFile}; and when that yields nothing for a PDF — e.g. a
 * scanned/image-only PDF with no text layer, which markitdown can't read —
 * Claude's native PDF document read as a fallback. Best-effort + AI-gated:
 * with no Claude auth it degrades to parseFile's result (a `skipped` row).
 */
async function extractSource(
  db: Lattice,
  path: string,
  mime: string,
  name: string,
): Promise<ExtractResult> {
  const vision = await extractImage(db, path, mime);
  if (vision) return vision;
  const parsed = await parseFile(path, mime, name);
  if (!parsed.skip) return parsed;
  if (mime === 'application/pdf') {
    const auth = await resolveClaudeAuth(db);
    if (auth) {
      try {
        const text = await describePdf(auth, path);
        if (text.trim()) return { ...parsed, text, skip: false };
      } catch (e) {
        console.warn('[ingest] Claude PDF read failed:', (e as Error).message);
      }
    }
  }
  return parsed;
}

/** A pasted body that is exactly one http(s) URL — a candidate to crawl. */
function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  return /^https?:\/\/\S+$/i.test(t) && !/\s/.test(t);
}

function readBuffer(req: IncomingMessage, maxBytes = 50_000_000): Promise<Buffer> {
  return new Promise((resolve_, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) reject(new Error('upload too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      resolve_(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

const INGEST_PATHS = new Set(['/api/ingest/text', '/api/ingest/file', '/api/ingest/upload']);

export async function dispatchIngestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: IngestContext,
): Promise<boolean> {
  if (ctx.method !== 'POST' || !INGEST_PATHS.has(ctx.pathname)) return false;

  const mctx: MutationCtx = {
    db: ctx.db,
    feed: ctx.feed,
    softDeletable: ctx.softDeletable,
    source: 'ingest',
  };

  // Raw-bytes upload (drag-drop / paperclip from the browser, which can't
  // expose a local path). Extract then discard the bytes — we keep the text +
  // description, not the file (path stays null, like a text paste).
  if (ctx.pathname === '/api/ingest/upload') {
    const rawName =
      (typeof req.headers['x-filename'] === 'string' && req.headers['x-filename']) || '';
    // The client percent-encodes the filename so a Unicode name survives the
    // ISO-8859-1-only HTTP header. Decode it back; tolerate a legacy/raw value.
    let name = 'upload';
    if (rawName) {
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = rawName;
      }
    }
    const mime = req.headers['content-type'] ?? 'application/octet-stream';
    let buf: Buffer;
    try {
      buf = await readBuffer(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    if (buf.length === 0) {
      sendJson(res, { error: 'empty upload' }, 400);
      return true;
    }
    const tmp = join(tmpdir(), `lattice-ingest-${crypto.randomUUID()}${extname(name)}`);
    let result;
    let blob: { blob_path: string; sha256: string } | null = null;
    try {
      await writeFile(tmp, buf);
      result = await extractSource(ctx.db, tmp, mime, name);
      // Retain a content-addressed blob for previewable uploads (images / PDFs).
      // Browser drag-drops arrive as bytes with no local path, so this is the
      // only way the GUI can render an inline preview later.
      if (ctx.latticeRoot && (mime.startsWith('image/') || mime === 'application/pdf')) {
        try {
          const meta = await attachBlob(tmp, ctx.latticeRoot);
          blob = { blob_path: meta.blob_path, sha256: meta.sha256 };
        } catch (e) {
          console.warn('[ingest] blob retain failed:', (e as Error).message);
        }
      }
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
    const { id } = await createRow(mctx, 'files', {
      id: crypto.randomUUID(),
      original_name: name,
      mime,
      size_bytes: buf.length,
      extracted_text: result.text,
      description: describe(result.text, mime, name),
      extraction_status: result.skip ? 'skipped' : 'extracted',
      ...(blob ? { ref_kind: 'blob', blob_path: blob.blob_path, sha256: blob.sha256 } : {}),
    });
    let suggestedLinks: ClassifyMatch[] = [];
    if (!result.skip) {
      const links = await enrichOrFail(mctx, ctx.db, id, result.text, name, ctx, res);
      if (links === null) return true; // enrichment failed — already reported
      suggestedLinks = links;
    }
    sendJson(
      res,
      { id, extraction_status: result.skip ? 'skipped' : 'extracted', suggestedLinks },
      201,
    );
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (e) {
    sendJson(res, { error: (e as Error).message }, 400);
    return true;
  }

  if (ctx.pathname === '/api/ingest/text') {
    const rawText = typeof body.text === 'string' ? body.text : '';
    if (!rawText.trim()) {
      sendJson(res, { error: 'text is required' }, 400);
      return true;
    }
    let title =
      typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Pasted text';
    let content = rawText;
    let mime = 'text/plain';
    // A bare URL is crawled for its readable text; the URL itself is preserved
    // on the row as a `cloud_ref` so the source is never lost.
    const sourceUrl = looksLikeUrl(rawText) ? rawText.trim() : null;
    if (sourceUrl) {
      try {
        const crawled = await crawlUrl(sourceUrl);
        if (crawled.text.trim()) {
          content = crawled.text;
          if (crawled.title) title = crawled.title;
          mime = crawled.mime || 'text/html';
        }
      } catch (e) {
        console.warn('[ingest] url crawl failed:', (e as Error).message);
      }
    }
    const { id } = await createRow(mctx, 'files', {
      id: crypto.randomUUID(),
      original_name: title,
      mime,
      size_bytes: Buffer.byteLength(content, 'utf8'),
      extracted_text: content.slice(0, 200_000),
      description: describe(content, mime, title),
      extraction_status: 'extracted',
      ...(sourceUrl ? { ref_kind: 'cloud_ref', ref_uri: sourceUrl, ref_provider: 'web' } : {}),
    });
    const suggestedLinks = await enrichOrFail(mctx, ctx.db, id, content, title, ctx, res);
    if (suggestedLinks === null) return true; // enrichment failed — already reported
    sendJson(res, { id, extraction_status: 'extracted', suggestedLinks }, 201);
    return true;
  }

  // /api/ingest/file — reference a local path.
  const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
  if (!rawPath) {
    sendJson(res, { error: 'path is required' }, 400);
    return true;
  }
  const abs = resolve(rawPath);
  let size = 0;
  try {
    const st = statSync(abs);
    if (!st.isFile()) {
      sendJson(res, { error: 'path is not a file' }, 400);
      return true;
    }
    size = st.size;
  } catch {
    sendJson(res, { error: `file not found: ${abs}` }, 400);
    return true;
  }

  const name = basename(abs);
  const mime = mimeFor(name);
  const { id } = await createRow(mctx, 'files', {
    id: crypto.randomUUID(),
    path: abs,
    original_name: name,
    mime,
    size_bytes: size,
    extraction_status: 'pending',
  });

  // Extract inline (the GUI is local; files are typically small). Failures are
  // recorded on the row, not swallowed.
  try {
    const result = await extractSource(ctx.db, abs, mime, name);
    await updateRow(mctx, 'files', id, {
      extracted_text: result.text,
      description: describe(result.text, mime, name),
      extraction_status: result.skip ? 'skipped' : 'extracted',
    });
    const suggestedLinks = result.skip
      ? []
      : await enrichWithLlm(
          mctx,
          ctx.db,
          id,
          result.text,
          name,
          ctx.fileJunctions,
          ctx.entityDescriptions,
          ctx.createJunction,
          ctx.aggressiveness,
          ctx.createEntity,
        );
    sendJson(
      res,
      { id, extraction_status: result.skip ? 'skipped' : 'extracted', suggestedLinks },
      201,
    );
  } catch (e) {
    const err = e as Error;
    // Log loudly server-side (with stack) in addition to the durable
    // row status + client-surfaced error — never let the real cause vanish.
    console.error(
      `[ingest] extraction/enrichment failed for file ${id}: ${err.message}\n${err.stack ?? ''}`,
    );
    await updateRow(mctx, 'files', id, {
      extraction_status: 'failed',
      description: `Extraction failed: ${err.message}`,
    });
    sendJson(res, { id, extraction_status: 'failed', error: err.message }, 201);
  }
  return true;
}
