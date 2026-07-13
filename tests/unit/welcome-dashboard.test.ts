import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { appJs } from '../../src/gui/app/script.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import {
  seedWelcomeDashboard,
  welcomeDashboardHtml,
  welcomeDashboardSpec,
  WELCOME_DASHBOARD_ID,
  WELCOME_DASHBOARD_TITLE,
} from '../../src/gui/welcome-dashboard.js';

describe('Welcome onboarding dashboard seed', () => {
  let tmpDir: string;
  let db: Lattice;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-welcome-'));
    db = new Lattice(join(tmpDir, 'test.db'), { encryptionKey: 'welcome-test-key' });
    registerNativeEntities(db);
    await db.init();
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeds one Welcome dashboard row with the stable id, title, html, and spec', async () => {
    await seedWelcomeDashboard(db);
    const row = (await db.get('dashboards', WELCOME_DASHBOARD_ID)) as Record<
      string,
      unknown
    > | null;
    expect(row).toBeTruthy();
    expect(row?.title).toBe(WELCOME_DASHBOARD_TITLE);
    // The redundant "Welcome to Lattice!" heading was removed from the HTML — the tab
    // title already carries it (the template renders full width without it).
    expect(String(row?.html)).not.toContain('<h1>Welcome to Lattice!</h1>');
    expect(String(row?.html)).not.toContain('max-width: 860px');
    expect(String(row?.html)).toContain('Ask your company anything');
    expect(String(row?.html)).toContain('Things you can do with Lattice');
    // The assistant works from `spec`, never the executable `html`.
    expect(String(row?.spec)).toContain('onboarding');
  });

  it('is idempotent — seeding twice keeps exactly one Welcome row (sentinel-gated)', async () => {
    await seedWelcomeDashboard(db);
    await seedWelcomeDashboard(db);
    const rows = (await db.query('dashboards', {
      where: { id: WELCOME_DASHBOARD_ID },
    })) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('does NOT resurrect the dashboard after the user deletes it (seed-once, not always-on)', async () => {
    await seedWelcomeDashboard(db);
    await db.delete('dashboards', WELCOME_DASHBOARD_ID);
    // A later workspace open re-runs the seed — the sentinel is already stamped, so
    // the row stays gone rather than reappearing every open.
    await seedWelcomeDashboard(db);
    const row = await db.get('dashboards', WELCOME_DASHBOARD_ID);
    expect(row).toBeFalsy();
  });

  it('seeds nothing (no throw) when the dashboards table is absent', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'lattice-welcome-bare-'));
    // A Lattice with NO native entities registered → no `dashboards` table.
    const bare = new Lattice(join(bareDir, 'bare.db'), { encryptionKey: 'k' });
    await bare.init();
    await expect(seedWelcomeDashboard(bare)).resolves.toBeUndefined();
    bare.close();
    rmSync(bareDir, { recursive: true, force: true });
  });

  it('the page buttons use the navigation-only host bridge, not host-navigating links', () => {
    const html = welcomeDashboardHtml();
    // Buttons route through window.lattice.act(...) (a sandboxed null-origin iframe
    // cannot navigate the host app with a plain link).
    expect(html).toContain('lattice.act');
    expect(html).toContain('data-act="add-file"');
    expect(html).toContain('data-act="add-connector"');
    expect(html).toContain('data-act="add-database"');
    expect(html).toContain('data-act="configure"');
    expect(html).toContain('data-ask=');
    // No attempt to top-navigate out of the sandbox.
    expect(html).not.toContain('target="_top"');
    expect(welcomeDashboardSpec()).toContain('Welcome to Lattice');
  });
});

describe('dashboard host-action bridge (navigation only)', () => {
  it('the iframe bridge exposes act(), and the host handler is a navigation-only whitelist', () => {
    // The iframe-side bridge adds a fire-and-forget act() alongside the read-only
    // data ops (query/get/sql/search).
    expect(appJs).toContain('act:function(name,arg)');
    // The parent-side broker routes op:"act" to a whitelist handler and returns —
    // it never runs a data fetch for an action message.
    expect(appJs).toContain("if (d.op === 'act')");
    expect(appJs).toContain('function __latticeDashboardAction(');
    // Whitelisted navigation intents only.
    expect(appJs).toContain("name === 'configure'");
    expect(appJs).toContain("name === 'ask'");
    expect(appJs).toContain('src-add-files');
    // The action path must NOT read/write data — no query/get/sql wiring inside it.
    const start = appJs.indexOf('function __latticeDashboardAction(');
    const body = appJs.slice(start, start + 900);
    expect(body).not.toContain('fetch(');
    expect(body).not.toContain('__lreq');
  });
});
