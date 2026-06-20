/**
 * Retrieval health diagnostics — a read-only `doctor` for a Lattice database's
 * search surface. It reports, without mutating anything:
 *
 *   - which retrieval extensions are available/installed (FTS5, pgvector,
 *     sqlite-vec, pg_trgm),
 *   - per-table full-text and embedding coverage (how many base rows are
 *     actually indexed/embedded vs how many exist),
 *   - staleness and gaps surfaced as severity-ranked issues.
 *
 * The point is proactive detection: index or embedding drift is otherwise
 * invisible until a user notices bad results. `diagnoseRetrieval` surfaces it
 * first, and `lattice doctor` puts it one command away. Everything here is a
 * `SELECT`/introspection — no DDL, no writes, both dialects.
 */

import type { StorageAdapter } from '../db/adapter.js';
import { getAsyncOrSync, allAsyncOrSync, introspectColumnsAsyncOrSync } from '../db/adapter.js';
import { ftsTableName } from './fts.js';
import { EMBEDDINGS_TABLE } from './embeddings.js';
import { hasVectorIndex, vectorIndexName } from './vector-index.js';

export type HealthSeverity = 'info' | 'warning' | 'error';

export type HealthIssueKind =
  | 'fts_missing'
  | 'fts_stale'
  | 'fts_empty'
  | 'embedding_missing'
  | 'embedding_stale'
  | 'extension_missing'
  | 'dimension_mismatch'
  | 'index_stale';

export interface RetrievalHealthIssue {
  /** Table the issue concerns, or undefined for a global/extension issue. */
  table?: string;
  kind: HealthIssueKind;
  severity: HealthSeverity;
  message: string;
  /** Optional remediation hint. */
  hint?: string;
}

/** Availability of the retrieval extensions on this connection. */
export interface ExtensionAvailability {
  /** SQLite compiled with FTS5. */
  fts5?: boolean;
  /** SQLite sqlite-vec extension loaded (vec_version() resolves). */
  sqliteVec?: boolean;
  /** Postgres pgvector installed (CREATE EXTENSION vector done). */
  pgvectorInstalled?: boolean;
  /** Postgres pgvector available to install. */
  pgvectorAvailable?: boolean;
  /** Postgres pg_trgm installed. */
  pgTrgmInstalled?: boolean;
}

export interface TableHealth {
  table: string;
  /** Non-deleted base rows. */
  rowCount: number;
  /** Rows present in the FTS index, when one exists. */
  ftsIndexed?: number;
  /** ftsIndexed / rowCount, in [0, 1]. */
  ftsCoverage?: number;
  /** Embeddings stored for this table. */
  embeddingCount?: number;
  /** embeddingCount / rowCount, in [0, 1]. */
  embeddingCoverage?: number;
  issues: RetrievalHealthIssue[];
}

export interface RetrievalHealthReport {
  dialect: 'sqlite' | 'postgres';
  extensions: ExtensionAvailability;
  tables: TableHealth[];
  /** Global (non-table) issues, e.g. a missing extension. */
  issues: RetrievalHealthIssue[];
  /** True when no `error`-severity issue exists anywhere. */
  healthy: boolean;
}

/** What a table is expected to support, so gaps can be flagged as errors. */
export interface RetrievalHealthSpec {
  table: string;
  /** Table opted into full-text search. */
  expectFts?: boolean;
  /** Table opted into embeddings. */
  expectEmbeddings?: boolean;
  /** Known embedding dimension (reserved for dimension checks). */
  embeddingDim?: number;
}

export interface DiagnoseOptions {
  /**
   * Tables to diagnose with their expected capabilities. When omitted, the
   * doctor reports extension availability and embedding coverage for every
   * table that already has stored embeddings, but cannot flag "missing"
   * (it has no expectations to compare against).
   */
  tables?: RetrievalHealthSpec[];
  /**
   * Coverage below which a partially-indexed/embedded table is flagged stale.
   * Default 1 — anything short of full coverage is a `warning`.
   */
  staleThreshold?: number;
}

