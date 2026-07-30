import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, resolve, join } from 'node:path';
import type { Lattice } from '../lattice.js';
import { normalizeUserUrl } from '../sources/url-safety.js';
import { FeedBus } from './feed.js';
import { createRow, updateRow, type MutationCtx } from './mutations.js';
import { localFileOpenEnabled } from './files-routes.js';
import { parseFile, describe, type ExtractResult } from './ai/extract.js';
import { gateExtractionByPath } from './ai/extract-gate.js';
import { describeImage, describePdf } from '../ai/vision.js';
import type { FileJunction } from './data.js';
import { attachBlob } from '../framework/blob-store.js';
import { createS3Store, s3Key } from '../framework/s3-store.js';
import { resolveActiveS3Config } from '../framework/s3-config.js';
import { createHash } from 'node:crypto';
import { resolveVisionAuth } from './ai/provider.js';
import { type ClassifyMatch } from './ai/summarize.js';
import { sendJson, readJson } from './http.js';
import { MAX_INGEST_BYTES } from '../ops/paging.js';
// LLM enrichment (description + auto-link + object extraction) is a shared leaf
// module so both the ingest routes and the assistant's URL-ingest tool reuse it.
import { enrichWithLlm, type DroppedExtraction } from './ai/enrich.js';
// The unified URL→file ingest path (SSRF + policy + rate-limit + untrusted
// enrichment), shared with the assistant's ingest_url tool.
import { ingestUrlAsFile, type UrlIngestEnrich } from './ingest-url.js';
// File-row construction helpers live in a leaf module so the assistant's
// create_artifact tool can reuse them without an import cycle (see file-row.ts).
import { fileIdentity, requiredFileDefaults } from './file-row.js';
import { columnDescriptionHook } from './meta-gen.js';
import { findExactFileDupesOf, mergeDuplicates, type DedupServiceCtx } from './dedup-service.js';
// Smart structured import: a recognized re-upload of a known document is brought
// in as a new dated snapshot automatically (the assistant "door" for import).
import { autoImportStructured, statedCountNotices, type AutoImportResult } from './import-auto.js';
import { excelImportWarnings } from '../import/excel.js';

/**
 * Ingest endpoints. "Ingest" means reference a local file (or a pasted text
 * snippet) as a row in the native `files` entity and summarize its contents —
 * no bytes are copied into a blob store; the row records a `local_ref`
 * (`ref_kind='local_ref'`, `ref_uri` = the absolute path) and the
 * preview/extraction read from there. Writes go through the shared
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
  /**
   * Create (or fetch) a junction between two USER entities — used to cross-link the
   * objects extracted from ONE document to each other (a meeting ↔ its attendees), not
   * only to the source file. Injected by the server; omit → no cross-object linking.
   */
  createObjectJunction?: (
    tableA: string,
    tableB: string,
  ) => Promise<{
    junction: string;
    tableA: string;
    aFk: string;
    tableB: string;
    bFk: string;
  } | null>;
  /** Inference aggressiveness 0..1 (drives temperature + auto-junction gating). */
  aggressiveness?: number;
  /**
   * Workspace root (the dir holding `data/`). When set, previewable uploads
   * (images/PDFs, which arrive as bytes with no local path) are retained as a
   * content-addressed blob under `data/blobs/` so the GUI can preview them.
   */
  latticeRoot?: string;
  /** Active config path, to resolve the workspace's S3 settings (cloud uploads
   *  also push bytes to S3 so other members can pull them). */
  configPath?: string;
  /** Rendered-context output dir — with configPath, lets auto-dedup re-point a
   *  merged file's many-to-many links onto the surviving copy, and is where the
   *  ingest's own render stage writes the fresh row's context. */
  outputDir?: string;
  /**
   * Whether this workspace maintains the rendered markdown tree. When false the
   * user has opted out of the file bridge entirely, so the ingest render stage is
   * skipped along with every other render.
   */
  autoRender?: boolean;
  /** GUI session id, recorded on the auto-dedup merge's audit entries. */
  sessionId?: string;
  /**
   * Called once a DETACHED ingest has actually finished writing. The synchronous
   * route's post-ingest work can run as soon as the handler returns, because by
   * then the rows exist — but a background job has written nothing at that point,
   * so anything that inspects the resulting data (keeping the model a clean star
   * schema, for one) has to be re-run when the job settles or it inspects a
   * workspace the ingest has not touched yet.
   */
  onIngestComplete?: () => void;
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

/**
 * Document / data MIME types whose original bytes are worth retaining as a
 * content-addressed blob on upload, BEYOND the inline-previewable image/PDF set
 * and the `text/*` prefix handled in {@link isRetainableMime}. A browser
 * drag-drop arrives as bytes with no local path, so if we don't keep the blob
 * the original file is gone after text extraction — leaving nothing to download
 * or open in the file view.
 */
const RETAINABLE_DOC_MIMES = new Set<string>([
  'application/pdf',
  // Office Open XML (docx / xlsx / pptx)
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Legacy MS Office (doc / xls / ppt)
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  // OpenDocument (odt / ods / odp)
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  // Structured-text / data formats not caught by the text/* prefix
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/rtf',
  'application/epub+zip',
]);

