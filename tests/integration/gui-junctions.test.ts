import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import Database from 'better-sqlite3';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { parseConfigFile } from '../../src/config/parser.js';
import { getGuiEntities, isJunctionTable } from '../../src/gui/data.js';

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

/**
 * A config whose `tasks` entity has EXACTLY two foreign keys (assignee_id →
 * people, articles_id → articles) PLUS real data columns (title/status). Under
 * the old relations-only junction heuristic this was mis-classified as a
 * junction — the data-loss bug. Used by the regression tests below.
 */
async function bootWithTasks(): Promise<GuiServerHandle> {
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
      '  people:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '    outputFile: people.md',
      '  tasks:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      status: { type: text }',
      '      assignee_id: { type: uuid }',
      '      articles_id: { type: uuid }',
      '      updated_at: { type: datetime }',
      '    relations:',
      '      assignee: { type: belongsTo, table: people, foreignKey: assignee_id }',
      '      articles: { type: belongsTo, table: articles, foreignKey: articles_id }',
      '    outputFile: tasks.md',
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

async function entityNames(s: GuiServerHandle): Promise<string[]> {
  const e = (await (await fetch(`${s.url}/api/entities`)).json()) as { tables: { name: string }[] };
  return e.tables.map((t) => t.name);
}

function m2mBetween(graph: Graph, a: string, b: string): boolean {
  return graph.edges.some(
    (e) =>
      e.type === 'manyToMany' &&
      ((e.source === 'table:' + a && e.target === 'table:' + b) ||
        (e.source === 'table:' + b && e.target === 'table:' + a)),
  );
}

/** Two first-class entities that share name+email; `leads` additionally has a
 *  source-only `phone` (exercises the merge column-union) and BOTH carry
 *  `deleted_at` so they are soft-deletable (required to merge reversibly).
 *  Used by the merge-route tests. */
async function bootMergeable(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-merge-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  leads:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      email: { type: text }',
      '      phone: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: leads.md',
      '  contacts:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '      email: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: contacts.md',
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

/** A source `s` with a TEXT `qty` and a target `t` with an INTEGER `qty` (same
 *  name, incompatible type) — used to test the merge's type pre-flight. */
async function bootTyped(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-typed-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  s:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      qty: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: s.md',
      '  t:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      qty: { type: integer }',
      '      deleted_at: { type: text }',
      '    outputFile: t.md',
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

/** `src` and `dst`, both soft-deletable with an `email` column — used to force a
 *  mid-merge UNIQUE violation. Returns the SQLite file path so the test can add a
 *  physical constraint the GUI config can't express. */
async function bootDupTarget(): Promise<{ server: GuiServerHandle; dbPath: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-dup-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  src:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      email: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: src.md',
      '  dst:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      email: { type: text }',
      '      deleted_at: { type: text }',
      '    outputFile: dst.md',
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
  return { server, dbPath: join(root, 'data', 'test.db') };
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

    // One link per pair: a second junction between the same two entities (in
    // EITHER direction) is refused — the picker excludes it client-side too.
    const dupForward = await fetch(`${s.url}/api/schema/junctions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ left: 'articles', right: 'tags' }),
    });
    expect(dupForward.status).toBe(400);
    const dupReverse = await fetch(`${s.url}/api/schema/junctions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ left: 'tags', right: 'articles' }),
    });
    expect(dupReverse.status).toBe(400);

    // Remove it via the (new, single) table-delete route — the old
    // /api/schema/junctions/:name DROP-TABLE route was removed.
    const del = await fetch(`${s.url}/api/schema/entities/articles_tags`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    graph = (await (await fetch(`${s.url}/api/graph`)).json()) as Graph;
    expect(m2mBetween(graph, 'articles', 'tags')).toBe(false);
    // The linked entities are untouched.
    expect(graph.nodes.some((n) => n.id === 'table:articles')).toBe(true);
    expect(graph.nodes.some((n) => n.id === 'table:tags')).toBe(true);
  });

  it('materializes a junction with an explicit relations: map (no per-field ref) that re-opens and is detected as a junction', async () => {
    // Junction materialization (schema-ops.materializeJunction) must emit the
    // 4.0 explicit-relations shape — exactly two belongsTo relations, NO
    // per-field `ref:` — so the in-request reopen does not throw and the
    // saved config is still recognized as an m2m junction. This is the
    // lockstep guard for the parser-throw / writer migration.
    const root = mkdtempSync(join(tmpdir(), 'lattice-junc-relshape-'));
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
    const outputDir = join(root, 'context');
    const s = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(s);

    const created = await fetch(`${s.url}/api/schema/junctions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ left: 'articles', right: 'tags' }),
    });
    expect(created.status).toBe(200);

    // (a) Saved config: the junction entity carries an entity-level relations:
    // map with exactly two belongsTo entries and NO per-field `ref:`.
    const savedRaw = readFileSync(configPath, 'utf-8');
    const saved = parse(savedRaw) as {
      entities: Record<
        string,
        {
          fields: Record<string, { type: string; ref?: string }>;
          relations?: Record<string, { type: string; table: string; foreignKey: string }>;
        }
      >;
    };
    const junction = saved.entities.articles_tags;
    expect(junction).toBeTruthy();
    const belongsTo = Object.values(junction!.relations ?? {}).filter(
      (r) => r.type === 'belongsTo',
    );
    expect(belongsTo).toHaveLength(2);
    expect(Object.keys(junction!.relations ?? {})).toHaveLength(2);
    // FK columns map to the relation foreignKeys; the relation names are the
    // `_id`-stripped column names the old ref path produced.
    expect(new Set(belongsTo.map((r) => r.foreignKey))).toEqual(
      new Set(['articles_id', 'tags_id']),
    );
    expect(new Set(Object.keys(junction!.relations ?? {}))).toEqual(new Set(['articles', 'tags']));
    // No per-field `ref:` survives anywhere in the saved junction.
    for (const f of Object.values(junction!.fields)) expect(f.ref).toBeUndefined();

    // (b) Re-opening the saved config via parseConfigFile does NOT throw.
    expect(() => parseConfigFile(configPath)).not.toThrow();

    // (c) isJunctionTable still recognizes it (exactly two belongsTo + two keys).
    const guiTables = getGuiEntities(configPath, outputDir).tables;
    const junctionSummary = guiTables.find((t) => t.name === 'articles_tags');
    expect(junctionSummary).toBeTruthy();
    expect(isJunctionTable(junctionSummary!)).toBe(true);
  });

  it('cannot drop a 2-FK entity that has data columns as a "relationship" (data-loss regression)', async () => {
    const s = await bootWithTasks();
    // `tasks` has 2 FKs + title/status — a first-class entity, never a junction.
    expect(await entityNames(s)).toContain('tasks');

    // The old wholesale junction-drop route is GONE — it must not drop `tasks`.
    const legacy = await fetch(`${s.url}/api/schema/junctions/tasks`, { method: 'DELETE' });
    expect(legacy.status).not.toBe(200);
    expect(await entityNames(s)).toContain('tasks'); // still there — nothing dropped

    // It is also not collapsed into an m2m edge; it is a normal node with
    // two FK edges (people, articles).
    const graph = (await (await fetch(`${s.url}/api/graph`)).json()) as Graph;
    expect(graph.nodes.some((n) => n.id === 'table:tasks')).toBe(true);
    expect(m2mBetween(graph, 'people', 'articles')).toBe(false);
  });

  it('per-link delete on a 2-FK entity drops only that FK column, never the table', async () => {
    const s = await bootWithTasks();
    const del = await fetch(`${s.url}/api/schema/entities/tasks/links/assignee_id`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    const tasks = (await (await fetch(`${s.url}/api/entities`)).json()) as {
      tables: { name: string; columns: string[] }[];
    };
    const t = tasks.tables.find((x) => x.name === 'tasks');
    expect(t).toBeTruthy(); // table intact
    expect(t!.columns).not.toContain('assignee_id'); // dropped column
    expect(t!.columns).toContain('articles_id'); // other link intact
    expect(t!.columns).toContain('title'); // data columns intact
  });

  it('rejects a second link to an entity that is already linked (no duplicate links)', async () => {
    const s = await bootWithTasks();
    const addLink = (target: string) =>
      fetch(`${s.url}/api/schema/entities/tasks/links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target }),
      });
    // tasks already links to people (assignee_id) and articles (articles_id)
    // from the seed — a second link to either is refused.
    expect((await addLink('people')).status).toBe(400);
    expect((await addLink('articles')).status).toBe(400);
    // No stray <target>_id_2 column was created.
    const t = (await (await fetch(`${s.url}/api/entities`)).json()) as {
      tables: { name: string; columns: string[] }[];
    };
    const cols = t.tables.find((x) => x.name === 'tasks')!.columns;
    expect(cols).not.toContain('people_id');
    expect(cols).not.toContain('articles_id_2');
  });

  it('delete-table refuses while another table links to it, then succeeds once links are gone', async () => {
    const s = await bootWithTasks();
    // `people` is referenced by tasks.assignee_id → deleting it would dangle
    // that FK. The guard must refuse (non-breaking) and the table must survive.
    const refused = await fetch(`${s.url}/api/schema/entities/people`, { method: 'DELETE' });
    expect(refused.status).toBe(400);
    expect(await entityNames(s)).toContain('people');

    // Remove the inbound link first, then the delete succeeds.
    const unlink = await fetch(`${s.url}/api/schema/entities/tasks/links/assignee_id`, {
      method: 'DELETE',
    });
    expect(unlink.status).toBe(200);
    const ok = await fetch(`${s.url}/api/schema/entities/people`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(await entityNames(s)).not.toContain('people');
    // tasks (the referencing table) is untouched by people's deletion.
    expect(await entityNames(s)).toContain('tasks');
  });

  it('exposes canonical fieldTypes on /api/entities (no raw SQL in the type)', async () => {
    const s = await bootWithTasks();
    const e = (await (await fetch(`${s.url}/api/entities`)).json()) as {
      tables: { name: string; fieldTypes?: Record<string, string> }[];
    };
    const t = e.tables.find((x) => x.name === 'tasks');
    expect(t?.fieldTypes).toBeTruthy();
    expect(t!.fieldTypes!.id).toBe('uuid');
    expect(t!.fieldTypes!.title).toBe('text');
    expect(t!.fieldTypes!.updated_at).toBe('datetime');
    expect(t!.fieldTypes!.assignee_id).toBe('uuid');
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

  it('rejects creating a relationship to an unknown entity and linking to a missing target', async () => {
    const s = await boot();
    const bad = await fetch(`${s.url}/api/schema/junctions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ left: 'articles', right: 'nope' }),
    });
    expect(bad.status).toBe(400);

    // Adding a link to a nonexistent target is rejected.
    const badLink = await fetch(`${s.url}/api/schema/entities/articles/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'nope' }),
    });
    expect(badLink.status).toBe(400);

    // Deleting an unknown table is a 400, not a crash.
    const badDel = await fetch(`${s.url}/api/schema/entities/nope`, { method: 'DELETE' });
    expect(badDel.status).toBe(400);
  });

  it('merges one entity into another: moves the rows, removes the source, reversibly', async () => {
    const s = await bootMergeable();
    const post = (path: string, body: unknown) =>
      fetch(`${s.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Seed two leads (a fresh row create is 201).
    expect((await post('/api/tables/leads/rows', { name: 'Ada', email: 'ada@x.io' })).status).toBe(
      201,
    );
    expect(
      (await post('/api/tables/leads/rows', { name: 'Linus', email: 'linus@x.io' })).status,
    ).toBe(201);

    // Merge leads → contacts.
    const res = await post('/api/schema/entities/leads/merge', { target: 'contacts' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      merged?: string;
      into?: string;
      movedRows?: number;
    };
    expect(body.ok).toBe(true);
    expect(body.merged).toBe('leads');
    expect(body.into).toBe('contacts');
    expect(body.movedRows).toBe(2);

    // The source is gone (soft-deleted) from the live entity list; the target stays.
    expect(await entityNames(s)).not.toContain('leads');
    expect(await entityNames(s)).toContain('contacts');

    // The rows now live in the target, with their values mapped by column name.
    const listed = (await (await fetch(`${s.url}/api/tables/contacts/rows`)).json()) as {
      rows: { name: string; email: string }[];
    };
    expect(listed.rows.map((r) => r.name).sort()).toEqual(['Ada', 'Linus']);
    expect(listed.rows.map((r) => r.email).sort()).toEqual(['ada@x.io', 'linus@x.io']);

    // Reversible: the source's delete is captured in version history (a
    // schema.delete_entity op that the History page replays to restore it).
    const history = (await (await fetch(`${s.url}/api/history`)).json()) as {
      entries: { operation: string; table_name?: string }[];
    };
    expect(
      history.entries.some(
        (h) => h.operation === 'schema.delete_entity' && h.table_name === 'leads',
      ),
    ).toBe(true);
  });

  it('rejects bad merges (into itself, unknown source/target) with 400 and deletes nothing', async () => {
    const s = await bootMergeable();
    const merge = (source: string, target: unknown) =>
      fetch(`${s.url}/api/schema/entities/${source}/merge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target }),
      });
    expect((await merge('leads', 'leads')).status).toBe(400); // into itself
    expect((await merge('leads', 'ghosts')).status).toBe(400); // unknown target
    expect((await merge('ghosts', 'contacts')).status).toBe(400); // unknown source
    // None of the rejected merges removed anything.
    expect(await entityNames(s)).toEqual(expect.arrayContaining(['leads', 'contacts']));
  });

  it('unions source-only columns into the target (no silent field drop)', async () => {
    const s = await bootMergeable();
    const post = (path: string, body: unknown) =>
      fetch(`${s.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    // `leads` has a `phone` column that `contacts` lacks.
    expect(
      (await post('/api/tables/leads/rows', { name: 'Ada', email: 'a@x.io', phone: '555-0001' }))
        .status,
    ).toBe(201);

    const res = await post('/api/schema/entities/leads/merge', { target: 'contacts' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { movedRows?: number }).movedRows).toBe(1);

    // contacts GAINED the `phone` column AND the moved row keeps its phone value.
    const ents = (await (await fetch(`${s.url}/api/entities`)).json()) as {
      tables: { name: string; columns: string[] }[];
    };
    expect(ents.tables.find((t) => t.name === 'contacts')!.columns).toContain('phone');
    const rows = (await (await fetch(`${s.url}/api/tables/contacts/rows`)).json()) as {
      rows: { name: string; phone: string }[];
    };
    expect(rows.rows.find((r) => r.name === 'Ada')!.phone).toBe('555-0001');
  });

  it('refuses to merge a source whose rows are not soft-deletable (no deleted_at)', async () => {
    const s = await boot(); // articles/tags have no deleted_at column
    const post = (path: string, body: unknown) =>
      fetch(`${s.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    // Non-empty (an empty table would just soft-delete immediately, before move_to).
    expect((await post('/api/tables/articles/rows', { title: 'Keep me' })).status).toBe(201);
    const res = await post('/api/schema/entities/articles/merge', { target: 'tags' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/deleted_at|reversibly/i);
    // Nothing was moved or deleted.
    expect(await entityNames(s)).toEqual(expect.arrayContaining(['articles', 'tags']));
    expect(
      ((await (await fetch(`${s.url}/api/tables/articles/rows`)).json()) as { rows: unknown[] })
        .rows.length,
    ).toBe(1);
  });

  it('refuses to merge a source another table links to (inbound FK)', async () => {
    const s = await bootWithTasks(); // tasks.assignee_id → people
    const res = await fetch(`${s.url}/api/schema/entities/people/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'articles' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/links point at it|inbound/i);
    expect(await entityNames(s)).toEqual(expect.arrayContaining(['people', 'articles', 'tasks']));
  });

  it('refuses to merge when a secret source column would land in a non-secret target', async () => {
    const s = await bootMergeable();
    const post = (path: string, body: unknown) =>
      fetch(`${s.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(
      (await post('/api/tables/leads/rows', { name: 'Ada', email: 'secret@x.io' })).status,
    ).toBe(201);
    // Mark leads.email secret; contacts.email is NOT secret.
    const marked = await fetch(`${s.url}/api/gui-meta/columns/leads/email`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: true }),
    });
    expect(marked.status).toBe(200);
    const res = await post('/api/schema/entities/leads/merge', { target: 'contacts' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/secret|visible/i);
    expect(await entityNames(s)).toContain('leads'); // nothing moved
  });

  it('rolls back the ENTIRE merge when a row fails mid-loop (no split state)', async () => {
    // This exercises the transaction wrap end-to-end (not just the type pre-flight,
    // which aborts before the transaction opens). Two source rows share an email;
    // a physical UNIQUE index on the target — which the type pre-flight can't catch —
    // makes the SECOND row's insert throw mid-loop, so the whole merge must roll back.
    const { server: s, dbPath } = await bootDupTarget();
    const post = (path: string, body: unknown) =>
      fetch(`${s.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post('/api/tables/src/rows', { email: 'dup@x.io' })).status).toBe(201);
    expect((await post('/api/tables/src/rows', { email: 'dup@x.io' })).status).toBe(201);

    // Add a UNIQUE constraint the GUI config can't express, via a second connection.
    const raw = new Database(dbPath);
    raw.exec('CREATE UNIQUE INDEX dst_email_uq ON dst(email)');
    raw.close();

    // Merge: row 1 inserts into dst OK, row 2's insert hits the UNIQUE violation
    // mid-loop → the transaction rolls back. The route maps the throw to a 500.
    const res = await post('/api/schema/entities/src/merge', { target: 'dst' });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Atomic: NOTHING moved. src keeps both rows (soft-deletes rolled back), dst empty.
    expect(
      ((await (await fetch(`${s.url}/api/tables/src/rows`)).json()) as { rows: unknown[] }).rows
        .length,
    ).toBe(2);
    expect(
      ((await (await fetch(`${s.url}/api/tables/dst/rows`)).json()) as { rows: unknown[] }).rows
        .length,
    ).toBe(0);
    // src is still a live table (the source-removal never ran — the move threw first).
    expect(await entityNames(s)).toContain('src');
  });

  it('hands an over-cap merge back as needsResolution (400 + plain-language message)', async () => {
    // A source larger than AI_DELETE_ROW_CAP (1000) must not hard-fail with jargon;
    // it returns a needsResolution outcome the route maps to 400 + a plain message.
    const { server: s, dbPath } = await bootDupTarget();
    const raw = new Database(dbPath);
    const stmt = raw.prepare('INSERT INTO src (id, email, deleted_at) VALUES (?, ?, NULL)');
    const many = raw.transaction((n: number) => {
      for (let i = 0; i < n; i++) stmt.run(`ovc-${i}`, `e${i}@x.io`);
    });
    many(1001); // > cap
    raw.close();

    const res = await fetch(`${s.url}/api/schema/entities/src/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'dst' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /too many to merge automatically/i,
    );
    // Nothing moved — the source is intact.
    expect(await entityNames(s)).toContain('src');
  });

  it('type-pre-flights the merge and aborts BEFORE any write (no partial merge)', async () => {
    const s = await bootTyped(); // s.qty is TEXT, t.qty is INTEGER
    const post = (path: string, body: unknown) =>
      fetch(`${s.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post('/api/tables/s/rows', { qty: '5' })).status).toBe(201);
    expect((await post('/api/tables/s/rows', { qty: 'N/A' })).status).toBe(201); // can't be an INTEGER

    const res = await post('/api/schema/entities/s/merge', { target: 't' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not compatible/i);

    // NOTHING moved: the source is intact (both rows, still a table) and the target
    // is still empty — the merge aborted before the first write, so no split state.
    expect(await entityNames(s)).toEqual(expect.arrayContaining(['s', 't']));
    expect(
      ((await (await fetch(`${s.url}/api/tables/s/rows`)).json()) as { rows: unknown[] }).rows
        .length,
    ).toBe(2);
    expect(
      ((await (await fetch(`${s.url}/api/tables/t/rows`)).json()) as { rows: unknown[] }).rows
        .length,
    ).toBe(0);
  });
});
