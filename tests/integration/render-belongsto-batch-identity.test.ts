/**
 * SAFE-SUBSET belongsTo→PK render batch — identity proof.
 *
 * The render engine batches the SAFE SUBSET of `belongsTo` sources (reference is
 * the target's single-column primary key; no per-source orderBy/limit/protection)
 * into ONE `WHERE pk IN (...)` read per (target + WHERE) across the whole entity
 * set, instead of one point-read per entity row. Because the reference is the PK,
 * each key maps to AT MOST ONE row — so the rendered output must be byte-for-byte
 * identical to the per-row path.
 *
 * These tests prove that identity by rendering the SAME fixture twice in one
 * process — once with batching OFF (env LATTICE_RENDER_BELONGSTO_BATCH=0, the
 * literal per-row code path that shipped before this change) and once ON — then
 * hashing the entire rendered tree (every file + the manifest's deterministic
 * per-entity hash map) and asserting the two digests are equal.
 *
 *   - an OWNER-path SQLite case with a realistic mix: a batchable belongsTo with
 *     the default `references` (= 'id' = PK), a batchable belongsTo with an
 *     explicit `references` equal to a non-'id' PK, plus EXCLUDED sources
 *     (hasMany, a non-PK belongsTo, a custom source, a null/missing FK, a
 *     duplicate-FK fan-in) — all of which must render identically;
 *   - a MEMBER / RLS Postgres case (gated on LATTICE_TEST_PG_URL; a disposable
 *     embedded Postgres is booted by the global setup otherwise): the member's
 *     background render reads every table THROUGH `<table>_v`, and the rendered
 *     tree must be digest-identical OFF vs ON while the masking still holds (a
 *     masked column's value never reaches disk; an unshared row is absent).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { Lattice } from '../../src/lattice.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { setColumnAudience } from '../../src/cloud/audience.js';
import {
  setRowVisibility,
  provisionMemberRole,
  generateMemberPassword,
} from '../../src/cloud/members.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { addWorkspace, resolveWorkspacePaths } from '../../src/framework/workspace.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const databases: string[] = [];
const roles: string[] = [];
let savedConfigDir: string | undefined;

beforeEach(() => {
  // Isolate the encrypted credential store (raw-db-url heal target) into a
  // disposable per-test dir, so this test never writes to the real `~/.lattice`
  // (which would both pollute the operator's machine and corrupt the shared
  // store other Postgres test files read after us).
  savedConfigDir = process.env.LATTICE_CONFIG_DIR;
  const cfg = mkdtempSync(join(tmpdir(), 'b2pk-cfg-'));
  dirs.push(cfg);
  process.env.LATTICE_CONFIG_DIR = cfg;
});

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedConfigDir;
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

function dbUrl(dbname: string, user?: string, password?: string): string {
  const u = new URL(PG_URL!);
  u.pathname = `/${dbname}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/**
 * Deterministic digest of a rendered tree: every file's relative path + bytes,
 * sorted, hashed. The only non-deterministic content is the wall-clock
 * `generated_at` timestamp — it (a) appears as a manifest field, (b) appears as a
 * frontmatter line in native-entity renders, and (c) feeds the manifest's
 * per-entity `contentHash`, which is computed over the RAW (timestamped) bytes.
 * All three legitimately differ between two render invocations regardless of
 * batching. Normalize all three out: the timestamp spellings, and the manifest
 * `"hash": "<64-hex>"` values (their non-determinism is purely the timestamp
 * inside the hashed bytes). Everything that actually depends on the batch — every
 * rendered body byte (timestamp-normalized), which files exist, which entity each
 * belongs to, the declared/protected file sets — stays in the digest.
 */
