import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGuiGraph,
  getGuiEntities,
  isJunctionTable,
  type GuiTableSummary,
} from '../../src/gui/data.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import type { BelongsToRelation, Relation } from '../../src/types.js';
import { writeManifest } from '../../src/lifecycle/manifest.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-gui-'));
  dirs.push(dir);
  return dir;
}

function writeFixture(root: string): { configPath: string; outputDir: string } {
  const outputDir = join(root, 'context');
  mkdirSync(join(outputDir, 'agents', 'alpha'), { recursive: true });
  mkdirSync(join(outputDir, 'agents', 'beta'), { recursive: true });
  mkdirSync(join(outputDir, 'teams', 'core'), { recursive: true });

  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  agents:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      slug: { type: text, required: true }',
      '      name: { type: text, required: true }',
      '      team_id: { type: uuid, ref: teams }',
      '    render: default-table',
      '    outputFile: agents.md',
      '  tasks:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      agent_id: { type: uuid, ref: agents }',
      '      title: { type: text }',
      '    render: default-list',
      '    outputFile: tasks.md',
      '  teams:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '    render: default-list',
      '    outputFile: teams.md',
      '  skills:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '    render: default-list',
      '    outputFile: skills.md',
      '  agent_skills:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      agent_id: { type: uuid, ref: agents }',
      '      skill_id: { type: uuid, ref: skills }',
      '    render: default-list',
      '    outputFile: agent-skills.md',
      '',
      'entityContexts:',
      '  agents:',
      '    slug: "{{slug}}"',
      '    directoryRoot: agents',
      '    files:',
      '      AGENT.md:',
      '        source: self',
      '        template: default-detail',
      '      TASKS.md:',
      '        source: { type: hasMany, table: tasks, foreignKey: agent_id }',
      '        template: default-list',
      '      TEAM.md:',
      '        source: { type: belongsTo, table: teams, foreignKey: team_id }',
      '        template: default-list',
      '      SKILLS.md:',
      '        source:',
      '          type: manyToMany',
      '          junctionTable: agent_skills',
      '          localKey: agent_id',
      '          remoteKey: skill_id',
      '          remoteTable: skills',
      '        template: default-list',
      '    combined:',
      '      outputFile: CONTEXT.md',
      '  teams:',
      '    slug: "{{slug}}"',
      '    directoryRoot: teams',
      '    files:',
      '      TEAM.md:',
      '        source: self',
      '        template: default-detail',
    ].join('\n'),
  );

  writeFileSync(
    join(outputDir, 'agents', 'alpha', 'AGENT.md'),
    '# Alpha\n\n[Beta](../beta/AGENT.md)\n[Core Team](../../teams/core/TEAM.md)',
  );
  writeFileSync(join(outputDir, 'agents', 'alpha', 'TASKS.md'), '- Task One');
  writeFileSync(join(outputDir, 'agents', 'alpha', 'TEAM.md'), '- Team One');
  writeFileSync(join(outputDir, 'agents', 'alpha', 'SKILLS.md'), '- TypeScript');
  writeFileSync(join(outputDir, 'agents', 'alpha', 'CONTEXT.md'), '# Alpha');
  writeFileSync(join(outputDir, 'agents', 'beta', 'AGENT.md'), '# Beta');
  writeFileSync(join(outputDir, 'teams', 'core', 'TEAM.md'), '# Core');

  writeManifest(outputDir, {
    version: 2,
    generated_at: '2026-05-08T00:00:00.000Z',
    entityContexts: {
      agents: {
        directoryRoot: 'agents',
        declaredFiles: ['AGENT.md', 'TASKS.md', 'TEAM.md', 'SKILLS.md'],
        protectedFiles: [],
        entities: {
          alpha: {
            'AGENT.md': { hash: 'a' },
            'TASKS.md': { hash: 'b' },
            'TEAM.md': { hash: 'c' },
            'SKILLS.md': { hash: 'd' },
            'CONTEXT.md': { hash: 'e' },
          },
          beta: {
            'AGENT.md': { hash: 'f' },
          },
        },
      },
      teams: {
        directoryRoot: 'teams',
        declaredFiles: ['TEAM.md'],
        protectedFiles: [],
        entities: {
          core: {
            'TEAM.md': { hash: 'g' },
          },
        },
      },
    },
  });

  return { configPath, outputDir };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GUI graph builder', () => {
  it('builds table, entity, file, source, and markdown-link graph data', () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const graph = buildGuiGraph(configPath, outputDir);
    const nodeIds = graph.nodes.map((n) => n.id);
    const edgeTypes = graph.edges.map((e) => e.type);

    expect(nodeIds).toContain('table:agents');
    expect(nodeIds).toContain('entity:agents:alpha');
    expect(nodeIds).toContain('file:agents/alpha/AGENT.md');
    expect(edgeTypes).toContain('hasMany');
    expect(edgeTypes).toContain('belongsTo');
    expect(edgeTypes).toContain('manyToMany');
    expect(edgeTypes).toContain('markdown');
    expect(
      graph.edges.some(
        (edge) =>
          edge.type === 'markdown' &&
          edge.source === 'table:agents' &&
          edge.target === 'table:teams',
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.type === 'markdown' &&
          edge.source === 'table:agents' &&
          edge.target === 'table:skills' &&
          edge.label === 'SKILLS.md',
      ),
    ).toBe(true);
  });

  it('adds extraTables (native entities / team-shared) as graph nodes', () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const graph = buildGuiGraph(configPath, outputDir, {
      extraTables: [
        { name: 'files', columns: ['id', 'path'], outputFile: '', relations: {} },
        { name: 'secrets', columns: ['id', 'name'], outputFile: '', relations: {} },
      ],
    });
    const nodeIds = graph.nodes.map((n) => n.id);
    // Native entities, absent from the YAML, now show in the Data Model.
    expect(nodeIds).toContain('table:files');
    expect(nodeIds).toContain('table:secrets');
    // YAML tables still present.
    expect(nodeIds).toContain('table:agents');
  });

  it('drops table nodes that fail the team-cloud visibility filter', () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const visible = new Set(['agents', 'secrets']);
    const graph = buildGuiGraph(configPath, outputDir, {
      extraTables: [
        { name: 'files', columns: ['id'], outputFile: '', relations: {} },
        { name: 'secrets', columns: ['id'], outputFile: '', relations: {} },
      ],
      visibleFilter: (name) => visible.has(name),
    });
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).toContain('table:agents');
    expect(nodeIds).toContain('table:secrets');
    // Not in the visible set → hidden, and no dangling edges reference it.
    expect(nodeIds).not.toContain('table:files');
    expect(nodeIds).not.toContain('table:teams');
    const presentIds = new Set(nodeIds);
    for (const edge of graph.edges) {
      expect(presentIds.has(edge.source)).toBe(true);
      expect(presentIds.has(edge.target)).toBe(true);
    }
  });

  it('returns an empty entity list when the manifest is missing', () => {
    const root = tempDir();
    const { configPath } = writeFixture(root);
    const outputDir = join(root, 'empty-context');
    mkdirSync(outputDir);

    const entities = getGuiEntities(configPath, outputDir);
    expect(entities.hasManifest).toBe(false);
    expect(entities.entities).toEqual([]);
    expect(entities.tables.map((t) => t.name)).toContain('agents');
  });

  it('rejects manifest file paths that escape the output directory', () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    writeManifest(outputDir, {
      version: 2,
      generated_at: '2026-05-08T00:00:00.000Z',
      entityContexts: {
        agents: {
          directoryRoot: 'agents',
          declaredFiles: ['AGENT.md'],
          protectedFiles: [],
          entities: {
            alpha: {
              '../../../outside.md': { hash: 'bad' },
            },
          },
        },
      },
    });

    expect(() => buildGuiGraph(configPath, outputDir)).toThrow(/escapes output directory/);
  });
});

