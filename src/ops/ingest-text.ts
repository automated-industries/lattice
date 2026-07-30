import type { Lattice } from '../lattice.js';
import type { FileJunction } from '../gui/data.js';
import { createRow, type MutationCtx } from '../gui/mutations.js';
import { describe } from '../gui/ai/extract.js';
import { fileIdentity, requiredFileDefaults } from '../gui/file-row.js';
import { enrichWithLlm, type DroppedExtraction } from '../gui/ai/enrich.js';
import { type ClassifyMatch } from '../gui/ai/summarize.js';

/**
 * Ingest a block of text as a file — a capability, not a route.
 *
 * Two callers need this and only one of them is HTTP: the upload endpoint, and
 * the chat assistant's paste-this-in tool. Keeping the implementation inside the
 * ingest route file meant the assistant had to import an HTTP route module to
 * ingest text, which is a server dependency on a path that never serves a
 * request. The rule the layering test enforces is that a route may import a
 * capability and never the other way around, so the shared body lives here.
 *
 * `gui/ingest-routes.ts` re-exports it, so callers that predate the move keep
 * working unchanged.
 */
/** Enrichment wiring for {@link ingestTextAsFile} (mirrors the ingest routes' ctx). */
export interface TextIngestDeps {
  db: Lattice;
  mctx: MutationCtx;
  /** Existing files↔entity junctions, so enrich reuses them instead of re-creating. */
  fileJunctions: FileJunction[];
  /** Per-entity descriptions to sharpen link classification. */
  entityDescriptions: Record<string, string>;
  /** Inference aggressiveness (link/extract gating). Omit → the ingest default. */
  aggressiveness?: number;
  /** Create a new user entity (extract → new object). Omit → no entity creation. */
  createEntity?: (entity: string, columns: string[]) => Promise<string | null>;
  /** Create/return the files↔<otherTable> junction for auto-linking. */
  createJunction?: (otherTable: string) => Promise<FileJunction | null>;
  /** Create/return a junction between two USER entities, to cross-link co-extracted objects. */
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
  /** Force every derived write private (matches a private source). */
  privateMode?: boolean;
}

/**
 * Ingest a block of TEXT exactly the way a dropped file is ingested: save it as a
 * `files` row, then run the SHARED enrichment engine ({@link enrichWithLlm}) over it —
 * which links it to the existing records it refers to and extracts + links the objects
 * it is about. This is the single entry point that BOTH the `/api/ingest/text` route
 * and the chat assistant's `ingest_text` tool go through, so pasted chat content is
 * enriched/linked identically to a file — no separate, prompt-driven linking logic.
 */
export async function ingestTextAsFile(
  deps: TextIngestDeps,
  text: string,
  title: string,
): Promise<{ id: string; suggestedLinks: ClassifyMatch[]; dropped: DroppedExtraction[] }> {
  const { db, mctx } = deps;
  const mime = 'text/plain';
  const fileId = crypto.randomUUID();
  const row: Record<string, unknown> = {
    id: fileId,
    ...fileIdentity(title, fileId),
    original_name: title,
    mime,
    size_bytes: Buffer.byteLength(text, 'utf8'),
    extracted_text: text.slice(0, 200_000),
    description: describe(text, mime, title),
    extraction_status: 'extracted',
  };
  const { id } = await createRow(
    mctx,
    'files',
    { ...(await requiredFileDefaults(db, title, fileId, row)), ...row },
    deps.privateMode ? 'private' : undefined,
  );
  const suggestedLinks = await enrichWithLlm(
    mctx,
    db,
    id,
    text,
    title,
    deps.fileJunctions,
    deps.entityDescriptions,
    deps.createJunction,
    deps.aggressiveness,
    deps.createEntity,
    false,
    deps.privateMode,
    deps.createObjectJunction,
  );
  // `dropped` rides on the enrich result as a non-index property of an array,
  // which JSON.stringify omits. Lift it onto a plain field so a caller can
  // report a partial ingest instead of a clean one.
  const dropped = (suggestedLinks as Partial<{ dropped: DroppedExtraction[] }>).dropped ?? [];
  return { id, suggestedLinks, dropped };
}
