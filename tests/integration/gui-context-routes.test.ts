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

describe('GET /api/context/tree', () => {
  it('lists entity .md files + per-entity dirs and skips internal dot-dirs', async () => {
    const { s } = await bootWithContext();
    const { status, body } = await getJson(s, '/api/context/tree');
    expect(status).toBe(200);
    const entries = body.entries as {
      name: string;
      path: string;
      kind: string;
      children?: { name: string; path: string }[];
    }[];
    const names = entries.map((e) => e.name);
    expect(names).toContain('TASKS.md');
    expect(names).toContain('Tasks');
    // Internal dot-dir is excluded.
    expect(names).not.toContain('.lattice');
    const tasksDir = entries.find((e) => e.name === 'Tasks');
    expect(tasksDir?.kind).toBe('dir');
    expect((tasksDir?.children ?? []).map((c) => c.path)).toContain('Tasks/task-1.md');
  });
});

describe('GET /api/context/file', () => {
  it('reads a single context .md by relative path', async () => {
    const { s } = await bootWithContext();
    const { status, body } = await getJson(
      s,
      '/api/context/file?path=' + encodeURIComponent('Tasks/task-1.md'),
    );
    expect(status).toBe(200);
    expect(body.name).toBe('task-1.md');
    expect(String(body.content)).toContain('A single task.');
  });

  it('rejects path traversal out of the output dir (containment guard)', async () => {
    const { s } = await bootWithContext();
    const { status } = await getJson(
      s,
      '/api/context/file?path=' + encodeURIComponent('../../../../etc/passwd'),
    );
    expect(status).toBe(404);
  });

  it('rejects a non-.md path', async () => {
    const { s } = await bootWithContext();
    const { status } = await getJson(
      s,
      '/api/context/file?path=' + encodeURIComponent('.lattice/manifest.json'),
    );
    expect(status).toBe(404);
  });
});
