import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync, allAsyncOrSync } from '../../src/db/adapter.js';
import {
  storeEmbedding,
  ensureEmbeddingsTable,
  EmbeddingDimensionMismatchError,
  type RefreshEmbeddingsOptions,
} from '../../src/search/embeddings.js';
import type { EmbeddingsConfig } from '../../src/types.js';
import { semanticChunker } from '../../src/search/chunking.js';
import { vectorIndexAvailable, hasVectorIndex } from '../../src/search/vector-index.js';

/**
 * p6 — chunk-aware embedding store, dimension-safe + soft-delete-aware semantic
 * search, incremental refresh, and the native-index detection/fallback.
 *
 * The facade embedding write (`db.insert` → `_syncEmbedding`) is intentionally
 * fire-and-forget, so tests that need to assert the stored shape deterministically
 * insert rows via raw SQL and materialize embeddings with the awaitable
 * `refreshEmbeddings` / `storeEmbedding` helpers (the same code the facade calls).
 */

// A tiny deterministic embedder: dim-d vector keyed off token presence.
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

function unchunkedConfig(): EmbeddingsConfig {
  return { fields: ['title', 'body'], embed: tokenEmbed(8), modelId: 'test-v1' };
}
function chunkedConfig(): EmbeddingsConfig {
  return {
    fields: ['title', 'body'],
    embed: tokenEmbed(8),
    modelId: 'test-v1',
    chunker: semanticChunker({ maxChars: 30 }),
    contextPrefix: (r) => String(r.title),
  };
}

describe('chunk-aware embedding storage + search (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(config: EmbeddingsConfig): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', body: 'TEXT', deleted_at: 'TEXT' },
      embeddings: config,
      render: () => '',
      outputFile: 'd.md',
    });
    await db.init();
    return db;
  }

  it('stores one chunk per row for unchunked config and finds by similarity', async () => {
    const d = await setup(unchunkedConfig());
    await runAsyncOrSync(
      d.adapter,
      `INSERT INTO docs (id,title,body) VALUES ('d1','budget review','finance numbers')`,
    );
    await runAsyncOrSync(
      d.adapter,
      `INSERT INTO docs (id,title,body) VALUES ('d2','grocery list','milk eggs bread')`,
    );
    await d.refreshEmbeddings('docs');

    const rows = await allAsyncOrSync(
      d.adapter,
      `SELECT * FROM "_lattice_embeddings" WHERE table_name='docs' ORDER BY row_pk`,
    );
    expect(rows).toHaveLength(2);
    expect(Number(rows[0]!.chunk_index)).toBe(0);
    expect(rows[0]!.embedding_model).toBe('test-v1');
    expect(rows[0]!.embedded_at).toBeTruthy();
    expect(Number(rows[0]!.vec_dim)).toBe(8);

    const hits = await d.search('docs', 'budget finance', { topK: 1 });
    expect(hits[0]!.row.id).toBe('d1');
  });

  it('stores multiple chunks per row when a chunker is configured', async () => {
    const d = await setup(chunkedConfig());
    const longBody =
      'First section about finance.\n\nSecond section about logistics.\n\nThird about people.';
    await runAsyncOrSync(d.adapter, `INSERT INTO docs (id,title,body) VALUES ('d1','Plan',?)`, [
      longBody,
    ]);
    await d.refreshEmbeddings('docs');

    const rows = await allAsyncOrSync(
      d.adapter,
      `SELECT * FROM "_lattice_embeddings" WHERE table_name='docs' AND row_pk='d1' ORDER BY chunk_index`,
    );
    expect(rows.length).toBeGreaterThan(1);
    expect(String(rows[0]!.content).startsWith('Plan\n\n')).toBe(true);
    expect(rows.map((r) => Number(r.chunk_index))).toEqual(rows.map((_, i) => i));

    const hits = await d.search('docs', 'logistics', { topK: 1 });
    expect(hits[0]!.row.id).toBe('d1');
    expect(hits[0]!.chunkIndex).toBeGreaterThanOrEqual(0);
    expect(hits[0]!.matchedContent).toBeTruthy();
  });

  it('re-embedding a row replaces its chunks (no stale higher-index chunks)', async () => {
    const d = await setup(chunkedConfig());
    const cfg = chunkedConfig();
    await ensureEmbeddingsTable(d.adapter);
    // Store a multi-chunk version directly, then re-store a single-chunk version.
    await storeEmbedding(
      d.adapter,
      'docs',
      'd1',
      { id: 'd1', title: 'T', body: 'aaaa bbbb.\n\ncccc dddd.\n\neeee ffff.\n\ngggg hhhh.' },
      cfg,
    );
    const before = await allAsyncOrSync(
      d.adapter,
      `SELECT chunk_index FROM "_lattice_embeddings" WHERE table_name='docs' AND row_pk='d1'`,
    );
    expect(before.length).toBeGreaterThan(1);

    await storeEmbedding(d.adapter, 'docs', 'd1', { id: 'd1', title: 'T', body: 'short' }, cfg);
    const after = await allAsyncOrSync(
      d.adapter,
      `SELECT chunk_index FROM "_lattice_embeddings" WHERE table_name='docs' AND row_pk='d1'`,
    );
    expect(after).toHaveLength(1);
    expect(Number(after[0]!.chunk_index)).toBe(0);
  });

  it('excludes soft-deleted rows from results', async () => {
    const d = await setup(unchunkedConfig());
    await runAsyncOrSync(
      d.adapter,
      `INSERT INTO docs (id,title,body) VALUES ('d1','budget','finance')`,
    );
    await runAsyncOrSync(
      d.adapter,
      `INSERT INTO docs (id,title,body) VALUES ('d2','budget','finance')`,
    );
    await d.refreshEmbeddings('docs');
    await runAsyncOrSync(d.adapter, `UPDATE docs SET deleted_at='2020-01-01' WHERE id='d1'`);
    const hits = await d.search('docs', 'budget finance', { topK: 10 });
    expect(hits.map((h) => h.row.id)).toEqual(['d2']);
  });

  it('throws loudly on a stored/query dimension mismatch', async () => {
    const d = await setup(unchunkedConfig());
    await runAsyncOrSync(d.adapter, `INSERT INTO docs (id,title,body) VALUES ('d1','a','b')`);
    await d.refreshEmbeddings('docs');
    // Corrupt a stored vector to a different dimension.
    await runAsyncOrSync(
      d.adapter,
      `UPDATE "_lattice_embeddings" SET embedding='[1,2,3]', vec_dim=3 WHERE row_pk='d1'`,
    );
    await expect(d.search('docs', 'a b', { topK: 1 })).rejects.toBeInstanceOf(
      EmbeddingDimensionMismatchError,
    );
  });
});