function renderDigest(dir: string): string {
  const normalize = (rel: string, s: string): string => {
    let out = s
      // manifest.json:  "generated_at": "<iso>"
      .replace(/"generated_at":\s*"[^"]*"/g, '"generated_at":"<normalized>"')
      // YAML frontmatter: generated_at: "<iso>"
      .replace(/generated_at:\s*"[^"]*"/g, 'generated_at: "<normalized>"');
    if (rel.endsWith('manifest.json')) {
      // The per-entity content hash is contentHash(rawTimestampedBytes); its only
      // variability is the timestamp it hashed over, already normalized in the
      // body above. Blank it so the manifest's STRUCTURE stays in the digest.
      out = out.replace(/"hash":\s*"[0-9a-f]{64}"/g, '"hash":"<normalized>"');
    }
    return out;
  };
  const entries: { path: string; bytes: string }[] = [];
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        const rel = relative(dir, full);
        entries.push({ path: rel, bytes: normalize(rel, readFileSync(full, 'utf8')) });
      }
    }
  };
  walk(dir);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  for (const e of entries) {
    h.update(e.path);
    h.update('\0');
    h.update(e.bytes);
    h.update('\0');
  }
  return h.digest('hex');
}

async function waitForRender(gui: GuiServerHandle, timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await (await fetch(`${gui.url}/api/render/status`)).json()) as {
      phase: string;
      error?: string;
    };
    if (body.phase === 'done') return;
    if (body.phase === 'error') throw new Error(`render errored: ${body.error ?? 'unknown'}`);
    if (Date.now() > deadline) throw new Error(`render did not finish (phase=${body.phase})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Build the owner-path SQLite fixture and render it to `out`. The same schema +
 * rows + entity-context layout is used both off and on; only the batch flag
 * (set via env before construction) differs between calls.
 */
async function renderOwnerFixture(dbPath: string, out: string): Promise<void> {
  const db = new Lattice(dbPath);

  // Parents the batchable belongsTo sources point AT.
  // - `teams.id` is the default-PK target ('id').
  // - `regions.code` is a NON-'id' single-column PK target (explicit references).
  db.define('teams', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
    render: () => '',
    outputFile: '.schema-only/teams.md',
  });
  db.define('regions', {
    columns: { code: 'TEXT PRIMARY KEY', label: 'TEXT' },
    primaryKey: 'code',
    render: () => '',
    outputFile: '.schema-only/regions.md',
  });
  // A non-PK target column (`categories.kind` is not the PK) — a belongsTo whose
  // `references` is NOT the PK must stay per-row (EXCLUDED from the batch).
  db.define('categories', {
    columns: { id: 'TEXT PRIMARY KEY', kind: 'TEXT', tag: 'TEXT' },
    render: () => '',
    outputFile: '.schema-only/categories.md',
  });
  // The anchor entity + its children (hasMany target).
  db.define('bots', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT',
      team_id: 'TEXT',
      region_code: 'TEXT',
      cat_kind: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '.schema-only/bots.md',
  });
  db.define('logs', {
    columns: { id: 'TEXT PRIMARY KEY', bot_id: 'TEXT', msg: 'TEXT' },
    render: () => '',
    outputFile: '.schema-only/logs.md',
  });

  db.defineEntityContext('bots', {
    slug: (r) => String(r.name),
    files: {
      'BOT.md': { source: { type: 'self' }, render: ([r]) => `# ${String(r?.name)}\n` },
      // BATCHABLE: default references ('id') == teams PK.
      'TEAM.md': {
        source: { type: 'belongsTo', table: 'teams', foreignKey: 'team_id' },
        render: (rows) => `# Team\n\n${rows.map((r) => `- ${String(r.name)}`).join('\n')}\n`,
        omitIfEmpty: true,
      },
      // BATCHABLE: explicit references == regions PK ('code', non-'id').
      'REGION.md': {
        source: {
          type: 'belongsTo',
          table: 'regions',
          foreignKey: 'region_code',
          references: 'code',
        },
        render: (rows) => `# Region\n\n${rows.map((r) => `- ${String(r.label)}`).join('\n')}\n`,
        omitIfEmpty: true,
      },
      // EXCLUDED (non-PK reference): belongsTo whose references is not the PK.
      'CATEGORY.md': {
        source: {
          type: 'belongsTo',
          table: 'categories',
          foreignKey: 'cat_kind',
          references: 'kind',
        },
        render: (rows) => `# Category\n\n${rows.map((r) => `- ${String(r.tag)}`).join('\n')}\n`,
        omitIfEmpty: true,
      },
      // EXCLUDED (hasMany): children rolled up per-row.
      'LOGS.md': {
        source: { type: 'hasMany', table: 'logs', foreignKey: 'bot_id' },
        render: (rows) => `# Logs\n\n${rows.map((r) => `- ${String(r.msg)}`).join('\n')}\n`,
        omitIfEmpty: true,
      },
      // EXCLUDED (custom): arbitrary closure, never batched.
      'CUSTOM.md': {
        source: {
          type: 'custom',
          query: (row, adapter) =>
            adapter.all('SELECT * FROM teams WHERE id = ?', [row.team_id]) as never,
        },
        render: (rows) => `# Custom\n\n${rows.map((r) => `- ${String(r.name)}`).join('\n')}\n`,
        omitIfEmpty: true,
      },
    },
    combined: { outputFile: 'CONTEXT.md' },
  });

  await db.init();

  await db.insert('teams', { id: 't1', name: 'Alpha' });
  await db.insert('teams', { id: 't2', name: 'Beta' });
  await db.insert('regions', { code: 'us-east', label: 'US East' });
  await db.insert('regions', { code: 'eu-west', label: 'EU West' });
  await db.insert('categories', { id: 'c1', kind: 'support', tag: 'SUP' });

  // Two bots share team t1 (duplicate-key fan-in — dedup to one IN-key);
  // one bot has a NULL FK (→ omitted file, no IN-key); one references a team
  // that does not exist (→ no row → omitted, identical both ways).
  await db.insert('bots', {
    id: 'b1',
    name: 'one',
    team_id: 't1',
    region_code: 'us-east',
    cat_kind: 'support',
  });
  await db.insert('bots', {
    id: 'b2',
    name: 'two',
    team_id: 't1',
    region_code: 'eu-west',
    cat_kind: 'support',
  });
  await db.insert('bots', {
    id: 'b3',
    name: 'three',
    team_id: null,
    region_code: 'us-east',
    cat_kind: 'missing',
  });
  await db.insert('bots', {
    id: 'b4',
    name: 'four',
    team_id: 'nonexistent',
    region_code: 'nonexistent',
    cat_kind: 'support',
  });
  await db.insert('logs', { id: 'l1', bot_id: 'b1', msg: 'hello' });
  await db.insert('logs', { id: 'l2', bot_id: 'b1', msg: 'world' });

  await db.render(out);
  db.close();
}

