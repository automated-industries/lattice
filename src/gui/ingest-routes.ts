import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readJson } from './http.js';
import { localFileOpenEnabled } from './files-routes.js';
import type { FeedBus } from './feed.js';
import type { MutationCtx } from './mutations.js';
import { MAX_INGEST_BYTES } from '../ops/paging.js';
import { ingestErrorCode, type IngestErrorCode } from '../ops/ingest-errors.js';
import {
  ingestBytes,
  ingestMutationCtx,
  ingestPath,
  ingestText,
  type IngestContext,
  type UploadIngestInput,
  type UploadIngestResult,
} from '../ops/ingest-file.js';

/**
 * Ingest endpoints — the HTTP adapter over the ingest capabilities.
 *
 * "Ingest" means reference a local file (or a pasted text snippet) as a row in
 * the native `files` entity and summarize its contents. The WORK lives in
 * `ops/ingest-file.ts`, where a command, a job, or a library caller reaches it
 * without a server; what is left here is transport — reading the request body,
 * choosing a status from a refusal's code, and the detached-job handle a browser
 * needs because it may navigate away mid-upload.
 *
 * Localhost trust, like the other GUI routes; team-cloud mode does not mount
 * this dispatcher.
 */

/** The ingest context plus the request line this dispatcher matches on. */
export interface IngestRouteContext extends IngestContext {
  pathname: string;
  method: string;
}

// The ingest capabilities themselves live outside this HTTP adapter, so a
// command line, a job, or a library caller reaches them without a server.
// Re-exported here so callers that predate the move keep working unchanged.
export {
  ingestLocalFile,
  ingestMutationCtx,
  ingestPath,
  ingestBytes,
  ingestText,
  shouldRetainUploadBlob,
} from '../ops/ingest-file.js';
export type { LocalFileIngestResult, IngestContext } from '../ops/ingest-file.js';
export { ingestTextAsFile, looksLikeUrl } from '../ops/ingest-text.js';
export type { TextIngestDeps } from '../ops/ingest-text.js';

/** The status each refusal code answers with on this transport. */
const STATUS_BY_CODE: Record<IngestErrorCode, number> = {
  invalid_request: 400,
  not_found: 400,
  too_large: 413,
  outside_roots: 403,
  local_files_disabled: 403,
  source_unreachable: 502,
};

/**
 * Answer a thrown value. A tagged ingest refusal becomes its own status; anything
 * else is a real fault and is reported as one rather than dressed up as a client
 * mistake.
 */
function sendIngestFailure(res: ServerResponse, e: unknown, context: string): boolean {
  const code = ingestErrorCode(e);
  const message = e instanceof Error ? e.message : String(e);
  if (code !== undefined) {
    sendJson(res, { error: message }, STATUS_BY_CODE[code]);
    return true;
  }
  console.error(`[ingest] ${context} failed: ${message}\n${(e as Error).stack ?? ''}`);
  sendJson(res, { error: message }, 500);
  return true;
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
// This is TRANSPORT, not capability: a direct caller of `ingestBytes` already
// holds the promise and needs no handle to collect its own result later.
//
// The synchronous shape is untouched: a client that does not send the async header
// still gets 201 with the whole result inline, so every existing caller keeps
// working. Both shapes run ONE implementation (`ingestBytes`) — the transport
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

const INGEST_PATHS = new Set(['/api/ingest/text', '/api/ingest/file', '/api/ingest/upload']);

/** `GET <prefix><jobId>` collects a detached ingest's outcome. */
const INGEST_JOB_PREFIX = '/api/ingest/job/';

/** A newly-created document answers 201; a deduped one created nothing, so 200. */
function ingestStatus(result: UploadIngestResult): number {
  return result.deduped === true ? 200 : 201;
}

export async function dispatchIngestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: IngestRouteContext,
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
  // @capability ingest.path
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
  // @capability ingest.bytes
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
          const result = await ingestBytes(ctx, mctx, input, (summary) => {
            publishIngestProgress(ctx.feed, summary, { done: 0, total: 1 });
          });
          job.status = 'done';
          job.result = result;
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
    // The whole result comes back on this response. A pipeline failure is reported
    // rather than swallowed, so the caller sees a real error instead of a 201 that
    // implies an ingest that never happened.
    let result: UploadIngestResult;
    try {
      result = await ingestBytes(ctx, mctx, input);
    } catch (e) {
      return sendIngestFailure(res, e, `upload of ${name}`);
    }
    sendJson(res, result, ingestStatus(result));
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

  // @capability ingest.text
  if (ctx.pathname === '/api/ingest/text') {
    const rawText = typeof body.text === 'string' ? body.text : '';
    const title = typeof body.title === 'string' ? body.title : '';
    try {
      const result = await ingestText(ctx, mctx, rawText, {
        ...(title ? { title } : {}),
        privateMode: forcePrivate,
      });
      sendJson(res, result, 201);
    } catch (e) {
      return sendIngestFailure(res, e, 'text ingest');
    }
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
  try {
    const r = await ingestPath(ctx, mctx, rawPath, { privateMode: forcePrivate });
    sendJson(
      res,
      {
        id: r.id,
        extraction_status: r.extraction_status,
        suggestedLinks: r.suggestedLinks,
        ...(r.error !== undefined ? { error: r.error } : {}),
      },
      201,
    );
  } catch (e) {
    return sendIngestFailure(res, e, `ingest of ${rawPath}`);
  }
  return true;
}
