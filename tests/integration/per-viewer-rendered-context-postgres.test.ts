/**
 * WS8b — per-viewer rendered context (render-through-RLS).
 *
 * A cloud MEMBER's background render must read every table THROUGH the member's
 * RLS-scoped connection and through the `<table>_v` masking view, so the bytes
 * that land in the rendered markdown on disk are already row-filtered + cell-
 * masked by Postgres. This is what makes the assistant's context-first retrieval
 * (get_row_context, which reads files off disk) safe on a cloud.
 *
 * The assertions read the rendered files DIRECTLY off disk (not through the GUI
 * route, which applies its own masking) — so they prove the RENDER itself, not
 * the serve path, produced the scoped projection:
 *   - a visible row's body is on disk; an owner-private row's body is NOT;
 *   - an owner-audience ("secret") column's value is NEVER on disk for a member;
 *   - the masked-table render COMPLETES (it used to crash `permission denied`,
 *     because base SELECT is revoked from members for any masked table).
 *
 * Postgres-gated: skipped without LATTICE_TEST_PG_URL (embedded PG locally).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import {
  setRowVisibility,
  grantRow,
  provisionMemberRole,
  generateMemberPassword,
} from '../../src/cloud/members.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { addWorkspace, resolveWorkspacePaths } from '../../src/framework/workspace.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const servers: GuiServerHandle[] = [];
const dirs: string[] = [];
const databases: string[] = [];
const roles: string[] = [];

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** Recursively read + concatenate every rendered file under a dir. */
function allRenderedText(dir: string): string {
  let out = '';
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out += allRenderedText(full);
    else if (ent.isFile()) out += readFileSync(full, 'utf8') + '\n';
  }
  return out;
}

