import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guiAppHtml } from '../../src/gui/app.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import type { GuiTableSummary } from '../../src/gui/data.js';

/**
 * FILES is a first-class sidebar specialty section again.
 *
 * The lazy on-disk tree renderer (renderSourcesFilesInto) always existed, but its
 * mount point — the element with id `src-files-tree` — was dropped from the shell
 * when Files was demoted to an ordinary table, so the renderer had been a silent
 * no-op on every sidebar render. These tests pin the mount back in place, pin the
 * single add-files affordance, and pin the payload split: `notes` is dropped from
 * the entities payload entirely, while `files` stays in the payload (Data Model +
 * graph lineage) and is skipped only by the left-hand table nav.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-f5-'));
  dirs.push(dir);
  return dir;
}

/** A minimal, valid workspace to boot the GUI server against. */
function writeMinimalFixture(
  root: string,
  entityName = 'teams',
): { configPath: string; outputDir: string } {
  const outputDir = join(root, 'context');
  mkdirSync(outputDir, { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      `  ${entityName}:`,
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      name: { type: text }',
      '    render: default-list',
      `    outputFile: ${entityName}.md`,
      '',
    ].join('\n'),
    'utf8',
  );
  return { configPath, outputDir };
}

/** How many times `needle` occurs in the served document (shell + inline client). */
function occurrences(needle: string): number {
  return guiAppHtml.split(needle).length - 1;
}

describe('F-5 — the FILES sidebar section', () => {
  it('mounts the file tree, the add affordance and the reassurance note in the shell', () => {
    // The mount the tree renderer has been looking for.
    expect(guiAppHtml).toContain('id="src-files-tree"');
    // Same section idiom the DATA section uses, with its own collapse group.
    expect(guiAppHtml).toContain('data-section="files"');
    expect(guiAppHtml).toContain('data-group="nav-files"');
    expect(guiAppHtml).toContain('data-group-body="nav-files"');
    expect(guiAppHtml).toContain('<span class="section-label-text">Files</span>');
    // Source-root management lives in this section's add affordance.
    expect(guiAppHtml).toContain('id="src-add-files"');
    expect(guiAppHtml).toContain('id="src-add-files-menu"');
    expect(guiAppHtml).toContain('data-pick="file"');
    expect(guiAppHtml).toContain('data-pick="folder"');
    expect(guiAppHtml).toContain('Secured: files never leave your computer.');
  });

  it('leads the sidebar — FILES sits above the DATA section', () => {
    // On a fresh or file-driven workspace FILES is the only section with content,
    // so it comes first in the sidebar and is the default-open accordion section.
    const files = guiAppHtml.indexOf('data-section="files"');
    const data = guiAppHtml.indexOf('data-section="tables"');
    expect(files).toBeGreaterThan(-1);
    expect(data).toBeGreaterThan(-1);
    expect(files).toBeLessThan(data);
    expect(guiAppHtml).toContain(
      "var NAV_ACCORDION_GROUPS = ['nav-files', 'nav-tables', 'nav-dashboards']",
    );
  });

  it('has exactly ONE add-files button and ONE menu in the whole document', () => {
    // wireSourcesButtons() resolves both BY ID, so a second copy anywhere in the
    // document would silently be left unwired.
    expect(occurrences('id="src-add-files"')).toBe(1);
    expect(occurrences('id="src-add-files-menu"')).toBe(1);
  });

  it('retires the Configure -> Files tab entirely', () => {
    expect(guiAppHtml).not.toContain('data-tab="files"');
    expect(guiAppHtml).not.toContain('function renderFilesTab(');
    expect(guiAppHtml).not.toContain('inputs-files-tree');
    // …and the grid renderer that only ever served that tab.
    expect(guiAppHtml).not.toContain('function renderSourcesGridInto(');
    expect(guiAppHtml).not.toContain('function srcGridTile(');
  });

  it('uses the agreed empty-state copy and registers the collapse group', () => {
    expect(guiAppHtml).toContain('No files yet — add a file or folder to get started.');
    expect(guiAppHtml).toContain("'nav-dashboards', 'nav-tables', 'nav-files',");
  });

  it('reuses the existing tree renderer, lazy expand, de-dupe and remove flow', () => {
    // Restoration, not a rebuild — the renderer and its wiring are unchanged.
    expect(guiAppHtml).toContain(
      "renderSourcesFilesInto(document.getElementById('src-files-tree')",
    );
    expect(guiAppHtml).toContain('function toggleSourceFolder(');
    expect(guiAppHtml).toContain('function prepareSourcesData(');
    expect(guiAppHtml).toContain('function wireSourceRemoval(');
    // A leaf click opens the existing file record route.
    expect(guiAppHtml).toContain("location.hash = '#/fs/files/' + encodeURIComponent(id)");
  });

  it('skips nav-hidden tables in the left-hand table nav', () => {
    expect(guiAppHtml).toContain('t.linkTable || t.sqlDenied || t.navHidden');
  });
});

describe('F-5 — the entities payload split', () => {
  it('drops notes entirely, keeps files stamped nav-hidden, and leaves a fresh workspace with zero nav tables', async () => {
    const root = tempDir();
    const { configPath, outputDir } = writeMinimalFixture(root);
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    // A brand-new workspace: no user entities at all, only the framework natives.
    const create = await fetch(`${server.url}/api/databases/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'fresh' }),
    });
    expect(create.status).toBe(200);

    const payload = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: GuiTableSummary[];
    };
    const byName = new Map(payload.tables.map((t) => [t.name, t]));

    // HARD drop: notes is not in the payload at all.
    expect(byName.has('notes')).toBe(false);
    // SOFT hide: files IS in the payload (Data Model panel + brain graph read it)…
    expect(byName.has('files')).toBe(true);
    expect(byName.get('files')!.navHidden).toBe(true);
    // …and no other table is nav-hidden.
    expect(payload.tables.filter((t) => t.navHidden).map((t) => t.name)).toEqual(['files']);

    // The left nav renders ZERO table ENTRIES on a fresh workspace — every table
    // the payload still carries is excluded by one of the three nav stamps
    // (mirrors renderNavTables' filter in nav-sections.ts). The TABLES /
    // CONNECTORS / DATABASES subheads still render, each with its empty state +
    // add affordance (pinned in nav-empty-subheads.test.ts) — the section no
    // longer collapses to a single bare "No tables yet." line.
    const navVisible = payload.tables.filter((t) => !t.linkTable && !t.sqlDenied && !t.navHidden);
    expect(navVisible.map((t) => t.name)).toEqual([]);
  });

  it('never hides a table the workspace config declares itself', async () => {
    // The legacy drop targets the FRAMEWORK-shipped table. A workspace that
    // declares an entity of the same name owns it, and silently disappearing the
    // user's own table would be data loss from their point of view.
    const root = tempDir();
    const { configPath, outputDir } = writeMinimalFixture(root, 'notes');
    const server = await startGuiServer({ configPath, outputDir, port: 0, openBrowser: false });
    servers.push(server);

    const payload = (await fetch(`${server.url}/api/entities`).then((r) => r.json())) as {
      tables: GuiTableSummary[];
    };
    const notes = payload.tables.find((t) => t.name === 'notes');
    expect(notes).toBeDefined();
    expect(notes!.navHidden).toBeUndefined();
  });
});
