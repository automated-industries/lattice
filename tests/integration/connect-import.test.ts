import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice, ensureLatticeRoot, addWorkspace, resolveWorkspacePaths } from '../../src/index.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { inferSchema } from '../../src/import/infer.js';
import { materializeImport } from '../../src/import/materialize.js';

const dirs: string[] = [];
const dbs: Lattice[] = [];
const servers: GuiServerHandle[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
});

/** Fund-shaped fixture: keyed entity, keyless entity with an array ref + dimensions,
 *  a columnar entity, plus a derived object — and one exact-duplicate investment to
 *  exercise keyless dedup. */
function fixture() {
  const regions = ['Europe', 'N. America', 'Asia'];
  const industries = ['Technology', 'Healthcare', 'Energy'];
  const stages = ['Early Stage', 'Growth'];
  const codes = ['Fund EP', 'Fund GG'];
  const investments = Array.from({ length: 12 }, (_, i) => ({
    company: 'Company ' + (i % 8),
    funds: [codes[i % 2]],
    dateInitial: `20${String(10 + (i % 9)).padStart(2, '0')}-01-15`,
    invested: 1.5 + i,
    region: regions[i % 3],
    industry: industries[i % 3],
    stage: stages[i % 2],
    description: 'desc ' + i,
  }));
  investments.push({ ...investments[0]! }); // exact duplicate → must dedup away

  return {
    meta: { title: 'X' },
    funds: [
      { code: 'Fund EP', name: 'Fund Early Plays', vintage: 1999, fundSize: 100.5 },
      { code: 'Fund GG', name: 'Fund Global Growth', vintage: 2022, fundSize: 200 },
    ],
    investments,
    grossDeploy: [
      [1999, 'Fund EP', 'Early Stage', 'Europe', 'Technology'],
      [2022, 'Fund GG', 'Growth', 'N. America', 'Healthcare'],
      [2023, 'Fund GG', 'Growth', 'Asia', 'Energy'],
    ],
    grossDeployCols: ['year', 'fund', 'stage', 'region', 'industry'],
    total: { invested: 999 },
  };
}

describe('import: infer → materialize → query (canonical)', () => {
  it('creates entities, dimensions, junctions; dedups; links resolve', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-import-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'Import' });
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    dbs.push(db);
    const configPath = resolveWorkspacePaths(root, ws).configPath;

    const data = fixture();
    const plan = inferSchema(data);
    const result = await materializeImport({ db, configPath }, data, plan);

    // Entities + rows, with keyless dedup (13 source investments → 12 after the dup).
    expect(await db.count('funds')).toBe(2);
    expect(await db.count('investments')).toBe(12);
    expect(await db.count('gross_deploy')).toBe(3);

    // Dimensions are deduped to distinct values.
    expect(await db.count('industry')).toBe(3);
    expect(await db.count('region')).toBe(3);

    // Linkages materialized as populated junctions.
    expect(await db.count('investments_funds')).toBe(12); // 1 fund per investment
    expect(await db.count('gross_deploy_funds')).toBe(3);
    expect(await db.count('investments_industry')).toBe(12);

    // The funds rows carry their real columns (read back through the canonical path).
    const funds = await db.query('funds', { orderBy: 'vintage' });
    expect(funds.map((f) => f.code).sort()).toEqual(['Fund EP', 'Fund GG']);
    expect(funds.find((f) => f.code === 'Fund EP')?.name).toBe('Fund Early Plays');
    expect(funds.find((f) => f.code === 'Fund GG')?.vintage).toBe(2022);

    // Result report is accurate + no unresolved links (all fund codes resolve).
    const invFunds = result.links.find((l) => l.junction === 'investments_funds')!;
    expect(invFunds.created).toBe(12);
    expect(invFunds.unresolved).toBe(0);
  });

  it('is idempotent on re-apply (no duplicate rows or edges)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-import2-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'Import2' });
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    dbs.push(db);
    const configPath = resolveWorkspacePaths(root, ws).configPath;
    const data = fixture();
    const plan = inferSchema(data);

    await materializeImport({ db, configPath }, data, plan);
    await materializeImport({ db, configPath }, data, plan); // re-apply

    expect(await db.count('funds')).toBe(2);
    expect(await db.count('investments')).toBe(12);
    expect(await db.count('investments_funds')).toBe(12);
  });

  it('mode=schema imports structure + taxonomy only; mode=contents then loads rows + links', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-import3-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'Import3' });
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    dbs.push(db);
    const configPath = resolveWorkspacePaths(root, ws).configPath;
    const data = fixture();
    const plan = inferSchema(data);

    // schema: tables exist, dimension VALUES (taxonomy) are seeded, but NO entity
    // rows and NO links.
    const phases: string[] = [];
    const schemaResult = await materializeImport({ db, configPath }, data, plan, [], {
      mode: 'schema',
      onProgress: (p) => phases.push(p.phase),
    });
    expect(schemaResult.mode).toBe('schema');
    expect(await db.count('funds')).toBe(0);
    expect(await db.count('investments')).toBe(0);
    expect(await db.count('industry')).toBe(3); // taxonomy populated
    expect(await db.count('region')).toBe(3);
    expect(await db.count('investments_funds')).toBe(0); // no links yet
    expect(schemaResult.links.every((l) => l.created === 0)).toBe(true);
    expect(phases).toContain('dimensions'); // streamed progress fired
    expect(phases).toContain('done');

    // contents: now the rows + links land (into the schema just created).
    const contentResult = await materializeImport({ db, configPath }, data, plan, [], {
      mode: 'contents',
    });
    expect(contentResult.mode).toBe('contents');
    expect(await db.count('funds')).toBe(2);
    expect(await db.count('investments')).toBe(12);
    expect(await db.count('investments_funds')).toBe(12); // links resolved against taxonomy
  });

  it('keeps both point-in-time snapshots when imported at two as-of dates', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-asof-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'AsOf' });
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    dbs.push(db);
    const configPath = resolveWorkspacePaths(root, ws).configPath;
    const data = fixture();

    await materializeImport({ db, configPath }, data, inferSchema(data), [], { asOf: '2025-06-30' });
    await materializeImport({ db, configPath }, data, inferSchema(data), [], { asOf: '2026-03-31' });

    // Both dated snapshots are kept (2 imports × per-snapshot counts).
    expect(await db.count('funds')).toBe(4); // 2 funds × 2 dates
    expect(await db.count('investments')).toBe(24); // 12 × 2
    // The taxonomy (dimensions) is SHARED across dates, not duplicated.
    expect(await db.count('region')).toBe(3);
    expect(await db.count('industry')).toBe(3);
    // Links are per-snapshot (12 × 2).
    expect(await db.count('investments_funds')).toBe(24);
    expect((await db.query('funds', { where: { as_of: '2025-06-30' } })).length).toBe(2);
    expect((await db.query('funds', { where: { as_of: '2026-03-31' } })).length).toBe(2);

    // Re-importing the SAME date is idempotent (no third snapshot).
    await materializeImport({ db, configPath }, data, inferSchema(data), [], { asOf: '2025-06-30' });
    expect(await db.count('funds')).toBe(4);
    expect(await db.count('investments')).toBe(24);

    // Links resolve WITHIN a snapshot: every 2026 edge connects a 2026 investment
    // to a 2026 fund (no bleed across snapshots).
    const funds26 = new Set(
      (await db.query('funds', { where: { as_of: '2026-03-31' } })).map((f) => String(f.id)),
    );
    const inv26 = new Set(
      (await db.query('investments', { where: { as_of: '2026-03-31' } })).map((r) => String(r.id)),
    );
    const edges26 = await db.query('investments_funds', { where: { as_of: '2026-03-31' } });
    expect(edges26.length).toBe(12);
    expect(
      edges26.every(
        (e) => inv26.has(String(e.investments_id)) && funds26.has(String(e.funds_id)),
      ),
    ).toBe(true);
  });
});