describe('GUI server', () => {
  it('serves project, entities, and graph endpoints', async () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const project = (await fetch(`${server.url}/api/project`).then((r) => r.json())) as {
      tableCount: number;
    };
    const entities = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string; rowCount: number }[];
      entities: unknown[];
    };
    const graph = (await fetch(`${server.url}/api/graph`).then((r) => r.json())) as {
      nodes: { id: string }[];
      edges: unknown[];
    };

    expect(project.tableCount).toBeGreaterThan(0);
    expect(entities.tables.every((t) => typeof t.rowCount === 'number')).toBe(true);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);

    // Native entities (files, secrets) are registered at runtime, not in
    // the YAML — they must still appear in the Data Model graph and the
    // entity list. Regression guard for the "Data Model is empty" bug.
    const graphNodeIds = graph.nodes.map((n) => n.id);
    expect(graphNodeIds).toContain('table:files');
    expect(graphNodeIds).toContain('table:secrets');
    const entityNames = entities.tables.map((t) => t.name);
    expect(entityNames).toContain('files');
    expect(entityNames).toContain('secrets');
  });

  it('round-trips row CRUD via /api/tables/:table/rows', async () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const post = await fetch(`${server.url}/api/tables/teams/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New Team' }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };
    expect(typeof id).toBe('string');

    const got = (await fetch(`${server.url}/api/tables/teams/rows/${id}`).then((r) =>
      r.json(),
    )) as { id: string; name: string };
    expect(got.name).toBe('New Team');

    const list = (await fetch(`${server.url}/api/tables/teams/rows`).then((r) => r.json())) as {
      rows: { id: string }[];
    };
    expect(list.rows.some((r) => r.id === id)).toBe(true);

    const patch = await fetch(`${server.url}/api/tables/teams/rows/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(patch.status).toBe(200);

    const reread = (await fetch(`${server.url}/api/tables/teams/rows/${id}`).then((r) =>
      r.json(),
    )) as { name: string };
    expect(reread.name).toBe('Renamed');

    const del = await fetch(`${server.url}/api/tables/teams/rows/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const after = await fetch(`${server.url}/api/tables/teams/rows/${id}`);
    expect(after.status).toBe(404);
  });

  it('link / unlink junction rows via /api/tables/:table/(link|unlink)', async () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // Seed a row on each side via the CRUD route.
    const { id: agentId } = (await (
      await fetch(`${server.url}/api/tables/agents/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'gamma', name: 'Gamma' }),
      })
    ).json()) as { id: string };
    const { id: skillId } = (await (
      await fetch(`${server.url}/api/tables/skills/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'TypeScript' }),
      })
    ).json()) as { id: string };

    const link = await fetch(`${server.url}/api/tables/agent_skills/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, skill_id: skillId }),
    });
    expect(link.status).toBe(200);

    const linked = (await fetch(`${server.url}/api/tables/agent_skills/rows`).then((r) =>
      r.json(),
    )) as { rows: { agent_id: string; skill_id: string }[] };
    expect(linked.rows.some((r) => r.agent_id === agentId && r.skill_id === skillId)).toBe(true);

    const unlink = await fetch(`${server.url}/api/tables/agent_skills/unlink`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, skill_id: skillId }),
    });
    expect(unlink.status).toBe(200);

    const afterUnlink = (await fetch(`${server.url}/api/tables/agent_skills/rows`).then((r) =>
      r.json(),
    )) as { rows: { agent_id: string; skill_id: string }[] };
    expect(afterUnlink.rows.some((r) => r.agent_id === agentId && r.skill_id === skillId)).toBe(
      false,
    );
  });

  it('serves rendered context files for a row via /context', async () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // Insert an `agents` row whose slug matches the rendered alpha fixture.
    const { id } = (await (
      await fetch(`${server.url}/api/tables/agents/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'alpha', name: 'Alpha' }),
      })
    ).json()) as { id: string };

    const ctx = (await fetch(`${server.url}/api/tables/agents/rows/${id}/context`).then((r) =>
      r.json(),
    )) as { files: { name: string; path: string; content: string }[] };

    const agentFile = ctx.files.find((f) => f.name === 'AGENT.md');
    expect(agentFile?.content).toContain('Alpha');
    expect(agentFile?.path).toMatch(/^agents\/alpha\/AGENT\.md$/);
  });

  it('returns empty files for tables with no entityContext', async () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const { id } = (await (
      await fetch(`${server.url}/api/tables/tasks/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'do thing' }),
      })
    ).json()) as { id: string };

    const ctx = (await fetch(`${server.url}/api/tables/tasks/rows/${id}/context`).then((r) =>
      r.json(),
    )) as { files: unknown[] };
    expect(ctx.files).toEqual([]);
  });

  it('soft-deletes rows when the table has a deleted_at column', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeFixture(root);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // The agents table has no `deleted_at` column → hard delete fallback.
    // Add a soft-deletable table inline by inserting into one that has the
    // column. The writeFixture schema doesn't include deleted_at on any
    // table, so this test verifies the fallback path.
    const { id } = (await (
      await fetch(`${server.url}/api/tables/agents/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'soft-del', name: 'Soft Del' }),
      })
    ).json()) as { id: string };

    const del = await fetch(`${server.url}/api/tables/agents/rows/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    // Without deleted_at, the row is hard-deleted and gone.
    const after = await fetch(`${server.url}/api/tables/agents/rows/${id}`);
    expect(after.status).toBe(404);
  });

  it('lists, switches, and creates databases via /api/databases', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeFixture(root);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const list = (await fetch(`${server.url}/api/databases`).then((r) => r.json())) as {
      current: { path: string };
      configs: { path: string; name: string; active: boolean }[];
    };
    expect(list.current.path).toBe(configPath);
    expect(list.configs.some((c) => c.path === configPath && c.active)).toBe(true);

    const create = await fetch(`${server.url}/api/databases/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'scratch' }),
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as { path: string };
    expect(created.path).toMatch(/scratch\.config\.yml$/);

    // A new workspace starts with NO user entities (the example `items` seed
    // was removed in 1.16.3); only framework natives (files/secrets/notes) exist.
    const ents = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string }[];
    };
    expect(ents.tables.some((t) => t.name === 'items')).toBe(false);
    expect(ents.tables.some((t) => t.name === 'agents')).toBe(false);

    // Switch back to the original config.
    const back = await fetch(`${server.url}/api/databases/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: configPath }),
    });
    expect(back.status).toBe(200);

    const ents2 = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string }[];
    };
    expect(ents2.tables.some((t) => t.name === 'agents')).toBe(true);
  });

  it('persists per-entity icon overrides via /api/gui-meta', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeFixture(root);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const empty = (await fetch(`${server.url}/api/gui-meta`).then((r) => r.json())) as Record<
      string,
      { icon: string }
    >;
    expect(empty).toEqual({});

    const put = await fetch(`${server.url}/api/gui-meta/agents`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ icon: '🦄' }),
    });
    expect(put.status).toBe(200);

    const after = (await fetch(`${server.url}/api/gui-meta`).then((r) => r.json())) as Record<
      string,
      { icon: string }
    >;
    expect(after.agents?.icon).toBe('🦄');
  });

  it('records mutations to the audit log and supports undo / redo', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeFixture(root);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // Empty to start.
    const initial = (await fetch(`${server.url}/api/history`).then((r) => r.json())) as {
      entries: unknown[];
      canUndo: boolean;
      canRedo: boolean;
    };
    expect(initial.entries).toEqual([]);
    expect(initial.canUndo).toBe(false);

    // Insert a row -> audit entry.
    const { id } = (await (
      await fetch(`${server.url}/api/tables/agents/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'undoable', name: 'Undoable' }),
      })
    ).json()) as { id: string };

    const afterInsert = (await fetch(`${server.url}/api/history`).then((r) => r.json())) as {
      entries: { operation: string }[];
      canUndo: boolean;
    };
    expect(afterInsert.entries.length).toBe(1);
    expect(afterInsert.entries[0]?.operation).toBe('insert');
    expect(afterInsert.canUndo).toBe(true);

    // Undo -> row gone.
    const undo = await fetch(`${server.url}/api/history/undo`, { method: 'POST' });
    expect(undo.status).toBe(200);
    const gone = await fetch(`${server.url}/api/tables/agents/rows/${id}`);
    expect(gone.status).toBe(404);

    // Redo -> row back.
    const redo = await fetch(`${server.url}/api/history/redo`, { method: 'POST' });
    expect(redo.status).toBe(200);
    const back = await fetch(`${server.url}/api/tables/agents/rows/${id}`);
    expect(back.status).toBe(200);
  });

  it('renames entities, adds columns, and renames columns via /api/schema', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeFixture(root);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // Add a new column to `tasks`.
    const addCol = await fetch(`${server.url}/api/schema/entities/tasks/columns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'priority', type: 'integer' }),
    });
    expect(addCol.status).toBe(200);
    const ent1 = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string; columns: string[] }[];
    };
    expect(ent1.tables.find((t) => t.name === 'tasks')?.columns).toContain('priority');

    // Rename the column.
    const renameCol = await fetch(
      `${server.url}/api/schema/entities/tasks/columns/priority/rename`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'severity' }),
      },
    );
    expect(renameCol.status).toBe(200);
    const ent2 = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string; columns: string[] }[];
    };
    expect(ent2.tables.find((t) => t.name === 'tasks')?.columns).toContain('severity');
    expect(ent2.tables.find((t) => t.name === 'tasks')?.columns).not.toContain('priority');

    // Rename the entity.
    const renameEnt = await fetch(`${server.url}/api/schema/entities/tasks/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'jobs' }),
    });
    expect(renameEnt.status).toBe(200);
    const ent3 = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string }[];
    };
    expect(ent3.tables.some((t) => t.name === 'jobs')).toBe(true);
    expect(ent3.tables.some((t) => t.name === 'tasks')).toBe(false);
  });

  it('creates a new entity via /api/schema/entities', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeFixture(root);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const create = await fetch(`${server.url}/api/schema/entities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'widgets', icon: '🔩' }),
    });
    expect(create.status).toBe(200);

    const ents = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string; columns: string[] }[];
    };
    const widgets = ents.tables.find((t) => t.name === 'widgets');
    expect(widgets).toBeDefined();
    expect(widgets!.columns).toEqual(expect.arrayContaining(['id', 'name', 'deleted_at']));

    const icons = (await fetch(`${server.url}/api/gui-meta`).then((r) => r.json())) as Record<
      string,
      { icon: string }
    >;
    expect(icons.widgets?.icon).toBe('🔩');
  });

  it('persists and reads per-column secret flag', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeFixture(root);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const initial = (await fetch(`${server.url}/api/gui-meta/columns`).then((r) =>
      r.json(),
    )) as Record<string, Record<string, { secret: boolean }>>;
    expect(initial).toEqual({});

    const put = await fetch(`${server.url}/api/gui-meta/columns/agents/name`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: true }),
    });
    expect(put.status).toBe(200);

    const after = (await fetch(`${server.url}/api/gui-meta/columns`).then((r) =>
      r.json(),
    )) as Record<string, Record<string, { secret: boolean }>>;
    expect(after.agents?.name?.secret).toBe(true);

    // Toggle off.
    await fetch(`${server.url}/api/gui-meta/columns/agents/name`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: false }),
    });
    const finalState = (await fetch(`${server.url}/api/gui-meta/columns`).then((r) =>
      r.json(),
    )) as Record<string, Record<string, { secret: boolean }>>;
    expect(finalState.agents?.name?.secret).toBe(false);
  });

  it('filters history by table, including junctions that touch the filtered table', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeFixture(root);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const agentResp = (await (
      await fetch(`${server.url}/api/tables/agents/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'a1', name: 'Alpha One' }),
      })
    ).json()) as { id: string };
    const skillResp = (await (
      await fetch(`${server.url}/api/tables/skills/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'TS' }),
      })
    ).json()) as { id: string };
    await fetch(`${server.url}/api/tables/agent_skills/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentResp.id, skill_id: skillResp.id }),
    });

    const filtered = (await fetch(`${server.url}/api/history?table=agents`).then((r) =>
      r.json(),
    )) as { entries: { table_name: string; operation: string }[] };
    // The agents insert AND the agent_skills link should appear under agents.
    expect(
      filtered.entries.some((e) => e.table_name === 'agents' && e.operation === 'insert'),
    ).toBe(true);
    expect(
      filtered.entries.some((e) => e.table_name === 'agent_skills' && e.operation === 'link'),
    ).toBe(true);
    // The skills insert should NOT appear under agents.
    expect(filtered.entries.some((e) => e.table_name === 'skills')).toBe(false);

    // Filtering by skills should also show the junction link.
    const skillsFiltered = (await fetch(`${server.url}/api/history?table=skills`).then((r) =>
      r.json(),
    )) as { entries: { table_name: string; operation: string }[] };
    expect(
      skillsFiltered.entries.some((e) => e.table_name === 'agent_skills' && e.operation === 'link'),
    ).toBe(true);
  });

  it('rejects unknown tables and non-junctions for link/unlink', async () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const unknown = await fetch(`${server.url}/api/tables/nope/rows`);
    expect(unknown.status).toBe(400);

    // agents is a first-class table, not a junction.
    const wrongLink = await fetch(`${server.url}/api/tables/agents/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(wrongLink.status).toBe(400);
  });
});