describe('refreshEmbeddings (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function makeDb(modelId: string): Lattice {
    const d = new Lattice(':memory:');
    d.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      embeddings: { fields: ['body'], embed: tokenEmbed(8), modelId },
      render: () => '',
      outputFile: 'd.md',
    });
    return d;
  }

  it('backfills missing embeddings and sweeps orphans', async () => {
    db = makeDb('m1');
    await db.init();
    await runAsyncOrSync(db.adapter, `INSERT INTO docs (id, body) VALUES ('d1','alpha')`);
    await runAsyncOrSync(db.adapter, `INSERT INTO docs (id, body) VALUES ('d2','beta')`);
    await ensureEmbeddingsTable(db.adapter);
    await runAsyncOrSync(
      db.adapter,
      `INSERT INTO "_lattice_embeddings" (table_name,row_pk,chunk_index,embedding,vec_dim) VALUES ('docs','ghost',0,'[0,0,0,0,0,0,0,0]',8)`,
    );

    const res = await db.refreshEmbeddings('docs');
    expect(res.embedded).toBe(2);
    expect(res.removed).toBe(1); // the ghost
    const hits = await db.search('docs', 'alpha', { topK: 1 });
    expect(hits[0]!.row.id).toBe('d1');
  });

  it('re-embeds only model-stale rows with staleModelOnly', async () => {
    db = makeDb('m2');
    await db.init();
    const cfgM1: EmbeddingsConfig = { fields: ['body'], embed: tokenEmbed(8), modelId: 'm1' };
    const cfgM2: EmbeddingsConfig = { fields: ['body'], embed: tokenEmbed(8), modelId: 'm2' };
    await runAsyncOrSync(db.adapter, `INSERT INTO docs (id, body) VALUES ('d1','alpha')`);
    await runAsyncOrSync(db.adapter, `INSERT INTO docs (id, body) VALUES ('d2','beta')`);
    await ensureEmbeddingsTable(db.adapter);
    await storeEmbedding(db.adapter, 'docs', 'd1', { id: 'd1', body: 'alpha' }, cfgM1); // stale model
    await storeEmbedding(db.adapter, 'docs', 'd2', { id: 'd2', body: 'beta' }, cfgM2); // current

    const opts: RefreshEmbeddingsOptions = { staleModelOnly: true };
    const res = await db.refreshEmbeddings('docs', opts);
    expect(res.embedded).toBe(1); // only d1 (stale model)
    expect(res.skipped).toBe(1); // d2 current
  });
});