async function waitForRender(gui: GuiServerHandle, timeoutMs = 25000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await (await fetch(`${gui.url}/api/render/status`)).json()) as {
      phase: string;
      error?: string;
    };
    if (body.phase === 'done') return body.phase;
    if (body.phase === 'error')
      throw new Error(`member render errored: ${body.error ?? 'unknown'}`);
    if (Date.now() > deadline) throw new Error(`render did not finish (phase=${body.phase})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (!PG_URL) return;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  for (const r of roles.splice(0)) {
    await admin.query(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => undefined);
  }
  for (const db of databases.splice(0)) {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      )
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined);
  }
  await admin.end();
});

describe.skipIf(!PG_URL)('WS8b: per-viewer rendered context (render-through-RLS)', () => {
  it("a member's rendered tree on disk contains only visible rows, with masked cells blank, and does not crash", async () => {
    // ── Owner: a cloud with a masked column on `notes` + two rows of differing
    //    visibility. n1 is shared everyone; n2 stays owner-private.
    const dbname = `lattice_pvr_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const owner = new Lattice(dbUrl(dbname), { encryptionKey: 'pvr-test-key' });
    registerNativeEntities(owner); // secrets / files / notes / chat_* — a realistic cloud
    // `widgets` is the masked entity under test (a non-native name avoids
    // colliding with registerNativeEntities' own `notes`).
    owner.define('widgets', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', secret_note: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'widgets.md',
    });
    owner.define('__lattice_user_identity', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        display_name: "TEXT NOT NULL DEFAULT ''",
        email: "TEXT NOT NULL DEFAULT ''",
        updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      },
      primaryKey: 'id',
      render: () => '',
      outputFile: '.lattice-native/user-identity.md',
    });
    await owner.init();
    await secureCloud(owner);

    await owner.insert('widgets', {
      id: 'n1',
      body: 'VISIBLE_BODY_N1',
      secret_note: 'EYES_ONLY_N1',
    });
    await owner.insert('widgets', {
      id: 'n2',
      body: 'PRIVATE_BODY_N2',
      secret_note: 'EYES_ONLY_N2',
    });
    await setRowVisibility(owner, 'widgets', 'n1', 'everyone');
    // n2 left private (owner only).
    await setColumnAudience(
      owner,
      'widgets',
      'secret_note',
      'owner',
      ['id', 'body', 'secret_note', 'deleted_at'],
      ['id'],
    );

    const role = `lm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);
    owner.close();

    // Boot an owner GUI once so the GUI-meta tables exist and the member group is
    // granted read on them — a raw owner Lattice never creates _lattice_gui_meta,
    // which the member render reads. (In the real product the owner uses the GUI.)
    {
      const ownerTmp = mkdtempSync(join(tmpdir(), `pvr-owner-${randomBytes(3).toString('hex')}-`));
      dirs.push(ownerTmp);
      const ownerRoot = join(ownerTmp, '.lattice');
      const ownerWs = addWorkspace(ownerRoot, {
        displayName: 'Owner',
        db: dbUrl(dbname),
        makeActive: true,
      });
      const ownerPaths = resolveWorkspacePaths(ownerRoot, ownerWs);
      mkdirSync(ownerPaths.contextDir, { recursive: true });
      const ownerGui = await startGuiServer({
        configPath: ownerPaths.configPath,
        outputDir: ownerPaths.contextDir,
        port: 0,
        openBrowser: false,
      });
      servers.push(ownerGui);
    }

    // ── Member GUI pointed at the cloud as the scoped role, autoRender ON so the
    //    background render (through the member's RLS connection + notes_v) fires.
    const tmp = mkdtempSync(join(tmpdir(), `pvr-${randomBytes(3).toString('hex')}-`));
    dirs.push(tmp);
    const root = join(tmp, '.lattice');
    const ws = addWorkspace(root, {
      displayName: 'Masked Cloud',
      db: dbUrl(dbname, role, pw),
      makeActive: true,
    });
    const paths = resolveWorkspacePaths(root, ws);
    mkdirSync(paths.contextDir, { recursive: true });
    const gui = await startGuiServer({
      configPath: paths.configPath,
      outputDir: paths.contextDir,
      port: 0,
      openBrowser: false,
      autoRender: true,
    });
    servers.push(gui);

    // The render must COMPLETE — pre-fix it crashed `permission denied` on the
    // revoked base SELECT of the masked table.
    await waitForRender(gui);

    const rendered = allRenderedText(paths.contextDir);

    // Visible row's unmasked body reached disk…
    expect(rendered).toContain('VISIBLE_BODY_N1');
    // …but the owner-audience column NEVER did (masked to NULL through notes_v).
    expect(rendered).not.toContain('EYES_ONLY_N1');
    // …and the owner-private row is entirely absent (row-filtered by RLS).
    expect(rendered).not.toContain('PRIVATE_BODY_N2');
    expect(rendered).not.toContain('EYES_ONLY_N2');

    // The member's own scoped tree is non-empty (the "0 files" guard) and the
    // view itself never leaks as a separate rendered object.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain('widgets_v');
  });

  it("overlays a member's visible derived enrichment onto the rendered row (per-viewer fold)", async () => {
    // ── Owner: a ground-truth row shared everyone, a source file F, and a derived
    //    enrichment of `body` from F (recorded as an observation, NOT a row write).
    const dbname = `lattice_pvrf_${randomBytes(4).toString('hex')}`;
    databases.push(dbname);
    const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
    await admin.query(`CREATE DATABASE "${dbname}"`);
    await admin.end();

    const owner = new Lattice(dbUrl(dbname), { encryptionKey: 'pvr-test-key' });
    registerNativeEntities(owner); // provides `files` (the enrichment source table)
    owner.define('widgets', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'widgets.md',
    });
    owner.define('__lattice_user_identity', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        display_name: "TEXT NOT NULL DEFAULT ''",
        email: "TEXT NOT NULL DEFAULT ''",
        updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      },
      primaryKey: 'id',
      render: () => '',
      outputFile: '.lattice-native/user-identity.md',
    });
    await owner.init();
    await owner.insert('widgets', { id: 'w1', body: 'GROUND_BODY_W1' });
    await owner.upsert('files', { id: 'F', original_name: 'card.pdf' });
    await owner.observe(
      'widgets',
      'w1',
      { body: 'ENRICHED_BODY_W1' },
      { sourceRef: ['F'], changeKind: 'derived' },
    );
    await secureCloud(owner);
    await setRowVisibility(owner, 'widgets', 'w1', 'everyone');

    const role = `lm_${randomBytes(3).toString('hex')}`;
    roles.push(role);
    const pw = generateMemberPassword();
    await provisionMemberRole(owner, role, pw);
    await grantRow(owner, 'files', 'F', role); // the member CAN see the source
    owner.close();

    // Owner GUI once → GUI-meta tables (the member render reads them).
    {
      const ownerTmp = mkdtempSync(join(tmpdir(), `pvrf-owner-${randomBytes(3).toString('hex')}-`));
      dirs.push(ownerTmp);
      const ownerRoot = join(ownerTmp, '.lattice');
      const ownerWs = addWorkspace(ownerRoot, {
        displayName: 'Owner',
        db: dbUrl(dbname),
        makeActive: true,
      });
      const ownerPaths = resolveWorkspacePaths(ownerRoot, ownerWs);
      mkdirSync(ownerPaths.contextDir, { recursive: true });
      servers.push(
        await startGuiServer({
          configPath: ownerPaths.configPath,
          outputDir: ownerPaths.contextDir,
          port: 0,
          openBrowser: false,
        }),
      );
    }

    // Member GUI (autoRender) → render folds in the visible derived value.
    const tmp = mkdtempSync(join(tmpdir(), `pvrf-${randomBytes(3).toString('hex')}-`));
    dirs.push(tmp);
    const root = join(tmp, '.lattice');
    const ws = addWorkspace(root, {
      displayName: 'Fold Cloud',
      db: dbUrl(dbname, role, pw),
      makeActive: true,
    });
    const paths = resolveWorkspacePaths(root, ws);
    mkdirSync(paths.contextDir, { recursive: true });
    servers.push(
      await startGuiServer({
        configPath: paths.configPath,
        outputDir: paths.contextDir,
        port: 0,
        openBrowser: false,
        autoRender: true,
      }),
    );

    await waitForRender(servers[servers.length - 1]!);
    const rendered = allRenderedText(paths.contextDir);

    // The member can see the source, so the rendered row carries the ENRICHED
    // value — folded over the ground truth, which no longer appears.
    expect(rendered).toContain('ENRICHED_BODY_W1');
    expect(rendered).not.toContain('GROUND_BODY_W1');
  });
});
