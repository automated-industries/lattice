/**
 * Paging + payload limits — pure values, zero imports.
 *
 * These are policy numbers and a parser, not transport code: how many rows a
 * bounded read may return, how big a request body or an ingested source may be,
 * and how a caller-supplied `limit`/`offset` is validated and clamped. They are
 * the same numbers whether a caller arrives over HTTP, through the CLI, or via
 * the library API, so they live here rather than in the HTTP adapter.
 *
 * This module is a leaf. It imports nothing at all — no Node server module, no
 * Lattice type — so any capability module can depend on it without dragging a
 * server into a headless code path.
 */

/** Default request-body cap (1 MB). Endpoints that accept larger payloads pass
 *  an explicit `maxBytes` (ingest uploads 10 MB, chat history 2 MB). */
export const DEFAULT_BODY_MAX_BYTES = 1_000_000;

/** Max bytes Lattice will read for a structured-source ingest/import (100 MB). The
 *  ceiling sits above the pre-overhaul 50 MB so a genuinely large extract still
 *  imports, but well BELOW a naive 250 MB because the worst case is an `.xlsx`, and
 *  an `.xlsx` is a zip: the parser (`exceljs`) reads the WHOLE workbook with
 *  `wb.xlsx.readFile` (no streaming) and holds the DECOMPRESSED object model in
 *  memory at several times the on-disk size. A 250 MB workbook can therefore expand
 *  past even the desktop build's baked 4 GB V8 heap (`--max-old-space-size=4096`)
 *  and OOM the process — and per-sheet splitting does NOT help, because the whole
 *  book is parsed before it is split. 100 MB keeps that worst-case expansion inside
 *  the desktop heap with margin. It is deliberately NOT unbounded: an uncapped read
 *  would reintroduce exactly the OOM the cap exists to prevent. The cap is enforced
 *  both on the streaming upload and again when the import-apply route re-reads the
 *  retained bytes, so an oversized source can't exhaust memory regardless of how the
 *  file got onto disk; the too-large error reports this value, so it stays honest
 *  automatically. */
export const MAX_INGEST_BYTES = 100_000_000;

/** Max rows a single bounded list read returns — `limit` is clamped to this so no
 *  one request can read an unbounded slice of a table (bounded reads). */
export const MAX_ROWS_PAGE = 1000;

/** Page size used when a request omits `limit`. */
export const DEFAULT_ROWS_PAGE = 500;

/**
 * Parse + validate a `limit`/`offset` query param. Returns the numeric value, or
 * `'invalid'` for a non-numeric / negative / non-integer string — the caller
 * returns 400 instead of letting `Number('abc')` become `LIMIT NaN`. `limit` is
 * clamped to `[1, MAX_ROWS_PAGE]` (so a client can never request an unbounded
 * read); `offset` is floored at 0. Single source of truth for every paged read.
 */
export function parsePageParam(raw: string | null, kind: 'limit' | 'offset'): number | 'invalid' {
  if (raw === null) return kind === 'limit' ? DEFAULT_ROWS_PAGE : 0;
  if (!/^\d+$/.test(raw.trim())) return 'invalid';
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'invalid';
  if (kind === 'limit') return Math.min(Math.max(1, n), MAX_ROWS_PAGE);
  return Math.max(0, n);
}