describe('legacy embeddings-table migration (SQLite rebuild)', () => {
  it('migrates a legacy (table_name,row_pk,embedding) table to the chunk-aware schema', async () => {
    const db = new Lattice(':memory:');
    await db.init();
    try {
      await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "_lattice_embeddings"`);
      await runAsyncOrSync(
        db.adapter,
        `CREATE TABLE "_lattice_embeddings" (
           "table_name" TEXT NOT NULL,
           "row_pk" TEXT NOT NULL,
           "embedding" TEXT NOT NULL,
           PRIMARY KEY ("table_name","row_pk")
         )`,
      );
      await runAsyncOrSync(
        db.adapter,
        `INSERT INTO "_lattice_embeddings" (table_name,row_pk,embedding) VALUES ('t','r1','[1,2,3]')`,
      );

      await ensureEmbeddingsTable(db.adapter);

      const cols = (
        await allAsyncOrSync(db.adapter, `PRAGMA table_info("_lattice_embeddings")`)
      ).map((c) => c.name);
      expect(cols).toContain('chunk_index');
      expect(cols).toContain('content');
      expect(cols).toContain('embedding_model');

      const rows = await allAsyncOrSync(
        db.adapter,
        `SELECT * FROM "_lattice_embeddings" WHERE table_name='t'`,
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.chunk_index)).toBe(0);
      expect(rows[0]!.embedding).toBe('[1,2,3]');

      await ensureEmbeddingsTable(db.adapter); // idempotent
      const rows2 = await allAsyncOrSync(
        db.adapter,
        `SELECT * FROM "_lattice_embeddings" WHERE table_name='t'`,
      );
      expect(rows2).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe('native vector index — detection + fallback (plain SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function makeDb(): Lattice {
    const d = new Lattice(':memory:');
    d.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      embeddings: { fields: ['body'], embed: tokenEmbed(8) },
      render: () => '',
      outputFile: 'd.md',
    });
    return d;
  }

  it('reports no native extension and buildVectorIndex no-ops', async () => {
    db = makeDb();
    await db.init();
    await runAsyncOrSync(db.adapter, `INSERT INTO docs (id, body) VALUES ('d1','alpha')`);
    await db.refreshEmbeddings('docs');

    expect(await vectorIndexAvailable(db.adapter)).toBe(false);
    expect(await hasVectorIndex(db.adapter, 'docs')).toBe(false);
    expect(await db.buildVectorIndex('docs')).toBe(0); // no-op without extension
    const hits = await db.search('docs', 'alpha', { topK: 1 });
    expect(hits[0]!.row.id).toBe('d1');
  });

  it('buildVectorIndex(requireExtension=true) throws loudly without an extension', async () => {
    db = makeDb();
    await db.init();
    await runAsyncOrSync(db.adapter, `INSERT INTO docs (id, body) VALUES ('d1','alpha')`);
    await db.refreshEmbeddings('docs');
    await expect(db.buildVectorIndex('docs', true)).rejects.toThrow(/no native vector extension/);
  });

  it('buildVectorIndex on a table with no embeddings rejects', async () => {
    db = makeDb();
    await db.init();
    await expect(db.buildVectorIndex('docs')).rejects.toThrow(/no embeddings stored/);
  });
});