describe('isJunctionTable', () => {
  it('classifies first-class entities and junctions correctly', () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const { tables } = getGuiEntities(configPath, outputDir);
    const byName = new Map(tables.map((t) => [t.name, t]));

    expect(isJunctionTable(byName.get('agents')!)).toBe(false);
    expect(isJunctionTable(byName.get('tasks')!)).toBe(false);
    expect(isJunctionTable(byName.get('teams')!)).toBe(false);
    expect(isJunctionTable(byName.get('skills')!)).toBe(false);
    expect(isJunctionTable(byName.get('agent_skills')!)).toBe(true);
  });

  it('is columns-aware: a 2-FK table with data columns is NOT a junction (data-loss regression)', () => {
    // Regression for the bug where a first-class entity with exactly two
    // foreign keys (e.g. `tasks` with assignee_id + articles_id + data
    // columns) was mis-classified as a junction, exposing a "Delete
    // relationship" → DROP TABLE path. A junction is ONLY id + 2 FKs (+ system
    // columns), nothing else.
    const fk = (table: string, foreignKey: string): BelongsToRelation => ({
      type: 'belongsTo',
      table,
      foreignKey,
    });
    const mk = (columns: string[], relations: Record<string, Relation>): GuiTableSummary => ({
      name: 'x',
      columns,
      outputFile: 'x.md',
      relations,
    });

    // Pure junction: id + exactly 2 FK columns → junction.
    expect(
      isJunctionTable(mk(['id', 'a_id', 'b_id'], { a: fk('a', 'a_id'), b: fk('b', 'b_id') })),
    ).toBe(true);
    // Pure junction + system columns only → still a junction.
    expect(
      isJunctionTable(
        mk(['id', 'a_id', 'b_id', 'created_at', 'updated_at', 'deleted_at'], {
          a: fk('a', 'a_id'),
          b: fk('b', 'b_id'),
        }),
      ),
    ).toBe(true);
    // Self-referential m2m (both FKs to the same table) → junction.
    expect(
      isJunctionTable(mk(['id', 'a_id', 'a_id_2'], { a: fk('a', 'a_id'), a2: fk('a', 'a_id_2') })),
    ).toBe(true);
    // THE BUG: 2 FKs + a real data column → first-class entity, NOT a junction.
    expect(
      isJunctionTable(
        mk(['id', 'assignee_id', 'articles_id', 'title', 'status', 'updated_at'], {
          assignee: fk('people', 'assignee_id'),
          articles: fk('articles', 'articles_id'),
        }),
      ),
    ).toBe(false);
    // Payload junction (a join row carrying its own scalar) → NOT a junction.
    expect(
      isJunctionTable(
        mk(['id', 'a_id', 'b_id', 'role'], { a: fk('a', 'a_id'), b: fk('b', 'b_id') }),
      ),
    ).toBe(false);
    // 1 FK and 3 FK are never junctions.
    expect(isJunctionTable(mk(['id', 'a_id'], { a: fk('a', 'a_id') }))).toBe(false);
    expect(
      isJunctionTable(
        mk(['id', 'a_id', 'b_id', 'c_id'], {
          a: fk('a', 'a_id'),
          b: fk('b', 'b_id'),
          c: fk('c', 'c_id'),
        }),
      ),
    ).toBe(false);
  });

  it('hides junction tables as nodes but keeps the many-to-many edge between objects', () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const graph = buildGuiGraph(configPath, outputDir);
    const nodeIds = graph.nodes.map((n) => n.id);

    // agent_skills is a junction (agents <-> skills) — no node for it.
    expect(nodeIds).not.toContain('table:agent_skills');
    expect(nodeIds).toContain('table:agents');
    expect(nodeIds).toContain('table:skills');

    // ...but the m2m relationship survives as an edge between the two objects.
    const m2m = graph.edges.find(
      (e) =>
        e.type === 'manyToMany' &&
        ((e.source === 'table:agents' && e.target === 'table:skills') ||
          (e.source === 'table:skills' && e.target === 'table:agents')),
    );
    expect(m2m).toBeTruthy();
    // No edge should dangle into the hidden junction node.
    expect(graph.edges.some((e) => e.target === 'table:agent_skills')).toBe(false);
  });
});