describe('import: over the HTTP endpoints (connect panel flow)', () => {
  it('lists sources, analyzes, applies, then serves the data via /api/tables', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-import-http-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'ImportHttp' });
    const seed = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    seed.close();
    const paths = resolveWorkspacePaths(root, ws);

    // A connected dashboard folder containing the data model.
    const dashDir = join(base, 'dash');
    mkdirSync(dashDir, { recursive: true });
    writeFileSync(join(dashDir, 'data.json'), JSON.stringify(fixture()), 'utf8');

    const server = await startGuiServer({
      configPath: paths.configPath,
      outputDir: paths.contextDir,
      port: 0,
      openBrowser: false,
      dashboardPath: dashDir,
    });
    servers.push(server);

    // sources lists the JSON in the connected folder
    const sources = (await (await fetch(`${server.url}/api/connect/import/sources`)).json()) as {
      sources: string[];
    };
    expect(sources.sources.some((s) => s.endsWith('data.json'))).toBe(true);

    // analyze (no writes)
    const analyzed = (await (
      await fetch(`${server.url}/api/connect/import/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'data.json' }),
      })
    ).json()) as { plan: { entities: { name: string }[] } };
    expect(analyzed.plan.entities.map((e) => e.name).sort()).toEqual([
      'funds',
      'gross_deploy',
      'investments',
    ]);

    // apply — streams newline-delimited JSON progress; the final line carries the result
    const applyText = await (
      await fetch(`${server.url}/api/connect/import/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'data.json', mode: 'both' }),
      })
    ).text();
    const events = applyText
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { phase: string; ok?: boolean; result?: { rowsByTable: Record<string, number> } });
    const done = events.find((e) => e.phase === 'done' && e.ok);
    expect(done).toBeTruthy();
    expect(done?.result?.rowsByTable.funds).toBe(2);
    // progress streamed (not just a single response)
    expect(events.some((e) => e.phase === 'entities')).toBe(true);

    // the imported data is now served via the canonical read path
    const rows = (await (await fetch(`${server.url}/api/tables/funds/rows`)).json()) as {
      rows: { code: string }[];
    };
    expect(rows.rows.map((r) => r.code).sort()).toEqual(['Fund EP', 'Fund GG']);

    // a bad path is a 400, not a 500
    const bad = await fetch(`${server.url}/api/connect/import/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'does-not-exist.json' }),
    });
    expect(bad.status).toBe(400);
  });

  it('stages an uploaded file, imports it, and ingests the source as a File', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-stage-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'Stage' });
    (await Lattice.openWorkspace({ root, workspaceId: ws.id })).close();
    const paths = resolveWorkspacePaths(root, ws);
    const server = await startGuiServer({
      configPath: paths.configPath,
      outputDir: paths.contextDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(server);

    // Upload bytes to /stage (the picker's path) → get a server path.
    const bytes = Buffer.from(JSON.stringify({ deals: [{ company: 'A' }, { company: 'B' }] }), 'utf8');
    const staged = (await (
      await fetch(`${server.url}/api/connect/import/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-filename': 'deals.json' },
        body: bytes,
      })
    ).json()) as { path: string };
    expect(staged.path).toContain('import-staging');

    // Import the staged path → streams a 'file' phase (source ingested as a File).
    const events = (
      await (
        await fetch(`${server.url}/api/connect/import/apply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: staged.path, mode: 'both' }),
        })
      ).text()
    )
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { phase: string; ok?: boolean });
    expect(events.some((e) => e.phase === 'file')).toBe(true);
    expect(events.find((e) => e.phase === 'done' && e.ok)).toBeTruthy();

    // The source file shows up under Files, with the original name (no uuid prefix).
    const files = (await (await fetch(`${server.url}/api/tables/files/rows`)).json()) as {
      rows: { original_name?: string }[];
    };
    expect(files.rows.length).toBeGreaterThanOrEqual(1);
    expect(files.rows.some((r) => r.original_name === 'deals.json')).toBe(true);
  });

  it('imports an .xlsx: per-fund tabs become read-only views of the master', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-xlsx-http-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'Xlsx' });
    (await Lattice.openWorkspace({ root, workspaceId: ws.id })).close();
    const paths = resolveWorkspacePaths(root, ws);

    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const regions = ['NA', 'EU', 'Asia'];
    const master = wb.addWorksheet('Investments');
    master.getRow(1).values = [null, 'Company', 'Fund', 'Region', 'Invested'];
    const f1 = wb.addWorksheet('F1');
    f1.getRow(1).values = [null, 'Company', 'Region', 'Invested'];
    const f2 = wb.addWorksheet('F2');
    f2.getRow(1).values = [null, 'Company', 'Region', 'Invested'];
    let mr = 2;
    const fr = { F1: 2, F2: 2 };
    for (let i = 0; i < 12; i++) {
      const fund = i % 2 === 0 ? 'F1' : 'F2';
      const co = 'Co ' + i;
      const region = regions[i % 3];
      const inv = 10 + i;
      master.getRow(mr++).values = [null, co, fund, region, inv];
      const sheet = fund === 'F1' ? f1 : f2;
      sheet.getRow(fr[fund]++).values = [null, co, region, inv];
    }
    const dashDir = join(base, 'dash');
    mkdirSync(dashDir, { recursive: true });
    writeFileSync(join(dashDir, 'index.html'), '<!doctype html><body>x</body>', 'utf8');
    await wb.xlsx.writeFile(join(dashDir, 'book.xlsx'));

    const server = await startGuiServer({
      configPath: paths.configPath,
      outputDir: paths.contextDir,
      port: 0,
      openBrowser: false,
      dashboardPath: dashDir,
    });
    servers.push(server);

    const analyzed = (await (
      await fetch(`${server.url}/api/connect/import/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'book.xlsx' }),
      })
    ).json()) as { plan: { entities: { name: string }[] }; views: { name: string; master: string }[] };
    expect(analyzed.views.map((v) => v.name).sort()).toEqual(['f1', 'f2']);
    expect(analyzed.views.every((v) => v.master === 'investments')).toBe(true);
    expect(analyzed.plan.entities.map((e) => e.name)).toContain('investments');
    expect(analyzed.plan.entities.map((e) => e.name)).not.toContain('f1');

    const applyText = await (
      await fetch(`${server.url}/api/connect/import/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'book.xlsx', mode: 'both' }),
      })
    ).text();
    const applyEvents = applyText
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { phase: string; ok?: boolean; result?: { views: { name: string; rows: number }[] } });
    const applied = applyEvents.find((e) => e.phase === 'done' && e.ok);
    expect(applied).toBeTruthy();
    expect(applied?.result?.views.find((v) => v.name === 'f1')?.rows).toBe(6);

    const all = (await (await fetch(`${server.url}/api/tables/investments/rows?limit=50`)).json()) as {
      rows: unknown[];
    };
    expect(all.rows).toHaveLength(12);
    const view = (await (await fetch(`${server.url}/api/tables/f1/rows?limit=50`)).json()) as {
      rows: { fund?: string }[];
    };
    expect(view.rows).toHaveLength(6);
  });
});