describe('SAFE-SUBSET belongsTo→PK render batch — identity', () => {
  it('owner path (SQLite): rendered tree digest is identical with batching off vs on', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-b2pk-'));
    dirs.push(base);

    const prev = process.env.LATTICE_RENDER_BELONGSTO_BATCH;

    // OFF — the literal per-row belongsTo path that shipped before the batch.
    process.env.LATTICE_RENDER_BELONGSTO_BATCH = '0';
    const outOff = join(base, 'off');
    await renderOwnerFixture(join(base, 'off.sqlite'), outOff);
    const digestOff = renderDigest(outOff);

    // ON — the batched `WHERE pk IN (...)` path (default).
    delete process.env.LATTICE_RENDER_BELONGSTO_BATCH;
    const outOn = join(base, 'on');
    await renderOwnerFixture(join(base, 'on.sqlite'), outOn);
    const digestOn = renderDigest(outOn);

    if (prev === undefined) delete process.env.LATTICE_RENDER_BELONGSTO_BATCH;
    else process.env.LATTICE_RENDER_BELONGSTO_BATCH = prev;

    // The whole point: byte-for-byte identical.
    expect(digestOn).toBe(digestOff);

    // Sanity that the fixture actually exercised the batched + excluded paths:
    // a shared-team batchable file, an explicit-references-PK file, and the
    // excluded files all landed.
    expect(existsSync(join(outOn, 'bots', 'one', 'TEAM.md'))).toBe(true);
    expect(readFileSync(join(outOn, 'bots', 'one', 'TEAM.md'), 'utf8')).toContain('Alpha');
    expect(readFileSync(join(outOn, 'bots', 'two', 'TEAM.md'), 'utf8')).toContain('Alpha');
    expect(readFileSync(join(outOn, 'bots', 'one', 'REGION.md'), 'utf8')).toContain('US East');
    expect(readFileSync(join(outOn, 'bots', 'one', 'CATEGORY.md'), 'utf8')).toContain('SUP');
    expect(readFileSync(join(outOn, 'bots', 'one', 'LOGS.md'), 'utf8')).toContain('hello');
    // null FK → omitted; nonexistent FK → omitted.
    expect(existsSync(join(outOn, 'bots', 'three', 'TEAM.md'))).toBe(false);
    expect(existsSync(join(outOn, 'bots', 'four', 'TEAM.md'))).toBe(false);
  });

  describe.skipIf(!PG_URL)('member / RLS (Postgres)', () => {
    it("member's rendered tree is digest-identical off vs on, and masking still holds", async () => {
      const dbname = `lattice_b2pk_${randomBytes(4).toString('hex')}`;
      databases.push(dbname);
      const admin = new pg.Pool({ connectionString: PG_URL!, max: 1 });
      await admin.query(`CREATE DATABASE "${dbname}"`);
      await admin.end();

      const owner = new Lattice(dbUrl(dbname), { encryptionKey: 'b2pk-test-key' });
      registerNativeEntities(owner);
      owner.define('widgets', {
        columns: {
          id: 'TEXT PRIMARY KEY',
          body: 'TEXT',
          secret_note: 'TEXT',
          deleted_at: 'TEXT',
        },
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

      // Owner GUI once so the GUI-meta tables exist + member group is granted.
      {
        const ownerTmp = mkdtempSync(
          join(tmpdir(), `b2pk-owner-${randomBytes(3).toString('hex')}-`),
        );
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
        // Opening a cloud workspace returns immediately and the owner-side
        // convergence (which grants `_lattice_gui_meta` to the member group) runs
        // in the background. Rendering AS the member before that grant lands races
        // it — under parallel load the member render intermittently fails with
        // "permission denied for _lattice_gui_meta". Wait for convergence first.
        await ownerGui.whenConverged();
      }

      // Render the member tree twice (off, then on), each into its own dir.
      const digests: string[] = [];
      const prev = process.env.LATTICE_RENDER_BELONGSTO_BATCH;
      for (const mode of ['0', '1'] as const) {
        if (mode === '0') process.env.LATTICE_RENDER_BELONGSTO_BATCH = '0';
        else delete process.env.LATTICE_RENDER_BELONGSTO_BATCH;

        const tmp = mkdtempSync(
          join(tmpdir(), `b2pk-m-${mode}-${randomBytes(3).toString('hex')}-`),
        );
        dirs.push(tmp);
        const root = join(tmp, '.lattice');
        const ws = addWorkspace(root, {
          displayName: `Masked Cloud ${mode}`,
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
        await waitForRender(gui);

        // Masking must hold in BOTH modes (read straight off disk).
        const allText = (function read(d: string): string {
          let s = '';
          for (const ent of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, ent.name);
            if (ent.isDirectory()) s += read(full);
            else if (ent.isFile()) s += readFileSync(full, 'utf8') + '\n';
          }
          return s;
        })(paths.contextDir);
        expect(allText).toContain('VISIBLE_BODY_N1');
        expect(allText).not.toContain('EYES_ONLY_N1');
        expect(allText).not.toContain('PRIVATE_BODY_N2');
        expect(allText).not.toContain('widgets_v');

        digests.push(renderDigest(paths.contextDir));
        await servers.pop()!.close();
      }
      if (prev === undefined) delete process.env.LATTICE_RENDER_BELONGSTO_BATCH;
      else process.env.LATTICE_RENDER_BELONGSTO_BATCH = prev;

      // Off vs on member render → byte-identical (the batch change is inert on
      // the per-viewer path AND does not perturb masking).
      expect(digests[1]).toBe(digests[0]);
    });
  });
});
