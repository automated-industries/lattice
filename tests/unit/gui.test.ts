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
      entities: unknown[];
    };
    const graph = (await fetch(`${server.url}/api/graph`).then((r) => r.json())) as {
      nodes: unknown[];
      edges: unknown[];
    };

    expect(project.tableCount).toBeGreaterThan(0);
    expect(entities.entities.length).toBeGreaterThan(0);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
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
