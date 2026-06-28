/**
 * Postgres dialect-parity for p6: chunk-aware embedding storage, soft-delete-
 * aware semantic search, incremental refresh, the legacy embeddings-table
 * migration, and the native-index no-op when pgvector is absent.
 *
 * The native pgvector path itself only runs when the cluster has pgvector
 * (gated by LATTICE_TEST_PGVECTOR); the disposable test cluster does not, so the
 * fallback + no-op are what is verified here.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync, allAsyncOrSync } from '../../src/db/adapter.js';
import {
  vectorIndexAvailable,
  hasVectorIndex,
  vectorIndexFresh,
} from '../../src/search/vector-index.js';
import { semanticChunker } from '../../src/search/chunking.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

function tokenEmbed(dim = 8) {
  return (text: string): Promise<number[]> => {
    const v = new Array<number>(dim).fill(0);
    for (const tok of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let h = 0;
      for (const ch of tok) h = (h + ch.charCodeAt(0)) % dim;
      v[h] = (v[h] ?? 0) + 1;
    }
    return Promise.resolve(v);
  };
}

describe.skipIf(!PG_URL)('p6 embeddings (Postgres)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const table = `__lattice_test_${runId}_docs`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(table, {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', body: 'TEXT', deleted_at: 'TEXT' },
      embeddings: {
        fields: ['title', 'body'],
        embed: tokenEmbed(8),
        modelId: 'test-v1',
        chunker: semanticChunker({ maxChars: 30 }),
        contextPrefix: (r) => String(r.title),
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
  });

  afterAll(async () => {
    try {
      await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${table}" CASCADE`);
      await runAsyncOrSync(
        db.adapter,
        `DELETE FROM "_lattice_embeddings" WHERE table_name = '${table}'`,
      );
    } catch {
      /* best effort */
    }
    db.close();
  });

  // The auto-embed on insert is fire-and-forget (lattice.ts `_syncEmbedding`):
  // `db.insert` resolves BEFORE the row's chunks are written to
  // `_lattice_embeddings`, so a search (or a direct read of the embeddings) run
  // immediately after can race the write and miss the just-added row — it
  // surfaces under CPU load (parallel workers) as the OLDER rows being present
  // while the just-inserted one is absent. Poll until the row's chunk count is
  // non-zero AND stable across two reads before asserting on it, matching the
  // documented eventually-consistent contract. (storeEmbedding writes chunks one
  // at a time with no surrounding transaction, so "row exists" alone isn't enough.)
  async function waitForEmbedding(pk: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    let stable = 0;
    for (;;) {
      const rows = await allAsyncOrSync(
        db.adapter,
        `SELECT count(*)::int AS n FROM "_lattice_embeddings" WHERE table_name = $1 AND row_pk = $2`,
        [table, pk],
      );
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0 && n === last) {
        if (++stable >= 2) return;
      } else {
        stable = 0;
        last = n;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `embedding for "${pk}" did not materialize within ${String(timeoutMs)}ms (chunks=${String(n)})`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('stores chunked embeddings and searches by best chunk on Postgres', async () => {
    await db.insert(table, {
      id: 'd1',
      title: 'Plan',
      body: 'First about finance.\n\nSecond about logistics.\n\nThird about people.',
    });
    await db.insert(table, { id: 'd2', title: 'Note', body: 'unrelated content here' });
    await waitForEmbedding('d1');
    await waitForEmbedding('d2');

    const rows = await allAsyncOrSync(
      db.adapter,
      `SELECT * FROM "_lattice_embeddings" WHERE table_name = $1 AND row_pk = 'd1' ORDER BY chunk_index`,
      [table],
    );
    expect(rows.length).toBeGreaterThan(1);
    expect(Number(rows[0]!.vec_dim)).toBe(8);

    const hits = await db.search(table, 'logistics', { topK: 1 });
    expect(hits[0]!.row.id).toBe('d1');
    expect(hits[0]!.matchedContent).toBeTruthy();
  });

  it('excludes soft-deleted rows on Postgres', async () => {
    await db.insert(table, { id: 'x1', title: 'gamma', body: 'gamma payload' });
    await db.insert(table, { id: 'x2', title: 'gamma', body: 'gamma payload' });
    await waitForEmbedding('x1');
    await waitForEmbedding('x2');
    await db.delete(table, 'x1');
    const hits = await db.search(table, 'gamma payload', { topK: 10 });
    expect(hits.map((h) => h.row.id)).not.toContain('x1');
    expect(hits.map((h) => h.row.id)).toContain('x2');
  });

  it('builds the native index when pgvector is installable, else reports a no-op', async () => {
    // buildVectorIndex now auto-enables pgvector (CREATE EXTENSION IF NOT EXISTS),
    // so availability is checked AFTER the build: on a pgvector image (CI) the index
    // builds + native search works; on a vanilla cluster it stays a reported no-op.
    const n = await db.buildVectorIndex(table);
    if (await vectorIndexAvailable(db.adapter)) {
      expect(n).toBeGreaterThan(0);
      expect(await hasVectorIndex(db.adapter, table)).toBe(true);
      const hits = await db.search(table, 'logistics', { topK: 1 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.row.id).toBe('d1');
    } else {
      expect(n).toBe(0);
    }
  });

  it('keeps the native index in sync with writes — no manual rebuild (pgvector only)', async () => {
    if (!(await vectorIndexAvailable(db.adapter))) return; // the index path requires pgvector
    // The index was built in the previous test; a brand-new row must become
    // searchable through the index WITHOUT anyone calling buildVectorIndex again.
    await db.insert(table, {
      id: 'sync1',
      title: 'logistics',
      body: 'logistics sync payload about shipping lanes',
    });
    await waitForEmbedding('sync1');

    // The index mirror runs on the same fire-and-forget chain just after the store
    // write; poll until the index is back in lock-step with the store. That it
    // converges proves incremental maintenance updated the index itself — not just
    // that the freshness guard fell back to the scan.
    const deadline = Date.now() + 5000;
    while (!(await vectorIndexFresh(db.adapter, table))) {
      if (Date.now() > deadline) throw new Error('index did not converge to fresh after insert');
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await vectorIndexFresh(db.adapter, table)).toBe(true);

    const hits = await db.search(table, 'logistics sync payload shipping', { topK: 5 });
    expect(hits.map((h) => h.row.id)).toContain('sync1');

    // Deleting the row drops it from index-backed results too.
    await db.delete(table, 'sync1');
    const after = await db.search(table, 'logistics sync payload shipping', { topK: 5 });
    expect(after.map((h) => h.row.id)).not.toContain('sync1');
  });
});

// NOTE: the legacy embeddings-table migration is verified on SQLite
// (tests/unit/embeddings-vector.test.ts), where each :memory: DB is private.
// It is intentionally NOT tested here because it would DROP/recreate the shared
// `_lattice_embeddings` table that other Postgres test files use concurrently.
