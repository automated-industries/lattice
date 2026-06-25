import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, resolve, join } from 'node:path';
import type { Lattice } from '../lattice.js';
import { FeedBus } from './feed.js';
import { createRow, updateRow, type MutationCtx } from './mutations.js';
import { parseFile, describe, type ExtractResult } from './ai/extract.js';
import { describeImage, describePdf } from '../ai/vision.js';
import type { FileJunction } from './data.js';
import { attachBlob } from '../framework/blob-store.js';
import { createS3Store, s3Key } from '../framework/s3-store.js';
import { resolveActiveS3Config } from '../framework/s3-config.js';
import { createHash } from 'node:crypto';
import { resolveClaudeAuth } from './assistant-routes.js';
import { type ClassifyMatch } from './ai/summarize.js';
import { sendJson, readJson, MAX_INGEST_BYTES } from './http.js';
// LLM enrichment (description + auto-link + object extraction) is a shared leaf
// module so both the ingest routes and the assistant's URL-ingest tool reuse it.
import { enrichWithLlm } from './ai/enrich.js';
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
import { autoImportStructured, type AutoImportResult } from './import-auto.js';

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
   *  merged file's many-to-many links onto the surviving copy. */
  outputDir?: string;
  /** GUI session id, recorded on the auto-dedup merge's audit entries. */
  sessionId?: string;
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
  };
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
  privateMode: boolean,
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
      false,
      privateMode,
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
 * Full ingest extraction. Claude vision for images; otherwise native text
 * extraction via {@link parseFile} (PDF / Office / OpenDocument / EPUB / RTF, no
 * external CLI); and when that yields nothing for a PDF — e.g. a scanned/image-only
 * PDF with no text layer, which has no text to extract — Claude's native PDF
 * document read as a fallback. Best-effort + AI-gated: with no Claude auth it
 * degrades to parseFile's result (a `skipped` row).
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
  const localRow: Record<string, unknown> = {
    id: localFileId,
    ...fileIdentity(name, localFileId),
    // Reference the file in place: a `local_ref` whose `ref_uri` is the absolute
    // OS path. No bytes are copied; the resolver serves it straight from disk.
    ref_kind: 'local_ref',
    ref_uri: abs,
    ref_provider: 'fs',
    original_name: name,
    mime,
    size_bytes: size,
    extraction_status: 'pending',
  };
  const { id } = await createRow(
    mctx,
    'files',
    {
      ...(await requiredFileDefaults(ctx.db, name, localFileId, localRow)),
      ...localRow,
    },
    forcePrivate ? 'private' : undefined,
  );

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
          false,
          forcePrivate,
        );
    return { id, extraction_status: result.skip ? 'skipped' : 'extracted', suggestedLinks };
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

const INGEST_PATHS = new Set(['/api/ingest/text', '/api/ingest/file', '/api/ingest/upload']);

/** The shared source='ingest' mutation context (audited + fed). Reused by the
 *  ingest routes and the Sources folder-ingest so both write identically. */
export function ingestMutationCtx(ctx: IngestContext): MutationCtx {
  return {
    db: ctx.db,
    feed: ctx.feed,
    softDeletable: ctx.softDeletable,
    source: 'ingest',
    onColumnsAdded: columnDescriptionHook(ctx.db),
  };
}

export async function dispatchIngestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: IngestContext,
): Promise<boolean> {
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
    const rawFilePath =
      (typeof req.headers['x-filepath'] === 'string' && req.headers['x-filepath']) || '';
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
    const tmp = join(tmpdir(), `lattice-ingest-${crypto.randomUUID()}${extname(name)}`);
    let result;
    let blob: { blob_path: string; sha256: string } | null = null;
    // When the drop is a recognized re-upload of a known data document, it's also
    // imported as a new dated snapshot (in addition to being kept as a file).
    let autoImport: AutoImportResult | null = null;
    try {
      await writeFile(tmp, buf);
      result = await extractSource(ctx.db, tmp, mime, name);
      // Smart import while the bytes are still on disk (tmp is removed below).
      // Best-effort: a structured-import failure never fails the file upload.
      try {
        autoImport = await autoImportStructured(ctx.db, ctx.configPath ?? null, tmp, name);
      } catch (e) {
        console.warn('[ingest] auto-import skipped:', (e as Error).message);
      }
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
    const s3cfg = resolveActiveS3Config(ctx.configPath);
    if (s3cfg) {
      const sha256 = blob?.sha256 ?? createHash('sha256').update(buf).digest('hex');
      const key = s3Key(s3cfg.prefix, sha256);
      try {
        const store = await createS3Store(s3cfg);
        await store.put(key, buf, { contentType: mime });
        s3Ref = {
          ref_uri: `s3://${s3cfg.bucket}/${key}`,
          source_json: JSON.stringify({
            bucket: s3cfg.bucket,
            key,
            region: s3cfg.region,
            size_bytes: buf.length,
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
    const fileSha = blob?.sha256 ?? s3Ref?.sha256 ?? createHash('sha256').update(buf).digest('hex');
    const uploadRow: Record<string, unknown> = {
      id: fileId,
      ...fileIdentity(name, fileId),
      original_name: name,
      mime,
      sha256: fileSha,
      size_bytes: buf.length,
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
        sendJson(res, {
          id: survivor,
          duplicateOf: survivor,
          deduped: true,
          extraction_status: 'skipped',
        });
        return true;
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
      ctx.feed.publish({
        table: autoImport.tables[0] ?? 'files',
        op: 'insert',
        rowId: null,
        source: 'system',
        summary: `Imported the ${autoImport.asOf ?? ''} snapshot of "${name}" — ${String(autoImport.rows)} rows across ${String(autoImport.tables.length)} tables`,
      });
    }
    // A non-silent proposal (`reason` set) surfaces via the inline confirm card in
    // the assistant rail (the `autoImport` proposal in the response below) — no pill.
    let suggestedLinks: ClassifyMatch[] = [];
    if (!result.skip) {
      const links = await enrichOrFail(mctx, ctx.db, id, result.text, name, ctx, res, forcePrivate);
      if (links === null) return true; // enrichment failed — already reported
      suggestedLinks = links;
    }
    sendJson(
      res,
      {
        id,
        extraction_status: result.skip ? 'skipped' : 'extracted',
        suggestedLinks,
        ...(autoImport ? { autoImport } : {}),
        // Present only when S3 is enabled for this workspace. 'failed' tells the
        // uploader the bytes did NOT reach the shared bucket — other members would
        // 404 until it's re-uploaded — so the GUI can warn rather than imply a
        // clean cloud share.
        ...(s3Status ? { s3: s3Status } : {}),
      },
      201,
    );
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
          { id: result.id, extraction_status: 'extracted', suggestedLinks: result.suggestedLinks },
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
    const suggestedLinks = await enrichOrFail(
      mctx,
      ctx.db,
      id,
      content,
      title,
      ctx,
      res,
      forcePrivate,
    );
    if (suggestedLinks === null) return true; // enrichment failed — already reported
    sendJson(res, { id, extraction_status: 'extracted', suggestedLinks }, 201);
    return true;
  }

  // /api/ingest/file — reference a local path (delegates to the shared core).
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
