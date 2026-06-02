import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * 1.16.3 GUI bundle assertions (cloud-as-team reframe + polish). These verify
 * the served single-file bundle ships the new markup/strings; behavioral paths
 * (post-delete nav, inline create round-trip, share persistence) are covered by
 * the Playwright e2e + the PG-gated team tests.
 *
 *  A — inline create view (route #/fs/<t>/new), modal retired.
 *  C — Workspace Settings (Lattice Settings list) has no Action column / Delete.
 *  E/K — "team" wording stripped; "Workspace" nomenclature; share controls reworded.
 *  G — data-model graph carries share-status classes + a legend.
 *  H — generic empty-state copy (not the "edit lattice.config.yml" nag).
 *  I — member list renders pending invitations.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-1163-'));
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
  const s = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    openBrowser: false,
  });
  servers.push(s);
  return s;
}

describe('1.16.3 — served bundle ships the reframe + polish', () => {
  it('A: inline create view, no modal', async () => {
    const html = await (await fetch(`${(await boot()).url}/`)).text();
    expect(html).toContain('renderFsCreate');
    expect(html).toContain('fs-create-form');
    expect(html).toContain('fs-create-save');
    expect(html).toContain('fs-create-cancel');
    expect(html).not.toContain('openFsCreateModal');
  });

  it('C: Workspace Settings list has no Action column / per-row delete', async () => {
    const html = await (await fetch(`${(await boot()).url}/`)).text();
    // The lattice-settings db list lost its delete wiring + Action column.
    expect(html).not.toContain('data-delete-path');
  });

  it('K: "Workspace" nomenclature in rendered labels', async () => {
    const html = await (await fetch(`${(await boot()).url}/`)).text();
    expect(html).toContain('New workspace');
    expect(html).toContain('Workspace Settings');
    expect(html).toContain('Delete workspace');
    // The inner Database connection box keeps "Database" (it literally is the
    // DB connection — the user explicitly asked to keep that phrasing).
    expect(html).toContain('Database name');
    expect(html).not.toContain('New Database');
  });

  it('E: user-facing "team" wording is gone from the cloud controls', async () => {
    const html = await (await fetch(`${(await boot()).url}/`)).text();
    // Reworded controls.
    expect(html).toContain('Leave workspace');
    expect(html).toContain('Join workspace');
    expect(html).toContain('Share with workspace');
    expect(html).toContain('Cloud sharing');
    // The deprecated upgrade-to-team affordance is gone entirely.
    expect(html).not.toContain('Upgrade to team cloud');
    expect(html).not.toContain('open-upgrade');
    // Old wording retired.
    expect(html).not.toContain('Leave team');
    expect(html).not.toContain('Share with team');
  });

  it('G: data-model graph carries share-status classes + legend', async () => {
    const html = await (await fetch(`${(await boot()).url}/`)).text();
    expect(html).toContain('gnode-shared');
    expect(html).toContain('gnode-private');
    expect(html).toContain('cloudWorkspace');
    // Legend swatches.
    expect(html).toContain('sw-shared');
    expect(html).toContain('sw-private');
    expect(html).toContain('sw-selected');
  });

  it('H: generic empty-state copy (no lattice.config.yml nag in the dashboard)', async () => {
    const html = await (await fetch(`${(await boot()).url}/`)).text();
    expect(html).toContain('This workspace is empty');
  });

  it('I: member list renders pending invitations', async () => {
    const html = await (await fetch(`${(await boot()).url}/`)).text();
    expect(html).toContain('Pending invitations');
    expect(html).toContain('member-row-pending');
    expect(html).toContain("'/api/teams-gui/teams/' + teamId + '/invitations'");
  });
});
