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
      '    outputFile: tasks.md',
      '',
    ].join('\n'),
  );
  const outputDir = join(root, 'context');
  // Seed a rendered context tree: a top-level entity .md, a per-entity dir with a
  // row .md, and an internal dot-dir that must NOT appear in the tree.
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

  it('resolves a stray user file to {none} (inert)', async () => {
    const { s } = await bootWithContext();
    const { status, body } = await getJson(
      s,
      '/api/context/resolve?path=' + encodeURIComponent('TASKS.md'),
    );
    expect(status).toBe(200);
    expect(body.kind).toBe('none');
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
