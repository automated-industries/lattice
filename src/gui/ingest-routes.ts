import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, resolve, join } from 'node:path';
import type { Lattice } from '../lattice.js';
import { FeedBus } from './ai/feed.js';
import { createRow, updateRow, linkRows, type MutationCtx } from './mutations.js';
import { parseFile, describe } from './ai/extract.js';
import type { FileJunction } from './data.js';
import { isNativeEntity } from '../framework/native-entities.js';
import { resolveClaudeAuth } from './assistant-routes.js';
import { createAnthropicClient } from './ai/chat.js';
import { summarizeText, classifyLinks, type CatalogEntity, type ClassifyMatch } from './ai/summarize.js';

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
  pathname: string;
  method: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.heic': 'image/heic',
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.html': 'text/html',
  '.htm': 'text/html', '.xml': 'application/xml', '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
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
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 10_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve_({});
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
async function buildCatalog(db: Lattice): Promise<CatalogEntity[]> {
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
    if (records.length > 0) out.push({ table: name, records });
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
  try {
    const desc = await summarizeText(client, text, name);
    if (desc) await updateRow(mctx, 'files', fileId, { description: desc });
  } catch (e) {
    console.warn('[ingest] LLM description failed:', (e as Error).message);
  }
  try {
    const matches = await classifyLinks(client, text, name, await buildCatalog(db));
    for (const m of matches) {
      const jx = junctions.find((j) => j.otherTable === m.table);
      if (jx) {
        // A junction to this entity exists — create the link (default action;
        // it's audited + undoable via the feed). No confirmation prompt.
        try {
          await linkRows(mctx, jx.junction, { [jx.fileFk]: fileId, [jx.otherFk]: m.id });
        } catch (e) {
          console.warn(`[ingest] auto-link to ${m.table} failed:`, (e as Error).message);
        }
      } else {
        // No junction connects files to this entity — surface as a suggestion.
        mctx.feed.publish({
          table: 'files',
          op: 'update',
          rowId: fileId,
          source: 'ingest',
          summary: `Looks related to ${m.table} (${m.id})`,
        });
      }
    }
    return matches;
  } catch (e) {
    console.warn('[ingest] classify failed:', (e as Error).message);
    return [];
  }
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
    req.on('end', () => resolve_(Buffer.concat(chunks)));
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
    const name = (typeof req.headers['x-filename'] === 'string' && req.headers['x-filename']) || 'upload';
    const mime = req.headers['content-type'] || 'application/octet-stream';
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
    try {
      await writeFile(tmp, buf);
      result = await parseFile(tmp, mime, name);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
    const { id } = await createRow(mctx, 'files', {
      id: crypto.randomUUID(),
      original_name: name,
      mime,
      size_bytes: buf.length,
      extracted_text: result.text,
      description: describe(result.text, mime, name),
      extraction_status: result.skip ? 'skipped' : 'extracted',
    });
    const suggestedLinks = result.skip ? [] : await enrichWithLlm(mctx, ctx.db, id, result.text, name, ctx.fileJunctions);
    sendJson(res, { id, extraction_status: result.skip ? 'skipped' : 'extracted', suggestedLinks }, 201);
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
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      sendJson(res, { error: 'text is required' }, 400);
      return true;
    }
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Pasted text';
    const { id } = await createRow(mctx, 'files', {
      id: crypto.randomUUID(),
      original_name: title,
      mime: 'text/plain',
      size_bytes: Buffer.byteLength(text, 'utf8'),
      extracted_text: text.slice(0, 200_000),
      description: describe(text, 'text/plain', title),
      extraction_status: 'extracted',
    });
    const suggestedLinks = await enrichWithLlm(mctx, ctx.db, id, text, title, ctx.fileJunctions);
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
    const result = await parseFile(abs, mime, name);
    await updateRow(mctx, 'files', id, {
      extracted_text: result.text,
      description: describe(result.text, mime, name),
      extraction_status: result.skip ? 'skipped' : 'extracted',
    });
    const suggestedLinks = result.skip ? [] : await enrichWithLlm(mctx, ctx.db, id, result.text, name, ctx.fileJunctions);
    sendJson(res, { id, extraction_status: result.skip ? 'skipped' : 'extracted', suggestedLinks }, 201);
  } catch (e) {
    await updateRow(mctx, 'files', id, {
      extraction_status: 'failed',
      description: `Extraction failed: ${(e as Error).message}`,
    });
    sendJson(res, { id, extraction_status: 'failed', error: (e as Error).message }, 201);
  }
  return true;
}
