/**
 * Postgres dialect-parity for p9 graph retrieval: edges, bounded BFS, zero-LLM
 * extraction, and graph-augmented hybrid search (graphSearch) on real Postgres.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';
import type { EmbeddingsConfig } from '../../src/types.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

function tokenEmbed(dim = 12) {
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
const embConfig: EmbeddingsConfig = {
  fields: ['title', 'body'],
  embed: tokenEmbed(12),
  modelId: 'm1',
};

describe.skipIf(!PG_URL)('p9 graph (Postgres)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const docs = `__lattice_test_${runId}_docs`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(docs, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        title: 'TEXT',
        body: 'TEXT',
        parent_id: 'TEXT',
        deleted_at: 'TEXT',
      },
      fts: { fields: ['title', 'body'] },
      embeddings: embConfig,
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
    await db.insert(docs, { id: 'root', title: 'budget root', body: 'finance overview' });
    await db.insert(docs, {
      id: 'c1',
      title: 'budget child',
      body: 'finance detail',
      parent_id: 'root',
    });
    await db.insert(docs, { id: 'far', title: 'budget unrelated', body: 'finance elsewhere' });
    await db.refreshEmbeddings(docs);
  });

  afterAll(async () => {
    try {
      await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${docs}" CASCADE`);
      await runAsyncOrSync(db.adapter, `DELETE FROM "__lattice_edges" WHERE src_table = '${docs}'`);
      await runAsyncOrSync(
        db.adapter,
        `DELETE FROM "_lattice_embeddings" WHERE table_name = '${docs}'`,
      );
    } catch {
      /* best effort */
    }
    db.close();
  });

  it('extracts edges + traverses on Postgres', async () => {
    const n = await db.extractEdges({
      srcTable: docs,
      fkColumn: 'parent_id',
      dstTable: docs,
      type: 'child_of',
    });
    expect(n).toBe(1); // only c1 has a parent
    const t = await db.traverseGraph({ table: docs, id: 'root' }, { direction: 'in', maxDepth: 2 });
    expect(t.nodes.map((x) => x.node.id)).toContain('c1');
  });

  it('graphSearch boosts an anchor-adjacent result', async () => {
    // c1 is child_of root; anchor on root should lift c1.
    const results = await db.graphSearch(docs, 'budget finance', {
      topK: 3,
      anchors: [{ table: docs, id: 'root' }],
      graphWeight: 2,
      graphDepth: 1,
      graphDirection: 'in',
      graphEdgeTypes: ['child_of'],
    });
    const ids = results.map((r) => r.row.id);
    // c1 (anchor-adjacent) should outrank 'far' (unrelated, similar relevance)
    expect(ids.indexOf('c1')).toBeLessThan(ids.indexOf('far'));
  });
});
