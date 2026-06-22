import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { traverse, graphAdjacencyBoost, MAX_TRAVERSAL_DEPTH } from '../../src/search/graph.js';

/**
 * p9 — graph-augmented retrieval: typed edges, bounded BFS, zero-LLM extraction,
 * adjacency boost.
 */
describe('graph edges + traversal (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', parent_id: 'TEXT' },
      render: () => '',
      outputFile: 'd.md',
    });
    await db.init();
    return db;
  }

  it('adds, queries, and removes edges', async () => {
    const d = await setup();
    await d.addEdge({ srcTable: 'docs', srcId: 'a', dstTable: 'docs', dstId: 'b', type: 'cites' });
    await d.addEdge({
      srcTable: 'docs',
      srcId: 'a',
      dstTable: 'docs',
      dstId: 'c',
      type: 'cites',
      weight: 2,
    });

    const out = await d.neighbors({ table: 'docs', id: 'a' }, { direction: 'out' });
    expect(out.map((e) => e.dstId).sort()).toEqual(['b', 'c']);
    expect(out.find((e) => e.dstId === 'c')!.weight).toBe(2);

    const inB = await d.neighbors({ table: 'docs', id: 'b' }, { direction: 'in' });
    expect(inB.map((e) => e.srcId)).toEqual(['a']);

    await d.removeEdge({ srcTable: 'docs', srcId: 'a', dstTable: 'docs', dstId: 'b' });
    const out2 = await d.neighbors({ table: 'docs', id: 'a' }, { direction: 'out' });
    expect(out2.map((e) => e.dstId)).toEqual(['c']);
  });

  it('upserts an edge weight (no duplicate)', async () => {
    const d = await setup();
    await d.addEdge({
      srcTable: 'docs',
      srcId: 'a',
      dstTable: 'docs',
      dstId: 'b',
      type: 'cites',
      weight: 1,
    });
    await d.addEdge({
      srcTable: 'docs',
      srcId: 'a',
      dstTable: 'docs',
      dstId: 'b',
      type: 'cites',
      weight: 5,
    });
    const out = await d.neighbors({ table: 'docs', id: 'a' });
    expect(out).toHaveLength(1);
    expect(out[0]!.weight).toBe(5);
  });

  it('bounded BFS reaches nodes at increasing depth and clamps maxDepth', async () => {
    const d = await setup();
    // chain a -> b -> c -> d -> e
    const chain = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 0; i < chain.length - 1; i++) {
      await d.addEdge({
        srcTable: 'docs',
        srcId: chain[i]!,
        dstTable: 'docs',
        dstId: chain[i + 1]!,
        type: 'next',
      });
    }
    const t2 = await d.traverseGraph({ table: 'docs', id: 'a' }, { maxDepth: 2 });
    expect(t2.nodes.map((n) => n.node.id).sort()).toEqual(['a', 'b', 'c']);
    expect(t2.nodes.find((n) => n.node.id === 'c')!.depth).toBe(2);

    // maxDepth is clamped to MAX_TRAVERSAL_DEPTH
    const tBig = await traverse(d.adapter, { table: 'docs', id: 'a' }, { maxDepth: 99 });
    expect(tBig.nodes.length).toBe(5); // whole chain (5 < clamp)
    expect(MAX_TRAVERSAL_DEPTH).toBe(5);
  });

  it('terminates on a cycle (visited guard)', async () => {
    const d = await setup();
    await d.addEdge({ srcTable: 'docs', srcId: 'a', dstTable: 'docs', dstId: 'b', type: 'next' });
    await d.addEdge({ srcTable: 'docs', srcId: 'b', dstTable: 'docs', dstId: 'a', type: 'next' });
    const t = await d.traverseGraph({ table: 'docs', id: 'a' }, { maxDepth: 5 });
    expect(t.nodes.map((n) => n.node.id).sort()).toEqual(['a', 'b']);
  });

  it('marks truncated when the node cap is hit', async () => {
    const d = await setup();
    for (let i = 0; i < 10; i++) {
      await d.addEdge({
        srcTable: 'docs',
        srcId: 'a',
        dstTable: 'docs',
        dstId: `n${String(i)}`,
        type: 'e',
      });
    }
    const t = await traverse(d.adapter, { table: 'docs', id: 'a' }, { maxDepth: 2, maxNodes: 3 });
    expect(t.truncated).toBe(true);
    expect(t.nodes.length).toBeLessThanOrEqual(3);
  });

  it('extracts edges from a foreign-key column (zero-LLM)', async () => {
    const d = await setup();
    await d.insert('docs', { id: 'root', title: 'Root' });
    await d.insert('docs', { id: 'child1', title: 'C1', parent_id: 'root' });
    await d.insert('docs', { id: 'child2', title: 'C2', parent_id: 'root' });
    const n = await d.extractEdges({
      srcTable: 'docs',
      fkColumn: 'parent_id',
      dstTable: 'docs',
      type: 'child_of',
    });
    expect(n).toBe(2); // root has null parent → skipped
    const children = await d.neighbors(
      { table: 'docs', id: 'root' },
      { direction: 'in', edgeTypes: ['child_of'] },
    );
    expect(children.map((e) => e.srcId).sort()).toEqual(['child1', 'child2']);
  });
});

describe('graphAdjacencyBoost', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('boosts results adjacent to an anchor above unrelated ones', async () => {
    db = new Lattice(':memory:');
    db.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT' },
      render: () => '',
      outputFile: 'd.md',
    });
    await db.init();
    // anchor 'ctx' connects to 'b'. Results: a (higher base) and b (lower base).
    await db.addEdge({ srcTable: 'docs', srcId: 'ctx', dstTable: 'docs', dstId: 'b', type: 'rel' });
    const results = [
      { id: 'a', score: 0.6 },
      { id: 'b', score: 0.5 },
    ];
    const boosted = await graphAdjacencyBoost(db.adapter, results, {
      anchors: [{ table: 'docs', id: 'ctx' }],
      resultTable: 'docs',
      weight: 1, // strong boost
      maxDepth: 1,
    });
    // b is 1 hop from ctx → boosted 0.5*(1+1/1)=1.0 > a's 0.6
    expect(boosted[0]!.item.id).toBe('b');
    expect(boosted.find((x) => x.item.id === 'b')!.hops).toBe(1);
    expect(boosted.find((x) => x.item.id === 'a')!.hops).toBe(Infinity);
  });
});
