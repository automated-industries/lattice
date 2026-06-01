import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Editing many-to-many relationships from the Data Model: POST a junction to
 * link two entities (it surfaces as a manyToMany edge in /api/graph), then
 * DELETE it to remove the relationship (junction table dropped, entities kept).
 */

interface GraphEdge {
  source: string;
  target: string;
  type: string;
}
interface Graph {
  nodes: { id: string; type: string }[];
  edges: GraphEdge[];
}

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-junc-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  articles:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '    outputFile: articles.md',
      '  tags:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '    outputFile: tags.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

function m2mBetween(graph: Graph, a: string, b: string): boolean {
  return graph.edges.some(
    (e) =>
      e.type === 'manyToMany' &&
      ((e.source === 'table:' + a && e.target === 'table:' + b) ||
        (e.source === 'table:' + b && e.target === 'table:' + a)),
  );
}

describe('Data Model — junction relationships', () => {
  it('creates a many-to-many that surfaces as a graph edge, then removes it', async () => {
    const s = await boot();

    // Initially no m2m between articles and tags.
    let graph = (await (await fetch(`${s.url}/api/graph`)).json()) as Graph;
    expect(m2mBetween(graph, 'articles', 'tags')).toBe(false);

    // Create the relationship.
    const created = (await (
      await fetch(`${s.url}/api/schema/junctions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ left: 'articles', right: 'tags' }),
      })
    ).json()) as { ok?: boolean; name?: string };
    expect(created.ok).toBe(true);
    expect(created.name).toBe('articles_tags');

    // It now shows as an m2m edge; the junction node itself is collapsed.
    graph = (await (await fetch(`${s.url}/api/graph`)).json()) as Graph;
    expect(m2mBetween(graph, 'articles', 'tags')).toBe(true);
    expect(graph.nodes.some((n) => n.id === 'table:articles_tags')).toBe(false);

    // Remove it.
    const del = await fetch(`${s.url}/api/schema/junctions/articles_tags`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    graph = (await (await fetch(`${s.url}/api/graph`)).json()) as Graph;
    expect(m2mBetween(graph, 'articles', 'tags')).toBe(false);
    // The linked entities are untouched.
    expect(graph.nodes.some((n) => n.id === 'table:articles')).toBe(true);
    expect(graph.nodes.some((n) => n.id === 'table:tags')).toBe(true);
  });

  it('rejects linking unknown entities and refuses to DELETE a non-junction', async () => {
    const s = await boot();
    const bad = await fetch(`${s.url}/api/schema/junctions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ left: 'articles', right: 'nope' }),
    });
    expect(bad.status).toBe(400);

    // articles is a first-class entity, not a junction — must not be droppable here.
    const delEntity = await fetch(`${s.url}/api/schema/junctions/articles`, { method: 'DELETE' });
    expect(delEntity.status).toBe(400);
  });
});