/** A non-throwing scalar count — returns null when the table/relation is absent. */
async function tryCount(
  adapter: StorageAdapter,
  sql: string,
  params: unknown[] = [],
): Promise<number | null> {
  try {
    const row = await getAsyncOrSync(adapter, sql, params);
    const v = row?.n ?? row?.count ?? null;
    return v == null ? null : Number(v);
  } catch {
    // A missing relation is an expected diagnostic state, not a hidden failure:
    // the doctor's job is to report presence/absence, so "absent" is the answer.
    return null;
  }
}

async function detectExtensions(adapter: StorageAdapter): Promise<ExtensionAvailability> {
  if (adapter.dialect === 'postgres') {
    const installed = await tryCount(
      adapter,
      `SELECT count(*) AS n FROM pg_extension WHERE extname = 'vector'`,
    );
    const available = await tryCount(
      adapter,
      `SELECT count(*) AS n FROM pg_available_extensions WHERE name = 'vector'`,
    );
    const trgm = await tryCount(
      adapter,
      `SELECT count(*) AS n FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    return {
      pgvectorInstalled: (installed ?? 0) > 0,
      pgvectorAvailable: (available ?? 0) > 0,
      pgTrgmInstalled: (trgm ?? 0) > 0,
    };
  }
  // SQLite: FTS5 via compile options; sqlite-vec via its vec_version() function.
  const fts5 = await tryCount(
    adapter,
    `SELECT count(*) AS n FROM pragma_compile_options WHERE compile_options LIKE 'ENABLE_FTS5%'`,
  );
  let sqliteVec = false;
  try {
    await getAsyncOrSync(adapter, `SELECT vec_version() AS n`);
    sqliteVec = true;
  } catch {
    sqliteVec = false;
  }
  return { fts5: (fts5 ?? 0) > 0, sqliteVec };
}

async function baseRowCount(adapter: StorageAdapter, table: string): Promise<number> {
  let cols: string[];
  try {
    cols = await introspectColumnsAsyncOrSync(adapter, table);
  } catch {
    return 0;
  }
  const where = cols.includes('deleted_at') ? ` WHERE deleted_at IS NULL` : '';
  const n = await tryCount(adapter, `SELECT count(*) AS n FROM "${table}"${where}`);
  return n ?? 0;
}

async function diagnoseTable(
  adapter: StorageAdapter,
  spec: RetrievalHealthSpec,
  staleThreshold: number,
): Promise<TableHealth> {
  const issues: RetrievalHealthIssue[] = [];
  const rowCount = await baseRowCount(adapter, spec.table);

  const health: TableHealth = { table: spec.table, rowCount, issues };

  // --- Full-text coverage -------------------------------------------------
  const ftsTable = ftsTableName(spec.table);
  const ftsIndexed = await tryCount(adapter, `SELECT count(*) AS n FROM "${ftsTable}"`);
  if (ftsIndexed === null) {
    if (spec.expectFts) {
      issues.push({
        table: spec.table,
        kind: 'fts_missing',
        severity: 'error',
        message: `Table "${spec.table}" is configured for full-text search but its index "${ftsTable}" does not exist.`,
        hint: 'Re-run init() so the FTS index is created, or remove the fts config.',
      });
    }
  } else {
    health.ftsIndexed = ftsIndexed;
    health.ftsCoverage = rowCount === 0 ? 1 : ftsIndexed / rowCount;
    if (rowCount > 0 && ftsIndexed === 0) {
      issues.push({
        table: spec.table,
        kind: 'fts_empty',
        severity: 'error',
        message: `Full-text index "${ftsTable}" is empty but "${spec.table}" has ${String(rowCount)} rows.`,
        hint: 'The index is not being maintained — rebuild it.',
      });
    } else if (health.ftsCoverage < staleThreshold) {
      issues.push({
        table: spec.table,
        kind: 'fts_stale',
        severity: 'warning',
        message: `Full-text index "${ftsTable}" covers ${String(ftsIndexed)}/${String(rowCount)} rows (${(health.ftsCoverage * 100).toFixed(0)}%).`,
        hint: 'Some rows are not indexed — rebuild the index to restore full coverage.',
      });
    }
  }

  // --- Embedding coverage -------------------------------------------------
  const embeddingCount = await tryCount(
    adapter,
    `SELECT count(*) AS n FROM "${EMBEDDINGS_TABLE}" WHERE table_name = ?`,
    [spec.table],
  );
  if (embeddingCount !== null) {
    health.embeddingCount = embeddingCount;
    health.embeddingCoverage = rowCount === 0 ? 1 : embeddingCount / rowCount;
    if (spec.expectEmbeddings && rowCount > 0 && embeddingCount === 0) {
      issues.push({
        table: spec.table,
        kind: 'embedding_missing',
        severity: 'error',
        message: `Table "${spec.table}" is configured for embeddings but none are stored for its ${String(rowCount)} rows.`,
        hint: 'Backfill embeddings (e.g. refreshEmbeddings) so semantic search can return these rows.',
      });
    } else if (spec.expectEmbeddings && rowCount > 0 && health.embeddingCoverage < staleThreshold) {
      issues.push({
        table: spec.table,
        kind: 'embedding_stale',
        severity: 'warning',
        message: `Embeddings cover ${String(embeddingCount)}/${String(rowCount)} rows of "${spec.table}" (${(health.embeddingCoverage * 100).toFixed(0)}%).`,
        hint: 'Some rows are missing embeddings — backfill the gap.',
      });
    }
  } else if (spec.expectEmbeddings && rowCount > 0) {
    issues.push({
      table: spec.table,
      kind: 'embedding_missing',
      severity: 'error',
      message: `Table "${spec.table}" is configured for embeddings but the embeddings store is unavailable.`,
      hint: 'Ensure init() ran so the embeddings table exists.',
    });
  }

  // --- Embedding dimension consistency ------------------------------------
  // A model change without a full re-embed leaves mixed-dimension vectors that
  // score wrong (or throw `EmbeddingDimensionMismatchError`) at query time. Detect
  // it proactively: more than one stored dimension, or a single dimension that
  // disagrees with the configured model's expected `embeddingDim`.
  if (embeddingCount !== null && embeddingCount > 0) {
    let dims: number[] = [];
    try {
      const rows = await allAsyncOrSync(
        adapter,
        `SELECT DISTINCT vec_dim FROM "${EMBEDDINGS_TABLE}" WHERE table_name = ? AND vec_dim IS NOT NULL`,
        [spec.table],
      );
      dims = rows
        .map((r) => Number(r.vec_dim))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
    } catch {
      dims = [];
    }
    if (dims.length > 1) {
      issues.push({
        table: spec.table,
        kind: 'dimension_mismatch',
        severity: 'error',
        message: `"${spec.table}" has mixed embedding dimensions (${dims.join(', ')}) — a model change without a full re-embed.`,
        hint: 'Re-embed the table (refreshEmbeddings) so every stored vector shares one dimension.',
      });
    } else if (
      spec.embeddingDim !== undefined &&
      dims.length === 1 &&
      dims[0] !== spec.embeddingDim
    ) {
      issues.push({
        table: spec.table,
        kind: 'dimension_mismatch',
        severity: 'error',
        message: `"${spec.table}" embeddings are ${String(dims[0])}-d but the configured model expects ${String(spec.embeddingDim)}-d.`,
        hint: 'Re-embed the table after changing the embedding model.',
      });
    }
  }

  // --- Native vector index staleness --------------------------------------
  // The ANN index is built FROM the embeddings and is not auto-maintained on
  // write, so it can drift after new/changed embeddings. If an index exists and
  // its row count disagrees with the stored embedding count, flag it for rebuild.
  if (
    embeddingCount !== null &&
    embeddingCount > 0 &&
    (await hasVectorIndex(adapter, spec.table))
  ) {
    const idxCount = await tryCount(
      adapter,
      `SELECT count(*) AS n FROM "${vectorIndexName(spec.table)}"`,
    );
    if (idxCount !== null && idxCount !== embeddingCount) {
      issues.push({
        table: spec.table,
        kind: 'index_stale',
        severity: 'warning',
        message: `Native vector index for "${spec.table}" has ${String(idxCount)} rows but ${String(embeddingCount)} embeddings are stored — the index is stale.`,
        hint: 'Rebuild the index (buildVectorIndex) so vector search reflects the latest embeddings.',
      });
    }
  }

  return health;
}

/**
 * Produce a retrieval health report for the given connection.
 *
 * Read-only and dialect-agnostic. Pass `tables` (with expectations) to get
 * missing-index / missing-embedding errors; omit it for a capability + coverage
 * snapshot only.
 */
export async function diagnoseRetrieval(
  adapter: StorageAdapter,
  opts: DiagnoseOptions = {},
): Promise<RetrievalHealthReport> {
  const staleThreshold = opts.staleThreshold ?? 1;
  const extensions = await detectExtensions(adapter);
  const globalIssues: RetrievalHealthIssue[] = [];

  // Surface a missing-but-needed extension as a global warning. We only know an
  // extension is *needed* when at least one table expects the matching feature.
  const wantsEmbeddings = (opts.tables ?? []).some((t) => t.expectEmbeddings);
  if (wantsEmbeddings) {
    if (adapter.dialect === 'postgres' && extensions.pgvectorInstalled === false) {
      globalIssues.push({
        kind: 'extension_missing',
        severity: extensions.pgvectorAvailable ? 'warning' : 'info',
        message: extensions.pgvectorAvailable
          ? 'pgvector is available but not installed — indexed vector search will fall back to an in-process scan.'
          : 'pgvector is not available — vector search uses an in-process scan (O(n) per query).',
        hint: extensions.pgvectorAvailable
          ? 'CREATE EXTENSION vector; then rebuild the vector index.'
          : 'Install the pgvector extension on this server for indexed vector search.',
      });
    }
    if (adapter.dialect === 'sqlite' && extensions.sqliteVec === false) {
      globalIssues.push({
        kind: 'extension_missing',
        severity: 'info',
        message:
          'sqlite-vec is not loaded — vector search uses an in-process scan (O(n) per query).',
        hint: 'Load the sqlite-vec extension for indexed vector search at scale.',
      });
    }
  }

  let specs = opts.tables;
  if (!specs) {
    // No expectations given — discover tables that already have embeddings so we
    // can at least report their coverage.
    const rows = await (async () => {
      try {
        const { allAsyncOrSync } = await import('../db/adapter.js');
        return (await allAsyncOrSync(
          adapter,
          `SELECT DISTINCT table_name FROM "${EMBEDDINGS_TABLE}"`,
        )) as { table_name: string }[];
      } catch {
        return [];
      }
    })();
    specs = rows.map((r) => ({ table: r.table_name, expectEmbeddings: true }));
  }

  const tables: TableHealth[] = [];
  for (const spec of specs) {
    tables.push(await diagnoseTable(adapter, spec, staleThreshold));
  }

  const allIssues = [...globalIssues, ...tables.flatMap((t) => t.issues)];
  const healthy = !allIssues.some((i) => i.severity === 'error');

  return {
    dialect: adapter.dialect,
    extensions,
    tables,
    issues: globalIssues,
    healthy,
  };
}

/** Render a report as a human-readable multi-line string (for `lattice doctor`). */
export function formatHealthReport(report: RetrievalHealthReport): string {
  const lines: string[] = [];
  lines.push(`Retrieval health — ${report.dialect}`);
  lines.push('');
  lines.push('Extensions:');
  for (const [k, v] of Object.entries(report.extensions)) {
    lines.push(`  ${k}: ${v ? 'yes' : 'no'}`);
  }
  lines.push('');
  if (report.tables.length === 0) {
    lines.push('No retrieval-enabled tables found.');
  } else {
    lines.push('Tables:');
    for (const t of report.tables) {
      const parts = [`rows=${String(t.rowCount)}`];
      if (t.ftsCoverage !== undefined) parts.push(`fts=${(t.ftsCoverage * 100).toFixed(0)}%`);
      if (t.embeddingCoverage !== undefined)
        parts.push(`emb=${(t.embeddingCoverage * 100).toFixed(0)}%`);
      lines.push(`  ${t.table}: ${parts.join(' ')}`);
    }
  }
  const allIssues = [...report.issues, ...report.tables.flatMap((t) => t.issues)];
  if (allIssues.length > 0) {
    lines.push('');
    lines.push('Issues:');
    for (const i of allIssues) {
      const where = i.table ? `[${i.table}] ` : '';
      lines.push(`  ${i.severity.toUpperCase()}: ${where}${i.message}`);
      if (i.hint) lines.push(`    → ${i.hint}`);
    }
  }
  lines.push('');
  lines.push(report.healthy ? '✓ healthy (no errors)' : '✗ errors present');
  return lines.join('\n');
}
