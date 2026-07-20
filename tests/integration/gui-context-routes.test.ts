import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

// The Outputs > Markdown panel reads the rendered context tree through two new
// read-only routes. These assert the tree lists entity .md files + per-entity
// directories (skipping internal dot-dirs), that a single file reads back, and
// that the path-containment guard rejects traversal — the same guard the
// /gui-assets route uses.

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function bootWithContext() {
  const root = mkdtempSync(join(tmpdir(), 'lattice-ctx-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  tasks:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      // The table rollup lives under `.schema-only/` — the location every GUI table
      // writer defaults to (a hidden home so it doesn't clutter the Context root).
      '    outputFile: .schema-only/tasks.md',
      '',
    ].join('\n'),
  );
  const outputDir = join(root, 'context');
  // Seed a rendered context tree: a per-entity dir with a row .md, an internal
  // dot-dir that must NOT appear in the tree, and a root-level `TASKS.md` that no
  // table claims (its rollup is `.schema-only/tasks.md`) so it trails as a stray.
  mkdirSync(join(outputDir, 'Tasks'), { recursive: true });
  mkdirSync(join(outputDir, '.lattice'), { recursive: true });
  writeFileSync(join(outputDir, 'TASKS.md'), '# Tasks\n\nThe tasks entity.\n');
  writeFileSync(join(outputDir, 'Tasks', 'task-1.md'), '# Task 1\n\nA single task.\n');
  writeFileSync(join(outputDir, '.lattice', 'manifest.json'), '{}');

  const s = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
  servers.push(s);
  return { s, outputDir };
}

