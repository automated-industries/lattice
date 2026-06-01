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

  it('adds a link (foreign key) then destroys it from the columns editor', async () => {
    const s = await boot();
    // Add a link articles → tags via the dedicated links endpoint. The server
    // names the FK <target>_id; relationships are NOT created via add-column.
    const add = (await (
      await fetch(`${s.url}/api/schema/entities/articles/links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'tags' }),
      })
    ).json()) as { ok?: boolean; column?: string };
    expect(add.ok).toBe(true);
    expect(add.column).toBe('tags_id');
    let graph = (await (await fetch(`${s.url}/api/graph`)).json()) as Graph;
    expect(
      graph.edges.some(
        (e) => e.type === 'belongsTo' && e.source === 'table:articles' && e.target === 'table:tags',
      ),
    ).toBe(true);

    // Destroy the link — the FK column is dropped and the edge disappears.
    const del = await fetch(`${s.url}/api/schema/entities/articles/links/tags_id`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    graph = (await (await fetch(`${s.url}/api/graph`)).json()) as Graph;
    expect(graph.edges.some((e) => e.type === 'belongsTo' && e.target === 'table:tags')).toBe(
      false,
    );
  });

  it('enforces column-editing restrictions on the backend (bad data models 400)', async () => {
    const s = await boot();
    const post = (path: string, body: unknown) =>
      fetch(`${s.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // uuid is reserved for keys — not a selectable scalar column type.
    expect(
      (await post('/api/schema/entities/articles/columns', { name: 'ref_uuid', type: 'uuid' }))
        .status,
    ).toBe(400);
    // A scalar column may not carry a ref — links go through the links endpoint.
    expect(
      (
        await post('/api/schema/entities/articles/columns', {
          name: 'tag_id',
          type: 'uuid',
          ref: 'tags',
        })
      ).status,
    ).toBe(400);
    // System column names are reserved.
    expect(
      (await post('/api/schema/entities/articles/columns', { name: 'created_at', type: 'text' }))
        .status,
    ).toBe(400);

    // Renaming a system column is rejected.
    expect(
      (await post('/api/schema/entities/articles/columns/id/rename', { to: 'pk' })).status,
    ).toBe(400);

    // Add a real scalar column, then confirm secret toggles work for it but
    // are rejected for system + link columns.
    expect(
      (await post('/api/schema/entities/articles/columns', { name: 'summary', type: 'text' }))
        .status,
    ).toBe(200);
    const setSecret = (table: string, col: string) =>
      fetch(`${s.url}/api/gui-meta/columns/${table}/${col}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: true }),
      });
    expect((await setSecret('articles', 'summary')).status).toBe(200);
    expect((await setSecret('articles', 'id')).status).toBe(400); // system
    // Add a link, then confirm it can't be marked secret and its name can't
    // be renamed — links are destroy-only.
    expect((await post('/api/schema/entities/articles/links', { target: 'tags' })).status).toBe(
      200,
    );
    expect((await setSecret('articles', 'tags_id')).status).toBe(400); // link/FK
    expect(
      (await post('/api/schema/entities/articles/columns/tags_id/rename', { to: 'tag_ref' }))
        .status,
    ).toBe(400);
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

    // Adding a link to a nonexistent target is rejected.
    const badLink = await fetch(`${s.url}/api/schema/entities/articles/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'nope' }),
    });
    expect(badLink.status).toBe(400);
  });
});