function isRetainableMime(mime: string): boolean {
  return (
    mime.startsWith('image/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime.startsWith('text/') ||
    RETAINABLE_DOC_MIMES.has(mime)
  );
}

/**
 * Whether an uploaded file's original bytes should be retained as a blob.
 *
 * True for images, audio, video, any `text/*` type, and the document/data
 * types in {@link RETAINABLE_DOC_MIMES}; false for arbitrary binaries
 * (`application/octet-stream`, archives, executables, disk images, …) — for
 * those we keep the extracted text + description but not a blob we can't
 * preview or do anything useful with. Falls back to the filename's
 * extension-derived type when the provided content-type is generic, so a
 * `report.docx` posted as `application/octet-stream` is still recognized.
 */
export function shouldRetainUploadBlob(mime: string, name = ''): boolean {
  // Normalize: drop any parameters (`; charset=…`) and lower-case, so a
  // `application/json; charset=utf-8` or `TEXT/CSV` still matches.
  const base = ((mime || '').split(';')[0] ?? '').trim().toLowerCase();
  if (isRetainableMime(base)) return true;
  if (!base || base === 'application/octet-stream') return isRetainableMime(mimeFor(name));
  return false;
}

/** Build the URL-ingest enrichment context from a route's {@link IngestContext}. */
function enrichContext(ctx: IngestContext): UrlIngestEnrich {
  return {
    fileJunctions: ctx.fileJunctions,
    entityDescriptions: ctx.entityDescriptions,
    ...(ctx.createJunction ? { createJunction: ctx.createJunction } : {}),
    ...(ctx.aggressiveness !== undefined ? { aggressiveness: ctx.aggressiveness } : {}),
    ...(ctx.createEntity ? { createEntity: ctx.createEntity } : {}),
    ...(ctx.createObjectJunction ? { createObjectJunction: ctx.createObjectJunction } : {}),
  };
}

/**
 * The outcome of enriching one file row. A failure is a first-class VALUE rather
 * than a thrown error or a response written from deep inside the pipeline, so the
 * synchronous route and the detached background job can report the identical
 * failure through their own transport (a response body vs a settled job) without
 * either one duplicating the recovery logic.
 */
type EnrichOutcome =
  | { ok: true; links: ClassifyMatch[]; dropped: DroppedExtraction[] }
  | { ok: false; error: string };

/** The response body for an enrichment failure — one shape, both transports. */
function enrichFailurePayload(fileId: string, error: string): Record<string, unknown> {
  return { id: fileId, extraction_status: 'enrichment_failed', error };
}

/**
 * Run {@link enrichWithLlm} for an already-created file row, converting any
 * thrown error into a LOUD, non-silent outcome: the failure is logged
 * to stderr with its stack, recorded durably on the row (`extraction_status =
 * 'enrichment_failed'`, so it's queryable rather than living only in a toast
 * that vanishes), and returned for the caller to surface. Shared by the upload +
 * text ingest paths so both handle enrichment failure identically.
 */
async function enrichOrReport(
  mctx: MutationCtx,
  db: Lattice,
  fileId: string,
  text: string,
  name: string,
  ctx: IngestContext,
  privateMode: boolean,
  structuredImportRan = false,
): Promise<EnrichOutcome> {
  try {
    const links = await enrichWithLlm(
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
      false,
      privateMode,
      ctx.createObjectJunction,
      structuredImportRan,
    );
    // `dropped` rides on the enrich result as a non-index property of an array,
    // which JSON.stringify omits. Lift it into a plain field here (once, for every
    // caller) or an ingest reports clean while extractions were actually refused.
    const dropped = (links as Partial<{ dropped: DroppedExtraction[] }>).dropped ?? [];
    return { ok: true, links, dropped };
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
    return { ok: false, error: err.message };
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
  const auth = await resolveVisionAuth(db);
  if (!auth) return null;
  try {
    const text = await describeImage(auth, path, { mediaType: mime });
    return text.trim() ? { text, skip: false } : null;
  } catch (e) {
    // Surface the REAL reason (auth/proxy/normalization) in the logs — a silent empty result made
    // an image ingest look like "no source text" with no clue why (a cloud-vision failure mode).
    console.warn(`[ingest] image vision failed for ${mime}:`, (e as Error).message);
    return null;
  }
}

/**
 * Full ingest extraction. Claude vision for images; otherwise native text
 * extraction via {@link parseFile} (PDF / Office / OpenDocument / EPUB / RTF, no
 * external CLI); and when that yields nothing for a PDF — e.g. a scanned/image-only
 * PDF with no text layer, which has no text to extract — Claude's native PDF
 * document read as a fallback. Best-effort + AI-gated: with no Claude auth it
 * degrades to parseFile's result (a `skipped` row).
 *
 * Large inputs run through the heavy-extraction lane: the transients here
 * (archive inflation, PDF parse graphs, the scanned-PDF base64 request body)
 * scale with input size, and the ingest pool runs several files at once —
 * serializing just the big ones keeps peak memory flat without slowing the
 * long tail of ordinary documents.
 */
function extractSource(
  db: Lattice,
  path: string,
  mime: string,
  name: string,
): Promise<ExtractResult> {
  return gateExtractionByPath(path, async () => {
    const vision = await extractImage(db, path, mime);
    if (vision) return vision;
    const parsed = await parseFile(path, mime, name);
    if (!parsed.skip) return parsed;
    if (mime === 'application/pdf') {
      const auth = await resolveVisionAuth(db);
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
  });
}

/** A pasted body that is exactly one web address — a candidate to crawl. Accepts a scheme-prefixed
 *  URL OR a bare domain the user typed (no scheme); still single-token (no internal whitespace). */
export function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  return !/\s/.test(t) && normalizeUserUrl(t) !== null;
}

function readBuffer(req: IncomingMessage, maxBytes = MAX_INGEST_BYTES): Promise<Buffer> {
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

/** Outcome of {@link ingestLocalFile}. `status` is set only for a pre-create
 *  validation error (bad path / too large); otherwise the row was created. */
export interface LocalFileIngestResult {
  id?: string;
  extraction_status: string;
  suggestedLinks?: ClassifyMatch[];
  /**
   * Extractions the enricher could not write (e.g. it aimed at a read-only
   * projection or mirror table). Carried explicitly rather than left on the
   * enrich result, because that value is an ARRAY with an extra property and
   * JSON.stringify silently omits non-index properties of an array — so a
   * partial ingest would serialize as a clean one and the user would be told
   * nothing was lost.
   */
  dropped?: DroppedExtraction[];
  error?: string;
  status?: number;
}

/**
 * Reference a single local file in place as a `files` row (`local_ref`), extract
 * its text, and enrich it — the shared core of the `/api/ingest/file` route AND
 * the folder-ingest BFS (so both behave identically and emit the same
 * `source:'ingest'` feed events). No bytes are copied. Validation failures return
 * `{ error, status }` before any row is created; an extraction/enrichment failure
 * is recorded on the created row and returned (never thrown).
 */
export async function ingestLocalFile(
  ctx: IngestContext,
  mctx: MutationCtx,
  rawPath: string,
  forcePrivate: boolean,
): Promise<LocalFileIngestResult> {
  const abs = resolve(rawPath);
  let size = 0;
  try {
    const st = statSync(abs);
    if (!st.isFile())
      return { extraction_status: 'error', error: 'path is not a file', status: 400 };
    size = st.size;
  } catch {
    return { extraction_status: 'error', error: `file not found: ${abs}`, status: 400 };
  }
  // Bound the file read before extraction — a multi-GB local file can't be
  // slurped into memory (zip formats add their own decompression caps too).
  if (size > MAX_INGEST_BYTES)
    return { extraction_status: 'error', error: 'file too large', status: 413 };

  const name = basename(abs);
  const mime = mimeFor(name);
  const localFileId = crypto.randomUUID();
  // The invariant, always-present columns for the in-place file reference. No
  // bytes are copied; the resolver serves the file straight from disk via ref_uri.
  const baseRow: Record<string, unknown> = {
    id: localFileId,
    ...fileIdentity(name, localFileId),
    ref_kind: 'local_ref',
    ref_uri: abs,
    ref_provider: 'fs',
    original_name: name,
    mime,
    size_bytes: size,
  };
  const persist = async (row: Record<string, unknown>): Promise<string> => {
    const full = { ...(await requiredFileDefaults(ctx.db, name, localFileId, row)), ...row };
    const { id } = await createRow(mctx, 'files', full, forcePrivate ? 'private' : undefined);
    return id;
  };

  // Extract BEFORE creating the row so the file row is written ONCE with its
  // final extraction result — this was createRow(status:'pending') + a follow-up
  // updateRow(extracted), i.e. two writes + two audit rows for every file. An
  // extraction failure still records the file (as 'failed'), as before.
  let result: Awaited<ReturnType<typeof extractSource>>;
  try {
    result = await extractSource(ctx.db, abs, mime, name);
  } catch (e) {
    const err = e as Error;
    console.error(
      `[ingest] extraction failed for file ${localFileId}: ${err.message}\n${err.stack ?? ''}`,
    );
    const id = await persist({
      ...baseRow,
      extraction_status: 'failed',
      description: `Extraction failed: ${err.message}`,
    });
    return { id, extraction_status: 'failed', error: err.message };
  }

  const id = await persist({
    ...baseRow,
    extracted_text: result.text,
    description: describe(result.text, mime, name),
    extraction_status: result.skip ? 'skipped' : 'extracted',
  });

  // Enrich (auto-link + object extraction) — only when text was actually
  // extracted. An enrichment failure marks the row failed, as before.
  try {
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
          false,
          forcePrivate,
          ctx.createObjectJunction,
        );
    // Lift `dropped` off the enrich result into a plain field. It rides on the
    // returned array as a non-index property, which JSON.stringify omits — so
    // without this the caller reports a clean ingest while extractions were
    // refused.
    const dropped = Array.isArray(suggestedLinks)
      ? ((suggestedLinks as Partial<{ dropped: DroppedExtraction[] }>).dropped ?? [])
      : [];
    return {
      id,
      extraction_status: result.skip ? 'skipped' : 'extracted',
      suggestedLinks,
      ...(dropped.length > 0 ? { dropped } : {}),
    };
  } catch (e) {
    const err = e as Error;
    console.error(
      `[ingest] extraction/enrichment failed for file ${id}: ${err.message}\n${err.stack ?? ''}`,
    );
    await updateRow(mctx, 'files', id, {
      extraction_status: 'failed',
      description: `Extraction failed: ${err.message}`,
    });
    return { id, extraction_status: 'failed', error: err.message };
  }
}

// The shared text-ingest body (used by BOTH this route and the assistant's
// paste tool) is a capability, so it lives outside the HTTP adapter. Re-exported
// here so callers that predate the move keep working unchanged.
export { ingestTextAsFile } from '../ops/ingest-text.js';
export type { TextIngestDeps } from '../ops/ingest-text.js';

// ── Ingest as a detached background job ────────────────────────────────────
//
// Extract + structured import + enrichment can take tens of seconds. Holding the
// upload request open for all of it makes a browser drop look like a hung ingest
// and loses the result outright on a reload. So an opted-in client gets the same
// treatment a chat turn already gets: the request is ACKNOWLEDGED immediately with
// a handle, the work runs as a detached job, and progress streams over the
// realtime channel the GUI is already connected to — the SAME `ingest_progress`
// feed frames the folder-ingest publishes, not a second mechanism.
//
// The synchronous shape is untouched: a client that does not send the async header
// still gets 201 with the whole result inline, so every existing caller keeps
// working. Both shapes run ONE implementation (`runUploadIngest`) — the transport
// is the only difference.

/** Request header a client sets to opt into the acknowledged-and-detached shape. */
const ASYNC_INGEST_HEADER = 'x-lattice-async';

/** A detached ingest's observable state. */
export interface IngestJob {
  jobId: string;
  status: 'running' | 'done' | 'failed';
  /** The file being ingested, for a caller correlating a handle to a drop. */
  name: string;
  startedAt: string;
  finishedAt?: string;
  /** On success: exactly the body the synchronous route would have returned. */
  result?: Record<string, unknown>;
  /** On failure: why. Never empty when `status` is 'failed'. */
  error?: string;
}

/** How many settled jobs to retain for collection after the fact. */
const MAX_TRACKED_INGEST_JOBS = 100;

/**
 * In-process registry of detached ingests, keyed by handle. Bounded (oldest
 * settled entries evicted) because a long-lived GUI would otherwise accumulate one
 * entry per upload forever. In-process is the right scope: the job itself is an
 * in-process background task, so a handle cannot outlive the process that owns it,
 * and the DURABLE record of every ingest is the `files` row the job wrote.
 */
const ingestJobs = new Map<string, IngestJob>();

function trackIngestJob(job: IngestJob): void {
  ingestJobs.set(job.jobId, job);
  if (ingestJobs.size <= MAX_TRACKED_INGEST_JOBS) return;
  // Evict the oldest SETTLED jobs first; a running job is never dropped (its
  // handle is the only way its result can be collected).
  for (const [id, j] of ingestJobs) {
    if (ingestJobs.size <= MAX_TRACKED_INGEST_JOBS) break;
    if (j.status !== 'running') ingestJobs.delete(id);
  }
}

/** Look up a detached ingest by handle. Exported for tests + the job route. */
export function getIngestJob(jobId: string): IngestJob | undefined {
  return ingestJobs.get(jobId);
}

/**
 * Publish one ingest-progress frame on the activity feed — the SAME `op` and
 * payload shape the folder-ingest publishes, so it rides the realtime channel the
 * GUI already renders a progress tracker from. `terminal` is explicit rather than
 * inferred from the counts, because a job can settle without a completed file
 * (a duplicate merge, a refused extraction).
 */
function publishIngestProgress(
  feed: FeedBus,
  summary: string,
  progress: { done: number; total: number; terminal?: boolean },
): void {
  feed.publish({
    table: null,
    op: 'ingest_progress',
    rowId: null,
    source: 'ingest',
    progress,
    summary,
  });
}

// ── Render as a pipeline stage ─────────────────────────────────────────────
//
// A freshly-ingested row whose rendered context has not been written yet reads as
// an empty record until some later pass catches up. Rendering is therefore the
// LAST stage of the ingest rather than a separate schedule — but scoped to the
// tables this ingest actually wrote, never a full-tree render, and rate-limited
// per workspace so a burst of uploads falls back to the existing debounced
// scheduler instead of firing a render per file.

/** Minimum spacing between immediate, ingest-driven scoped renders per workspace. */
const INGEST_RENDER_MIN_INTERVAL_MS = 2000;

/** outputDir → the last time an ingest rendered it immediately. */
const lastIngestRenderAt = new Map<string, number>();

/**
 * Render the tables this ingest just wrote, so the row is readable as context the
 * moment the ingest reports success.
 *
 * Returns the tables actually rendered NOW — empty when the workspace does not
 * render files, when nothing was written, or when a render for this workspace ran
 * within the throttle window. In that last case the work is not dropped: it is
 * handed to the existing debounced auto-render scheduler via `requestRender`,
 * which coalesces it with everything else in flight. The return value is honest
 * either way, so a caller never reports a render that did not happen.
 */
async function renderIngestedTables(
  ctx: IngestContext,
  tables: Iterable<string>,
): Promise<{ rendered: string[]; error?: string }> {
  const outputDir = ctx.outputDir;
  if (!ctx.autoRender || !outputDir) return { rendered: [] };
  const scope = new Set<string>();
  for (const t of tables) {
    if (t) scope.add(t);
  }
  if (scope.size === 0) return { rendered: [] };
  const now = Date.now();
  const last = lastIngestRenderAt.get(outputDir) ?? 0;
  if (now - last < INGEST_RENDER_MIN_INTERVAL_MS) {
    // Too soon for another immediate render — defer to the debounced scheduler,
    // which already coalesces and single-flights. Nothing is lost, but nothing is
    // rendered YET, so report none.
    for (const t of scope) ctx.db.requestRender(t);
    return { rendered: [] };
  }
  lastIngestRenderAt.set(outputDir, now);
  // Bound the map: one entry per workspace this process has ever ingested into.
  if (lastIngestRenderAt.size > 32) {
    const oldest = [...lastIngestRenderAt.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest && oldest[0] !== outputDir) lastIngestRenderAt.delete(oldest[0]);
  }
  try {
    await ctx.db.render(outputDir, { changedTables: scope });
    return { rendered: [...scope] };
  } catch (e) {
    // The rows ARE written; only their rendered files are not. Failing the whole
    // ingest here would tell the user their data did not land when it did — and
    // swallowing it would leave them reading an empty context file with no reason.
    // So report both truths: the ingest succeeded, the render did not.
    const error = (e as Error).message;
    console.error(`[ingest] render of ${[...scope].join(', ')} failed: ${error}`);
    return { rendered: [], error };
  }
}

/** The notice shown when the ingest landed but its rendered context did not. */
function renderFailureNotice(error: string): string {
  return (
    `The data was ingested, but its rendered context files could not be written (${error}). ` +
    `The records are in the workspace; their document view may be empty until the next render.`
  );
}

const INGEST_PATHS = new Set(['/api/ingest/text', '/api/ingest/file', '/api/ingest/upload']);

/** `GET <prefix><jobId>` collects a detached ingest's outcome. */
const INGEST_JOB_PREFIX = '/api/ingest/job/';

/** The shared source='ingest' mutation context (audited + fed). Reused by the
 *  ingest routes and the Sources folder-ingest so both write identically. */
export function ingestMutationCtx(ctx: IngestContext): MutationCtx {
  return {
    db: ctx.db,
    feed: ctx.feed,
    softDeletable: ctx.softDeletable,
    source: 'ingest',
    onColumnsAdded: columnDescriptionHook(ctx.db),
    // Ingest/upload is the ONE trusted writer of a files row's byte-location columns
    // (ref_kind/ref_uri/blob_path/…): it sets them from a real ingested/uploaded source. Every
    // other write path is refused those columns by guardReservedColumns.
    allowFileLocationCols: true,
  };
}

/** An upload's inputs, already parsed off the request. */
interface UploadIngestInput {
  /** The uploaded bytes. */
  bytes: Buffer;
  /** The original filename (already percent-decoded). */
  name: string;
  /** Declared content type. */
  mime: string;
  /** A real OS path to reference in place, or '' to retain the bytes instead. */
  realPath: string;
  /** Force the file row and every derived write private. */
  forcePrivate: boolean;
}

/** What an ingest produced: the HTTP status and body the caller reports. */
interface IngestOutcome {
  status: number;
  payload: Record<string, unknown>;
}

/**
 * The whole upload pipeline — extract, structured import, dedup, enrich, render —
 * with no reference to the request or the response. Both transports call THIS: the
 * synchronous route writes the returned payload straight to the response, and the
 * detached job stores it on its handle. There is one implementation, so the two
 * shapes can never drift.
 *
 * `onStage` is called at each stage boundary with a human-readable line; the
 * detached job turns those into realtime progress frames, the synchronous route
 * ignores them.
 */
async function runUploadIngest(
  ctx: IngestContext,
  mctx: MutationCtx,
  input: UploadIngestInput,
  onStage: (summary: string) => void,
): Promise<IngestOutcome> {
  const { name, mime, realPath, forcePrivate } = input;
  let buf: Buffer | null = input.bytes;
  // Size, hash, and S3 config are taken up front so the request bytes can be
  // dropped before extraction — otherwise a large upload's in-memory copy sits
  // alongside the extraction transients for the whole pipeline.
  const sizeBytes = buf.length;
  const uploadSha = createHash('sha256').update(buf).digest('hex');
  const s3cfg = resolveActiveS3Config(ctx.configPath);
  const tmp = join(tmpdir(), `lattice-ingest-${crypto.randomUUID()}${extname(name)}`);
  let result: ExtractResult;
  let blob: { blob_path: string; sha256: string } | null = null;
  // When the drop is a recognized re-upload of a known data document, it's also
  // imported as a new dated snapshot (in addition to being kept as a file).
  let autoImport: AutoImportResult | null = null;
  let importWarnings: string[] = [];
  // Bytes retained only for the S3 put below; everything else reads from tmp.
  let s3Bytes: Buffer | null = null;
  try {
    await writeFile(tmp, buf);
    if (s3cfg) s3Bytes = buf;
    buf = null;
    onStage(`Reading ${name}…`);
    result = await extractSource(ctx.db, tmp, mime, name);
    // Smart import while the bytes are still on disk (tmp is removed below).
    // Best-effort: a structured-import failure never fails the file upload.
    onStage(`Looking for data in ${name}…`);
    try {
      autoImport = await autoImportStructured(ctx.db, ctx.configPath ?? null, tmp, name);
    } catch (e) {
      console.warn('[ingest] auto-import skipped:', (e as Error).message);
    }
    // A stacked-table sheet imports only its largest table; capture the reconciliation
    // warning (from the excelToRecords read the import just did) so it can ride the feed
    // pill — a partial import is never silent. Read from the in-memory cache, so it holds
    // even after `tmp` is removed below.
    if (/\.xlsx?$/i.test(name)) importWarnings = excelImportWarnings(tmp);
    // Retain a content-addressed blob for documents and media (images, PDFs,
    // office docs, text/data, audio, video). Browser drag-drops arrive as bytes
    // with no local path, so this is the only way the underlying file can be
    // previewed, downloaded, or opened later — without it, only the extracted
    // text survives. Arbitrary/unknown binaries are still discarded (text +
    // description kept, no blob). Gate on the file TYPE, not on extraction
    // success: a document whose text fails to extract should still be reachable.
    // Skip blob retention entirely when the client supplied the real OS path
    // (`x-filepath`): the file already persists at that path, so it is recorded
    // as a `local_ref` and served from disk — no redundant copy.
    if (ctx.latticeRoot && !realPath && shouldRetainUploadBlob(mime, name)) {
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
  // S3: when enabled for this cloud workspace, ALSO push the bytes to S3 under a
  // content-addressed key so OTHER members (who can see the files row via RLS)
  // can pull them — the uploader keeps the local blob for fast preview (hybrid).
  // Best-effort: a storage error never fails the upload; the row stays local-only.
  let s3Ref: { ref_uri: string; source_json: string; sha256: string } | null = null;
  // `null` = S3 not enabled for this workspace (the common non-cloud case, no
  // signal needed). When S3 IS enabled, `s3Status` becomes 'stored' or 'failed'
  // so the outcome is surfaced in the response — a failed share to the cloud must
  // not masquerade as a fully-successful upload (surfaced, never swallowed). Other members fetch
  // the bytes from S3, so a silently-dropped PUT would 404 for everyone but the
  // uploader, who still has the local blob.
  let s3Status: { status: 'stored' | 'failed'; key?: string; error?: string } | null = null;
  if (s3cfg && s3Bytes) {
    const sha256 = blob?.sha256 ?? uploadSha;
    const key = s3Key(s3cfg.prefix, sha256);
    try {
      const store = await createS3Store(s3cfg);
      await store.put(key, s3Bytes, { contentType: mime });
      s3Ref = {
        ref_uri: `s3://${s3cfg.bucket}/${key}`,
        source_json: JSON.stringify({
          bucket: s3cfg.bucket,
          key,
          region: s3cfg.region,
          size_bytes: sizeBytes,
        }),
        sha256,
      };
      s3Status = { status: 'stored', key };
    } catch (e) {
      // Best-effort for the upload itself (never 500), but NOT silent: the row
      // is kept local-only and the caller is told the cloud share failed so they
      // can retry before sharing a file other members can't fetch.
      const error = (e as Error).message;
      console.warn('[ingest] S3 upload failed; keeping local-only:', error);
      s3Status = { status: 'failed', error };
    }
  }
  const fileId = crypto.randomUUID();
  // Content hash set UNCONDITIONALLY (not just when a blob/S3 ref exists) so
  // the post-insert auto-dedup can recognize a byte-identical re-upload even on
  // the text-only native schema. createRow drops it if the schema lacks the col.
  const fileSha = blob?.sha256 ?? s3Ref?.sha256 ?? uploadSha;
  const uploadRow: Record<string, unknown> = {
    id: fileId,
    ...fileIdentity(name, fileId),
    original_name: name,
    mime,
    sha256: fileSha,
    size_bytes: sizeBytes,
    extracted_text: result.text,
    description: describe(result.text, mime, name),
    extraction_status: result.skip ? 'skipped' : 'extracted',
    // Reference fields (a single `ref_kind` discriminator). When S3 stored the
    // bytes, record the cloud_ref (other members fetch via S3) AND keep the
    // uploader's local blob_path (their fast path). Otherwise, when a desktop
    // client supplied the real OS path (`x-filepath`), record a local_ref that
    // points at the file in place (no blob was retained for this case — see the
    // retention gate above) so it is served straight from disk. A browser drop
    // with no path falls back to the retained local-only blob. The local_ref is
    // built inline (not via referenceLocalFile) so the already-computed
    // extraction status / size / original_name on uploadRow win over the
    // helper's `pending` defaults.
    ...(s3Ref
      ? {
          ref_kind: 'cloud_ref',
          ref_provider: 's3',
          ref_uri: s3Ref.ref_uri,
          source_json: s3Ref.source_json,
          ...(blob ? { blob_path: blob.blob_path } : {}),
        }
      : realPath
        ? { ref_kind: 'local_ref', ref_uri: realPath, ref_provider: 'fs' }
        : blob
          ? { ref_kind: 'blob', blob_path: blob.blob_path }
          : {}),
  };
  const { id } = await createRow(
    mctx,
    'files',
    {
      ...(await requiredFileDefaults(ctx.db, name, fileId, uploadRow)),
      ...uploadRow,
    },
    forcePrivate ? 'private' : undefined,
  );
  // Stamp the dropped file's row id onto a non-silent import proposal so the
  // inline confirm card's Apply can resolve it (the apply route re-reads the
  // file's bytes from this row's retained blob).
  if (autoImport?.reason) autoImport.fileId = id;
  // Count reconciliation: the document's own prose usually says how much it holds
  // ("46 schools"). When extraction produced fewer rows than that, the user has
  // silently lost most of their data — report it through the same `notices` channel
  // that carries every other outcome-changing result, and on the proposal card so
  // it is visible BEFORE a confirm as well as after a silent import.
  const countNotices = autoImport?.rowsByTable
    ? statedCountNotices(result.text, autoImport.rowsByTable)
    : [];
  if (countNotices.length > 0 && autoImport) {
    autoImport.notices = [...(autoImport.notices ?? []), ...countNotices];
  }
  const notices = [...(autoImport?.notices ?? [])];
  // Seamless auto-dedup: a byte-identical re-upload is merged onto the OLDEST
  // existing copy (this just-created row is soft-deleted — recoverable from
  // Trash / Undo) and enrichment is skipped. The only signal is the 'system'
  // ("Lattice") feed pill. Best-effort: never blocks ingest.
  try {
    const dedupCtx: DedupServiceCtx = {
      db: ctx.db,
      feed: ctx.feed,
      softDeletable: ctx.softDeletable,
      configPath: ctx.configPath ?? '',
      outputDir: ctx.outputDir ?? '',
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    };
    const dupes = await findExactFileDupesOf(dedupCtx, { id, sha256: fileSha });
    const survivor = dupes[0];
    if (survivor) {
      await mergeDuplicates(dedupCtx, 'files', survivor, [id]);
      return {
        status: 200,
        payload: {
          id: survivor,
          duplicateOf: survivor,
          deduped: true,
          extraction_status: 'skipped',
        },
      };
    }
  } catch (e) {
    // Auto-dedup is best-effort: fall through to normal enrichment so the upload
    // still lands. But surface the failure (don't swallow it silently) — otherwise
    // a systematic dedup/merge bug stays invisible behind "everything ingested".
    console.warn(
      '[ingest] auto-dedup failed; falling through to normal enrichment:',
      e instanceof Error ? e.message : String(e),
    );
  }
  // Auto-import outcome → a feed line so the snapshot is visible without any
  // chat round-trip (the assistant "door" working automatically).
  if (autoImport?.imported) {
    const note = importWarnings.length > 0 ? ` (note: ${importWarnings.join(' ')})` : '';
    ctx.feed.publish({
      table: autoImport.tables[0] ?? 'files',
      op: 'insert',
      rowId: null,
      source: 'system',
      summary: `Imported the ${autoImport.asOf ?? ''} snapshot of "${name}" — ${String(autoImport.rows)} rows across ${String(autoImport.tables.length)} tables${note}`,
    });
  }
  // Anything that changed what the user ended up with — a partially-read sheet, or
  // a document that claims more rows than extraction produced — gets its own feed
  // line, whether or not the import itself was silent.
  const heads = [...importWarnings, ...countNotices];
  if (heads.length > 0) {
    ctx.feed.publish({
      table: 'files',
      op: 'update',
      rowId: id,
      source: 'system',
      summary: `Heads up on "${name}": ${heads.join(' ')}`,
    });
  }
  // A non-silent proposal (`reason` set) surfaces via the inline confirm card in
  // the assistant rail (the `autoImport` proposal in the response below) — no pill.
  let suggestedLinks: ClassifyMatch[] = [];
  let droppedExtractions: DroppedExtraction[] = [];
  if (!result.skip) {
    onStage(`Linking ${name} to your data…`);
    // `autoImport != null` ⇒ the deterministic importer claimed this file (a
    // silent import or a proposal card) — the LLM extractor must not also
    // manufacture rows from it. Gate on whether it RAN, not on extension, so a
    // prose document the importer declined still gets object extraction.
    const enriched = await enrichOrReport(
      mctx,
      ctx.db,
      id,
      result.text,
      name,
      ctx,
      forcePrivate,
      autoImport != null,
    );
    if (!enriched.ok) {
      // Enrichment failed and is already recorded on the row. Report it, but still
      // render what DID land so the file row is readable rather than blank.
      const render = await renderIngestedTables(ctx, ['files']);
      return {
        status: 201,
        payload: {
          ...enrichFailurePayload(id, enriched.error),
          ...(render.rendered.length > 0 ? { rendered: render.rendered } : {}),
          ...(render.error ? { notices: [renderFailureNotice(render.error)] } : {}),
        },
      };
    }
    suggestedLinks = enriched.links;
    droppedExtractions = enriched.dropped;
  }
  // Final stage: render the tables this ingest actually wrote, so the new row reads
  // as real context immediately instead of after some later pass. Scoped to what
  // was written (never the whole tree) and rate-limited per workspace.
  onStage(`Filing ${name}…`);
  const scope = new Set<string>(['files']);
  for (const t of autoImport?.tables ?? []) scope.add(t);
  for (const m of suggestedLinks) scope.add(m.table);
  const render = await renderIngestedTables(ctx, scope);
  if (render.error) notices.push(renderFailureNotice(render.error));
  return {
    status: 201,
    payload: {
      id,
      extraction_status: result.skip ? 'skipped' : 'extracted',
      suggestedLinks,
      ...(droppedExtractions.length > 0 ? { dropped: droppedExtractions } : {}),
      ...(autoImport ? { autoImport } : {}),
      ...(notices.length > 0 ? { notices } : {}),
      ...(render.rendered.length > 0 ? { rendered: render.rendered } : {}),
      // Present only when S3 is enabled for this workspace. 'failed' tells the
      // uploader the bytes did NOT reach the shared bucket — other members would
      // 404 until it's re-uploaded — so the GUI can warn rather than imply a
      // clean cloud share.
      ...(s3Status ? { s3: s3Status } : {}),
    },
  };
}

export async function dispatchIngestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: IngestContext,
): Promise<boolean> {
  // Collect a detached ingest's outcome by handle. This is how a client that took
  // the 202 gets the full result (suggested links, the import proposal, notices)
  // after the fact — including one that reloaded mid-ingest. An unknown handle is
  // a 404, never an empty result that would read as "nothing was found".
  if (ctx.method === 'GET' && ctx.pathname.startsWith(INGEST_JOB_PREFIX)) {
    const jobId = decodeURIComponent(ctx.pathname.slice(INGEST_JOB_PREFIX.length));
    const job = jobId ? getIngestJob(jobId) : undefined;
    if (!job) {
      sendJson(res, { error: 'unknown ingest job' }, 404);
      return true;
    }
    sendJson(res, job);
    return true;
  }
  // This gate admits THREE operations. Two of them branch on the path below and carry
  // their own note; the third — /api/ingest/file — is the fallthrough at the end of this
  // function, so it is the one this note is about.
  // @headless-debt ingesting a file the caller names by local path — read, parse, extract,
  // describe, deduplicate, write rows — is only reachable through this route.
  if (ctx.method !== 'POST' || !INGEST_PATHS.has(ctx.pathname)) return false;

  const mctx: MutationCtx = ingestMutationCtx(ctx);

  // The GUI's "Private mode" intent for this ingest. The upload (raw-bytes)
  // path carries it as an `x-lattice-private` header (the body is the file
  // bytes, not JSON); the text/file JSON branches carry it as `body.private`
  // (derived after the body is parsed below). When true, the file row AND every
  // enrichment-derived row + junction link are forced private at insert, instead
  // of inheriting the (possibly shared-to-everyone) files-table default.
  const headerPrivate = req.headers['x-lattice-private'] === '1';

  // Raw-bytes upload (drag-drop / paperclip from the browser, which can't
  // expose a local path). Extract then discard the bytes — we keep the text +
  // description, not the file (path stays null, like a text paste).
  // @headless-debt ingesting bytes the caller already holds — no path, no filesystem — is
  // the shape a script or a job wants most, and it exists only as this request handler.
  if (ctx.pathname === '/api/ingest/upload') {
    const forcePrivate = headerPrivate;
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
    // A browser hides a dragged file's OS path, so a real OS path is available
    // only when a client can supply it (a non-browser/desktop client, via
    // `x-filepath`). When present, the file already lives at a stable disk
    // location, so the upload references it in place as a `local_ref` (mirroring
    // the /api/ingest/file route) instead of retaining a redundant blob copy.
    // `x-filepath` names a real OS path to reference in place. Honor it ONLY when local file
    // open is enabled (desktop/CLI) — off on team cloud, where a tenant-supplied path must never
    // be read from the host; there the upload falls through to raw-bytes retention below (the
    // path is simply ignored, so the file still ingests from its bytes).
    const rawFilePath =
      (localFileOpenEnabled() &&
        typeof req.headers['x-filepath'] === 'string' &&
        req.headers['x-filepath']) ||
      '';
    let realPath = '';
    if (rawFilePath) {
      try {
        realPath = decodeURIComponent(rawFilePath);
      } catch {
        realPath = rawFilePath;
      }
    }
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
    const input: UploadIngestInput = { bytes: buf, name, mime, realPath, forcePrivate };

    // ── Detached shape (opt-in) ──
    // Acknowledge now, run the pipeline as a background job, stream progress over
    // the realtime channel. The request path ends here; the job never touches `res`
    // and runs to completion even if the client navigates away, so its result is
    // collectable from the handle afterwards.
    if (req.headers[ASYNC_INGEST_HEADER] === '1') {
      const jobId = crypto.randomUUID();
      const job: IngestJob = {
        jobId,
        status: 'running',
        name,
        startedAt: new Date().toISOString(),
      };
      trackIngestJob(job);
      sendJson(res, { jobId, async: true, status: 'running', name }, 202);
      publishIngestProgress(ctx.feed, `Ingesting ${name}…`, { done: 0, total: 1 });
      void (async () => {
        try {
          const outcome = await runUploadIngest(ctx, mctx, input, (summary) => {
            publishIngestProgress(ctx.feed, summary, { done: 0, total: 1 });
          });
          job.status = 'done';
          job.result = outcome.payload;
          job.finishedAt = new Date().toISOString();
          publishIngestProgress(ctx.feed, `Ingested ${name}`, {
            done: 1,
            total: 1,
            terminal: true,
          });
          // The rows exist only now, so anything that reads the post-ingest data
          // has to run here rather than when the request returned.
          ctx.onIngestComplete?.();
        } catch (e) {
          // The client already got its 202, so there is no response left to fail —
          // which is exactly why this must be surfaced rather than logged and
          // forgotten: record it on the job (collectable via the handle), say so on
          // the feed the user is watching, and log it with its stack.
          const err = e as Error;
          console.error(
            `[ingest] background ingest of ${name} failed: ${err.message}\n${err.stack ?? ''}`,
          );
          job.status = 'failed';
          job.error = err.message;
          job.finishedAt = new Date().toISOString();
          publishIngestProgress(ctx.feed, `Could not ingest ${name}: ${err.message}`, {
            done: 0,
            total: 1,
            terminal: true,
          });
          ctx.feed.publish({
            table: 'files',
            op: 'update',
            rowId: null,
            source: 'system',
            summary: `Could not ingest "${name}": ${err.message}`,
          });
        }
      })();
      return true;
    }

    // ── Synchronous shape (unchanged contract) ──
    // The whole result comes back on this response. A pipeline failure is thrown
    // rather than swallowed, so the caller sees a real error instead of a 201 that
    // implies an ingest that never happened.
    let outcome: IngestOutcome;
    try {
      outcome = await runUploadIngest(ctx, mctx, input, () => undefined);
    } catch (e) {
      const err = e as Error;
      console.error(`[ingest] upload of ${name} failed: ${err.message}\n${err.stack ?? ''}`);
      sendJson(res, { error: err.message }, 500);
      return true;
    }
    sendJson(res, outcome.payload, outcome.status);
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJson(req, { maxBytes: 10_000_000 });
  } catch (e) {
    sendJson(res, { error: (e as Error).message }, 400);
    return true;
  }
  // JSON branches: the private intent may arrive in the body (`private: true`)
  // or, like the upload path, as the header — accept either.
  const forcePrivate = headerPrivate || body.private === true;

  // @headless-debt the body of this one is already a capability module — but it is not
  // re-exported from the package entry point, so a library consumer still cannot call it.
  if (ctx.pathname === '/api/ingest/text') {
    const rawText = typeof body.text === 'string' ? body.text : '';
    if (!rawText.trim()) {
      sendJson(res, { error: 'text is required' }, 400);
      return true;
    }
    // A bare URL is crawled for its readable text via the unified URL-ingest
    // path (SSRF + policy + rate-limit + untrusted-content framing); the URL is
    // preserved on the row as a `cloud_ref`. A crawl failure now SURFACES rather
    // than silently storing the bare URL string as a "document".
    const sourceUrl = looksLikeUrl(rawText) ? rawText.trim() : null;
    if (sourceUrl) {
      try {
        const result = await ingestUrlAsFile(
          { db: ctx.db, mctx, enrich: enrichContext(ctx), privateMode: forcePrivate },
          sourceUrl,
        );
        sendJson(
          res,
          {
            id: result.id,
            extraction_status: 'extracted',
            suggestedLinks: result.suggestedLinks,
            ...(result.dropped.length > 0 ? { dropped: result.dropped } : {}),
          },
          201,
        );
      } catch (e) {
        const msg = (e as Error).message;
        console.error('[ingest] url ingest failed:', msg);
        sendJson(res, { error: msg }, 502);
      }
      return true;
    }
    const title =
      typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Pasted text';
    const content = rawText;
    const mime = 'text/plain';
    const textFileId = crypto.randomUUID();
    const textRow: Record<string, unknown> = {
      id: textFileId,
      ...fileIdentity(title, textFileId),
      original_name: title,
      mime,
      size_bytes: Buffer.byteLength(content, 'utf8'),
      extracted_text: content.slice(0, 200_000),
      description: describe(content, mime, title),
      extraction_status: 'extracted',
    };
    const { id } = await createRow(
      mctx,
      'files',
      {
        ...(await requiredFileDefaults(ctx.db, title, textFileId, textRow)),
        ...textRow,
      },
      forcePrivate ? 'private' : undefined,
    );
    const enriched = await enrichOrReport(mctx, ctx.db, id, content, title, ctx, forcePrivate);
    if (!enriched.ok) {
      sendJson(res, enrichFailurePayload(id, enriched.error), 201);
      return true;
    }
    // Render what was just written so the pasted note reads as real context right
    // away rather than after a later pass. Scoped + throttled like every other
    // ingest-driven render.
    const textScope = new Set<string>(['files']);
    for (const m of enriched.links) textScope.add(m.table);
    const textRender = await renderIngestedTables(ctx, textScope);
    sendJson(
      res,
      {
        id,
        extraction_status: 'extracted',
        suggestedLinks: enriched.links,
        ...(enriched.dropped.length > 0 ? { dropped: enriched.dropped } : {}),
        ...(textRender.rendered.length > 0 ? { rendered: textRender.rendered } : {}),
        ...(textRender.error ? { notices: [renderFailureNotice(textRender.error)] } : {}),
      },
      201,
    );
    return true;
  }

  // /api/ingest/file — reference a local path (delegates to the shared core). This reads an
  // ARBITRARY path off the server's disk, so it is gated behind the same local-file-open floor
  // as open-in-finder / the sources routes. That floor is OFF on team cloud, where a tenant must
  // never coerce the host into reading its filesystem (/proc/self/environ, other tenants' data);
  // a browser upload (raw bytes, no path) is the cloud ingest path instead.
  if (!localFileOpenEnabled()) {
    sendJson(res, { error: 'local file ingest is disabled on this server' }, 403);
    return true;
  }
  const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
  if (!rawPath) {
    sendJson(res, { error: 'path is required' }, 400);
    return true;
  }
  const r = await ingestLocalFile(ctx, mctx, rawPath, forcePrivate);
  if (r.error && r.status) {
    sendJson(res, { error: r.error }, r.status); // pre-create validation failure
    return true;
  }
  sendJson(
    res,
    {
      id: r.id,
      extraction_status: r.extraction_status,
      suggestedLinks: r.suggestedLinks ?? [],
      ...(r.error ? { error: r.error } : {}),
    },
    201,
  );
  return true;
}
