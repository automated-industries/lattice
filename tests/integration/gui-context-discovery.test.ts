import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { writeManifest } from '../../src/lifecycle/manifest.js';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-ctx-disc-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a YAML config that declares an `items` table but **no** entityContexts.
 * The manifest will be written separately to simulate the scenario where a
 * project registers entity contexts programmatically (in `lattice.schema.mjs`)
 * and renders via that module — the GUI process never imports the module,
 * so it has to fall back to the manifest on disk.
 */
function writeMinimalConfig(root: string): {
  configPath: string;
  outputDir: string;
  dbPath: string;
} {
  const outputDir = join(root, 'context');
  mkdirSync(outputDir, { recursive: true });
  const dbPath = join(root, 'data', 'test.db');
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  items:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      slug: { type: text }',
      '      name: { type: text }',
      '    render: default-list',
      '    outputFile: items.md',
    ].join('\n'),
  );
  return { configPath, outputDir, dbPath };
}

describe('GUI row-context discovery — manifest fallback', () => {
  it('serves rendered files when a manifest names the entity, even with no YAML entityContext', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeMinimalConfig(root);

    // Pre-render files for slug "alpha" in the project root area the
    // manifest declares. This simulates `lattice render` running with a
    // programmatic entity-context registration.
    mkdirSync(join(outputDir, 'items', 'alpha'), { recursive: true });
    writeFileSync(
      join(outputDir, 'items', 'alpha', 'ITEM.md'),
      '# Alpha\n\nrendered before the GUI opened',
    );
    writeFileSync(join(outputDir, 'items', 'alpha', 'NOTES.md'), 'some notes for alpha');

    writeManifest(outputDir, {
      version: 2,
      generated_at: '2026-05-26T00:00:00.000Z',
      entityContexts: {
        items: {
          directoryRoot: 'items',
          declaredFiles: ['ITEM.md', 'NOTES.md'],
          protectedFiles: [],
          entities: {
            alpha: {
              'ITEM.md': { hash: 'h1' },
              'NOTES.md': { hash: 'h2' },
            },
          },
        },
      },
    });

    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // Insert a row whose `slug` matches the manifest entry — the manifest-
    // fallback path derives the slug from the row's `slug` field.
    const { id } = (await (
      await fetch(`${server.url}/api/tables/items/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'alpha', name: 'Alpha' }),
      })
    ).json()) as { id: string };

    const ctx = (await fetch(`${server.url}/api/tables/items/rows/${id}/context`).then((r) =>
      r.json(),
    )) as { files: { name: string; path: string; content: string }[] };

    const fileNames = ctx.files.map((f) => f.name);
    expect(fileNames).toContain('ITEM.md');
    expect(fileNames).toContain('NOTES.md');

    const itemFile = ctx.files.find((f) => f.name === 'ITEM.md');
    expect(itemFile?.content).toContain('rendered before the GUI opened');
    expect(itemFile?.path).toMatch(/^items[\\/]alpha[\\/]ITEM\.md$/);
  });

  it('falls back to row.name when row.slug is absent but row.name matches a manifest entry', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeMinimalConfig(root);

    mkdirSync(join(outputDir, 'items', 'beta-by-name'), { recursive: true });
    writeFileSync(
      join(outputDir, 'items', 'beta-by-name', 'ITEM.md'),
      '# Beta (matched by name)',
    );

    writeManifest(outputDir, {
      version: 2,
      generated_at: '2026-05-26T00:00:00.000Z',
      entityContexts: {
        items: {
          directoryRoot: 'items',
          declaredFiles: ['ITEM.md'],
          protectedFiles: [],
          entities: {
            'beta-by-name': { 'ITEM.md': { hash: 'h' } },
          },
        },
      },
    });

    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // No slug — only a name that matches.
    const { id } = (await (
      await fetch(`${server.url}/api/tables/items/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'beta-by-name' }),
      })
    ).json()) as { id: string };

    const ctx = (await fetch(`${server.url}/api/tables/items/rows/${id}/context`).then((r) =>
      r.json(),
    )) as { files: { name: string; content: string }[] };

    expect(ctx.files.find((f) => f.name === 'ITEM.md')?.content).toContain('matched by name');
  });

  it('returns empty files when no row field matches any manifest slug', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeMinimalConfig(root);

    writeManifest(outputDir, {
      version: 2,
      generated_at: '2026-05-26T00:00:00.000Z',
      entityContexts: {
        items: {
          directoryRoot: 'items',
          declaredFiles: ['ITEM.md'],
          protectedFiles: [],
          entities: {
            // Only a slug the new row won't match.
            'gamma-no-match': { 'ITEM.md': { hash: 'h' } },
          },
        },
      },
    });

    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const { id } = (await (
      await fetch(`${server.url}/api/tables/items/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'nonexistent', name: 'Other' }),
      })
    ).json()) as { id: string };

    const ctx = (await fetch(`${server.url}/api/tables/items/rows/${id}/context`).then((r) =>
      r.json(),
    )) as { files: unknown[] };
    expect(ctx.files).toEqual([]);
  });

  it('exposes Lattice.entityContexts() — covers both YAML and programmatic registrations', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeMinimalConfig(root);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // We don't have a direct API endpoint that exposes the entity context
    // map, but the integration is exercised by the row-context endpoint
    // returning a non-empty list when an entityContext is registered.
    // Verify the public accessor is available on the Lattice instance for
    // library consumers via a quick smoke check.
    const { Lattice } = await import('../../src/lattice.js');
    const db = new Lattice({ config: configPath });
    db.defineEntityContext('items', {
      slug: (row) => String(row.slug ?? row.id),
      files: {
        'ITEM.md': { source: { type: 'self' }, render: (rows) => `# ${String(rows[0]?.name)}` },
      },
    });
    await db.init();
    const ctxs = db.entityContexts();
    expect(ctxs.has('items')).toBe(true);
    db.close();
  });
});

describe('discoverOutputDir CLI helper', () => {
  it('honours an explicit --output even when no manifest is present', async () => {
    const { discoverOutputDir } = await import('../../src/gui/discover-output-dir.js');
    expect(discoverOutputDir('./custom', true)).toBe('./custom');
  });

  it('returns the default when no candidate has a manifest', async () => {
    const root = tempDir();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const { discoverOutputDir } = await import('../../src/gui/discover-output-dir.js');
      expect(discoverOutputDir('./context', false)).toBe('./context');
    } finally {
      process.chdir(cwd);
    }
  });

  it('picks the project root when only `./.lattice/manifest.json` exists', async () => {
    const root = tempDir();
    mkdirSync(join(root, '.lattice'), { recursive: true });
    writeFileSync(join(root, '.lattice', 'manifest.json'), '{}');
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const { discoverOutputDir } = await import('../../src/gui/discover-output-dir.js');
      expect(discoverOutputDir('./context', false)).toBe('.');
    } finally {
      process.chdir(cwd);
    }
  });
});