const getJson = async (s: GuiServerHandle, path: string) => {
  const r = await fetch(`${s.url}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

type TreeEntry = { name: string; path: string; kind: string };

describe('GET /api/context/tree (typed table nodes)', () => {
  it('returns one node per table (same set as the Tables mirror) + ungrouped strays', async () => {
    const { s } = await bootWithContext();
    const { status, body } = await getJson(s, '/api/context/tree');
    expect(status).toBe(200);
    const tables = body.tables as { table: string; kind: string; tier: string; dir?: string }[];
    const tasks = tables.find((t) => t.table === 'tasks');
    expect(tasks).toBeDefined();
    expect(tasks?.kind).toBe('table');
    expect(typeof tasks?.tier).toBe('string');
    // Internal dot-dirs never appear anywhere in the payload.
    const ungrouped = body.ungrouped as TreeEntry[];
    expect(ungrouped.map((e) => e.name)).not.toContain('.lattice');
    // A root file no table claims trails as an ungrouped stray.
    expect(ungrouped.map((e) => e.name)).toContain('TASKS.md');
  });

  it('table-scoped list returns the rollup + per-record folders', async () => {
    const { s } = await bootWithContext();
    const { status, body } = await getJson(s, '/api/context/list?table=tasks');
    expect(status).toBe(200);
    const entries = body.entries as TreeEntry[];
    // The per-record dir listing comes from the table's directory root.
    expect(entries.some((e) => e.path.startsWith('Tasks/'))).toBe(true);
  });
});

describe('GET /api/context/list (lazy folder expand)', () => {
  it("lists a folder's immediate children", async () => {
    const { s } = await bootWithContext();
    const { status, body } = await getJson(
      s,
      '/api/context/list?path=' + encodeURIComponent('Tasks'),
    );
    expect(status).toBe(200);
    expect((body.entries as TreeEntry[]).map((e) => e.path)).toContain('Tasks/task-1.md');
  });

  it('404s an unknown folder and rejects path traversal', async () => {
    const { s } = await bootWithContext();
    expect((await getJson(s, '/api/context/list?path=' + encodeURIComponent('nope'))).status).toBe(
      404,
    );
    expect(
      (await getJson(s, '/api/context/list?path=' + encodeURIComponent('../../..'))).status,
    ).toBe(404);
  });
});

describe('GET /api/context/resolve', () => {
  // The Outputs tree click resolves a rendered .md to the record (or table) it
  // belongs to — the record page is the single markdown surface (the old
  // read-only /api/context/file viewer is gone).
  it('resolves a per-record file to {record, table, rowId} via its frontmatter', async () => {
    const { s, outputDir } = await bootWithContext();
    mkdirSync(join(outputDir, 'Tasks', 'my-task'), { recursive: true });
    writeFileSync(
      join(outputDir, 'Tasks', 'my-task', 'TASK.md'),
      '---\ngenerated_at: "2026-07-03T00:00:00.000Z"\ntasks_id: "row-42"\n---\n\n# My task\n',
    );
    const { status, body } = await getJson(
      s,
      '/api/context/resolve?path=' + encodeURIComponent('Tasks/my-task/TASK.md'),
    );
    expect(status).toBe(200);
    expect(body.kind).toBe('record');
    expect(body.table).toBe('tasks');
    expect(body.rowId).toBe('row-42');
  });

  it('resolves a table ROLLUP .md to {table, content} — clicking it shows markdown', async () => {
    const { s, outputDir } = await bootWithContext();
    // The tasks table's rollup (config outputFile) with real content on disk.
    writeFileSync(join(outputDir, 'TASKS.md'), '# Tasks\n\n- one\n- two\n');
    const r = await getJson(
      s,
      '/api/context/resolve?content=1&path=' + encodeURIComponent('TASKS.md'),
    );
    // TASKS.md is a stray here (the config outputFile is `.schema-only/tasks.md`),
    // so this asserts the stray path; the rollup-with-content path is exercised
    // by the `.schema-only/` rollup below.
    expect(r.status).toBe(200);
  });

  it('resolves a table rollup to {table, content} + lists it (the "no rendered markdown" bug)', async () => {
    const { s, outputDir } = await bootWithContext();
    // The tasks rollup lives at its configured `.schema-only/tasks.md`. A table
    // whose rollup exists must resolve to its content — the collection Markdown
    // view showed "no rendered markdown yet" because a table's rollup wasn't being
    // resolved.
    mkdirSync(join(outputDir, '.schema-only'), { recursive: true });
    writeFileSync(join(outputDir, '.schema-only', 'tasks.md'), '# Tasks rollup\n\n- a\n- b\n');
    const r = await getJson(
      s,
      '/api/context/resolve?content=1&path=' + encodeURIComponent('.schema-only/tasks.md'),
    );
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('table');
    expect(r.body.table).toBe('tasks');
    expect(String(r.body.content)).toContain('Tasks rollup');
    // The table-scoped list returns the rollup as a file entry too, so the
    // collection Markdown view can find + render it.
    const list = await getJson(s, '/api/context/list?table=tasks');
    const files = (list.body.entries as { name: string; kind: string }[]).filter(
      (e) => e.kind === 'file',
    );
    expect(files.some((f) => f.name === 'tasks.md')).toBe(true);
  });

  it('resolves a stray user file to {none} (inert)', async () => {
    const { s } = await bootWithContext();
    const { status, body } = await getJson(
      s,
      '/api/context/resolve?path=' + encodeURIComponent('TASKS.md'),
    );
    expect(status).toBe(200);
    expect(body.kind).toBe('none');
  });

  it('?content=1 returns the text for CLAIMED artifacts only (rollups/records; strays get none)', async () => {
    const { s, outputDir } = await bootWithContext();
    mkdirSync(join(outputDir, 'Tasks', 'ct'), { recursive: true });
    writeFileSync(
      join(outputDir, 'Tasks', 'ct', 'TASK.md'),
      '---\ntasks_id: "r9"\n---\n\n# CT\n\n- **title:** hello-content\n',
    );
    const rec = await getJson(
      s,
      '/api/context/resolve?content=1&path=' + encodeURIComponent('Tasks/ct/TASK.md'),
    );
    expect(rec.status).toBe(200);
    expect(rec.body.kind).toBe('record');
    expect(String(rec.body.content)).toContain('hello-content');
    // A stray user file never returns content.
    const stray = await getJson(
      s,
      '/api/context/resolve?content=1&path=' + encodeURIComponent('TASKS.md'),
    );
    expect(stray.body.kind).toBe('none');
    expect(stray.body.content).toBeUndefined();
  });

  it('rejects path traversal out of the output dir (containment guard)', async () => {
    const { s } = await bootWithContext();
    const { status } = await getJson(
      s,
      '/api/context/resolve?path=' + encodeURIComponent('../../../../etc/passwd'),
    );
    expect(status).toBe(404);
  });

  it('rejects a non-.md path', async () => {
    const { s } = await bootWithContext();
    const { status } = await getJson(
      s,
      '/api/context/resolve?path=' + encodeURIComponent('.lattice/manifest.json'),
    );
    expect(status).toBe(404);
  });
});

describe('GET /api/tables/:table/rows/:id/context (source metadata)', () => {
  it('returns source metadata {type, table, count} for related rollup files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lattice-ctx-src-'));
    dirs.push(root);
    mkdirSync(join(root, 'data'), { recursive: true });
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
        '      name: { type: text }',
        '    outputFile: agents.md',
        '  tasks:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      title: { type: text }',
        '      agent_id: { type: uuid }',
        '    relations:',
        '      agent: { type: belongsTo, table: agents, foreignKey: agent_id }',
        '    outputFile: tasks.md',
        '',
        // Source metadata requires entity-context definitions: plain `--config`
        // serving without them is manifest-only, where `source` is (by design)
        // omitted — see the unit coverage of buildRowContextLocator for that path.
        'entityContexts:',
        '  agents:',
        '    slug: "{{id}}"',
        '    directoryRoot: Agents',
        '    files:',
        '      AGENT.md:',
        '        source: self',
        '        template: default-detail',
        '      TASKS.md:',
        '        source: { type: hasMany, table: tasks, foreignKey: agent_id }',
        '        template: default-list',
        '  tasks:',
        '    slug: "{{id}}"',
        '    directoryRoot: Tasks',
        '    files:',
        '      TASK.md:',
        '        source: self',
        '        template: default-detail',
        '      AGENTS.md:',
        '        source: { type: belongsTo, table: agents, foreignKey: agent_id }',
        '        template: default-list',
        '',
      ].join('\n'),
    );
    const outputDir = join(root, 'context');
    // No pre-rendered files: source metadata rides the locator, so unrendered
    // files still carry it (content arrives on the next render).
    mkdirSync(outputDir, { recursive: true });

    const s = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(s);

    // One agent with two tasks pointing at it.
    const post = async (path: string, body: unknown): Promise<{ id: string }> => {
      const r = await fetch(`${s.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await r.json()) as { id: string };
    };
    const agent = await post('/api/tables/agents/rows', { name: 'Alpha' });
    const task = await post('/api/tables/tasks/rows', { title: 'Task 1', agent_id: agent.id });
    await post('/api/tables/tasks/rows', { title: 'Task 2', agent_id: agent.id });

    type CtxFiles = { name: string; source?: { type: string; table?: string; count?: number } }[];
    const filesOf = async (table: string, id: string): Promise<CtxFiles> => {
      const ctx = await fetch(`${s.url}/api/tables/${table}/rows/${id}/context`);
      return ((await ctx.json()) as { files: CtxFiles }).files;
    };

    // Task row: self file carries {type:'self'}; belongsTo file names its table
    // and counts the populated FK (1).
    const taskFiles = await filesOf('tasks', task.id);
    expect(taskFiles.find((f) => f.name === 'TASK.md')?.source).toEqual({ type: 'self' });
    const agentsFile = taskFiles.find((f) => f.name === 'AGENTS.md');
    expect(agentsFile?.source?.type).toBe('belongsTo');
    expect(agentsFile?.source?.table).toBe('agents');
    expect(agentsFile?.source?.count).toBe(1);

    // Agent row: hasMany file counts the two tasks via a bounded SQL COUNT.
    const agentFiles = await filesOf('agents', agent.id);
    const tasksFile = agentFiles.find((f) => f.name === 'TASKS.md');
    expect(tasksFile?.source?.type).toBe('hasMany');
    expect(tasksFile?.source?.table).toBe('tasks');
    expect(tasksFile?.source?.count).toBe(2);
  });
});

