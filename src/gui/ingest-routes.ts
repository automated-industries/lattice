import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type { Lattice } from '../lattice.js';
import { FeedBus } from './ai/feed.js';
import { createRow, updateRow, type MutationCtx } from './mutations.js';
import { parseFile, describe } from './ai/extract.js';

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

export async function dispatchIngestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: IngestContext,
): Promise<boolean> {
  if (ctx.method !== 'POST') return false;
  if (ctx.pathname !== '/api/ingest/text' && ctx.pathname !== '/api/ingest/file') return false;

  const mctx: MutationCtx = {
    db: ctx.db,
    feed: ctx.feed,
    softDeletable: ctx.softDeletable,
    source: 'ingest',
  };

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
    sendJson(res, { id, extraction_status: 'extracted' }, 201);
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
    sendJson(res, { id, extraction_status: result.skip ? 'skipped' : 'extracted' }, 201);
  } catch (e) {
    await updateRow(mctx, 'files', id, {
      extraction_status: 'failed',
      description: `Extraction failed: ${(e as Error).message}`,
    });
    sendJson(res, { id, extraction_status: 'failed', error: (e as Error).message }, 201);
  }
  return true;
}