describe('GUI server — native entities + table allowlist', () => {
  it('makes native files/secrets queryable (regression: "Unknown table")', async () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    for (const table of ['files', 'secrets']) {
      const res = await fetch(`${server.url}/api/tables/${table}/rows`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: unknown[] };
      expect(Array.isArray(body.rows)).toBe(true);
    }

    // And a row round-trips through the native files table.
    const post = await fetch(`${server.url}/api/tables/files/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/x.md', kind: 'markdown' }),
    });
    expect(post.status).toBe(201);
  });

  it('marks native entities in the /api/entities payload', async () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const entities = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string; native?: boolean }[];
    };
    const byName = new Map(entities.tables.map((t) => [t.name, t]));
    expect(byName.get('files')?.native).toBe(true);
    expect(byName.get('secrets')?.native).toBe(true);
    expect(byName.get('agents')?.native).toBeFalsy();
  });

  it('exposes native-entity bindings via /api/native-entities', async () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const res = (await fetch(`${server.url}/api/native-entities`).then((r) => r.json())) as {
      bindings: { entity: string }[];
    };
    expect(res.bindings.map((b) => b.entity).sort()).toEqual([
      'chat_messages',
      'chat_threads',
      'files',
      'notes',
      'secrets',
    ]);
  });

  it('still refuses internal bookkeeping tables (security boundary)', async () => {
    const { configPath, outputDir } = writeFixture(tempDir());
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const res = await fetch(`${server.url}/api/tables/__lattice_migrations/rows`);
    expect(res.status).toBe(400);
  });
});