describe('GET /api/context/tree (junction filtering)', () => {
  // Regression: the Markdown panel used to list a "Files_<entity>" (link table)
  // folder for every relation alongside the real entity — pure noise that read as
  // "duplicates leaking in". The tree must hide junction (2-belongsTo) tables, the
  // same way the brain graph renders them as edges rather than nodes.
  it('hides junction (link) tables, listing only real entities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lattice-ctx-jx-'));
    dirs.push(root);
    mkdirSync(join(root, 'data'), { recursive: true });
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  tasks:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      title: { type: text }',
        '    outputFile: tasks.md',
        '  projects:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '    outputFile: projects.md',
        // A pure link table (two belongsTo, no payload) → classified as a junction.
        '  tasks_projects:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      task_id: { type: uuid }',
        '      project_id: { type: uuid }',
        '    relations:',
        '      task: { type: belongsTo, table: tasks, foreignKey: task_id }',
        '      project: { type: belongsTo, table: projects, foreignKey: project_id }',
        '    outputFile: tasks_projects.md',
        '',
      ].join('\n'),
    );
    const outputDir = join(root, 'context');
    // Render dirs for both real entities AND the junction; only the junction folder
    // should be filtered from the tree.
    mkdirSync(join(outputDir, 'Tasks'), { recursive: true });
    mkdirSync(join(outputDir, 'Projects'), { recursive: true });
    mkdirSync(join(outputDir, 'Tasks_projects'), { recursive: true });
    writeFileSync(join(outputDir, 'TASKS.md'), '# Tasks\n');
    const s = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(s);
    const { status, body } = await getJson(s, '/api/context/tree');
    expect(status).toBe(200);
    const tableNames = (body.tables as { table: string }[]).map((t) => t.table);
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('projects');
    expect(tableNames).not.toContain('tasks_projects'); // junction hidden
    // …and its rendered DIR never leaks in through the ungrouped strays either.
    expect((body.ungrouped as TreeEntry[]).map((e) => e.name)).not.toContain('Tasks_projects');
  });

  it('hides a physical link table with no declared relations (AI-built files_<entity>)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lattice-ctx-jx2-'));
    dirs.push(root);
    mkdirSync(join(root, 'data'), { recursive: true });
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  documents:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      title: { type: text }',
        '    outputFile: documents.md',
        // A files_<entity> link table with NO belongsTo relations and a display
        // "name" column — must still be hidden (column-shape detection).
        '  files_documents:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      file_id: { type: uuid }',
        '      documents_id: { type: uuid }',
        '    outputFile: files_documents.md',
        '',
      ].join('\n'),
    );
    const outputDir = join(root, 'context');
    mkdirSync(join(outputDir, 'Documents'), { recursive: true });
    mkdirSync(join(outputDir, 'Files_documents'), { recursive: true });
    const s = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(s);
    const { status, body } = await getJson(s, '/api/context/tree');
    expect(status).toBe(200);
    const tableNames = (body.tables as { table: string }[]).map((t) => t.table);
    expect(tableNames).toContain('documents');
    expect(tableNames).not.toContain('files_documents'); // physical link table hidden
    expect((body.ungrouped as TreeEntry[]).map((e) => e.name)).not.toContain('Files_documents');
  });
});
