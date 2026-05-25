import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGuiGraph, getGuiEntities, isJunctionTable } from '../../src/gui/data.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
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
      nodes: unknown[];
      edges: unknown[];
    };

    expect(project.tableCount).toBeGreaterThan(0);
    expect(entities.tables.every((t) => typeof t.rowCount === 'number')).toBe(true);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
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

    // The new DB has the default `items` schema, not `agents` — verify.
    const ents = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: { name: string }[];
    };
    expect(ents.tables.some((t) => t.name === 'items')).toBe(true);
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
});
