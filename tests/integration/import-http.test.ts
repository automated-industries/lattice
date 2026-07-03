import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
} from '../../src/index.js';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { inferSchema } from '../../src/import/infer.js';
import { materializeImport } from '../../src/import/materialize.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';
import { LINEAGE_TABLE } from '../../src/gui/lineage-store.js';

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

  it("records table-level 'derived' lineage for entities, dimensions, junctions, and views", async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-import-lineage-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'Lineage' });
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    dbs.push(db);
    const configPath = resolveWorkspacePaths(root, ws).configPath;

    const data = fixture();
    const plan = inferSchema(data);
    const views = [
      {
        name: 'company_zero',
        master: 'investments',
        filterColumn: 'company',
        filterValue: 'Company 0',
        matchedRows: 2,
      },
    ];
    await materializeImport({ db, configPath }, data, plan, views);

    const edges = await allAsyncOrSync(
      db.adapter,
      `SELECT "object_table", "object_id", "tier", "relation" FROM "${LINEAGE_TABLE}" WHERE "source_kind" = 'import'`,
    );
    const byTable = new Map(edges.map((e) => [String(e.object_table), e]));
    // EVERY materialized table gets a table-level ('*') edge under tier 'derived'
    // ('computed' is reserved for computed tables): the entities, the dimension
    // tables (taxonomy), the junctions (links), and the reconstructed views.
    for (const name of [
      'funds', // entity
      'investments', // entity
      'gross_deploy', // entity
      'industry', // dimension
      'region', // dimension
      'investments_funds', // junction
      'company_zero', // view
    ]) {
      const e = byTable.get(name);
      expect(e, `missing lineage edge for ${name}`).toBeDefined();
      expect(e?.object_id).toBe('*');
      expect(e?.tier).toBe('derived');
      expect(e?.relation).toBe('materialized_from');
    }
    // No edge escaped the relabel — nothing import-sourced remains 'computed'.
    expect(edges.every((e) => e.tier === 'derived')).toBe(true);

    // Re-applying the import must not duplicate any edge (dedup by tuple).
    await materializeImport({ db, configPath }, data, plan, views);
    const recount = await allAsyncOrSync(
      db.adapter,
      `SELECT COUNT(*) AS n FROM "${LINEAGE_TABLE}" WHERE "source_kind" = 'import'`,
    );
    expect(Number(recount[0]?.n)).toBe(edges.length);
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

    await materializeImport({ db, configPath }, data, inferSchema(data), [], {
      asOf: '2025-06-30',
    });
    await materializeImport({ db, configPath }, data, inferSchema(data), [], {
      asOf: '2026-03-31',
    });

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
    await materializeImport({ db, configPath }, data, inferSchema(data), [], {
      asOf: '2025-06-30',
    });
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
      edges26.every((e) => inv26.has(String(e.investments_id)) && funds26.has(String(e.funds_id))),
    ).toBe(true);
  });
});

describe('import: over the HTTP endpoints (chat-drop flow)', () => {
  async function freshServer(prefix: string): Promise<{ server: GuiServerHandle; base: string }> {
    const base = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'Http' });
    (await Lattice.openWorkspace({ root, workspaceId: ws.id })).close();
    const paths = resolveWorkspacePaths(root, ws);
    const server = await startGuiServer({
      configPath: paths.configPath,
      outputDir: paths.contextDir,
      latticeRoot: root,
      port: 0,
      openBrowser: false,
    });
    servers.push(server);
    return { server, base };
  }

  interface UploadResult {
    id: string;
    autoImport?: {
      reason?: string;
      fileId?: string;
      plan?: { entities: { name: string }[] };
      views?: { name: string; master: string }[];
    };
  }

  async function uploadFile(
    server: GuiServerHandle,
    name: string,
    mime: string,
    bytes: Buffer,
  ): Promise<UploadResult> {
    return (await (
      await fetch(`${server.url}/api/ingest/upload`, {
        method: 'POST',
        headers: { 'content-type': mime, 'x-filename': name },
        body: bytes,
      })
    ).json()) as UploadResult;
  }

  interface ApplyEvent {
    phase: string;
    ok?: boolean;
    message?: string;
    result?: { rowsByTable: Record<string, number>; views: { name: string; rows: number }[] };
  }

  async function applyImport(server: GuiServerHandle, fileId: string): Promise<ApplyEvent[]> {
    const text = await (
      await fetch(`${server.url}/api/import/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId, mode: 'both' }),
      })
    ).text();
    return text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as ApplyEvent);
  }

  it('drop → new-dataset proposal → apply materializes it + serves via /api/tables', async () => {
    const { server } = await freshServer('lattice-import-http-');
    const up = await uploadFile(
      server,
      'data.json',
      'application/json',
      Buffer.from(JSON.stringify(fixture()), 'utf8'),
    );
    // A brand-new structured drop is proposed, never silently imported.
    expect(up.autoImport?.reason).toBe('new-dataset');
    expect(up.autoImport?.plan?.entities.map((e) => e.name).sort()).toEqual([
      'funds',
      'gross_deploy',
      'investments',
    ]);
    const fileId = up.autoImport?.fileId;
    expect(typeof fileId).toBe('string');

    // Apply streams NDJSON; the final line carries the result.
    const events = await applyImport(server, fileId!);
    const done = events.find((e) => e.phase === 'done' && e.ok);
    expect(done?.result?.rowsByTable.funds).toBe(2);
    expect(events.some((e) => e.phase === 'entities')).toBe(true);

    // The imported data is served via the canonical read path…
    const rows = (await (await fetch(`${server.url}/api/tables/funds/rows`)).json()) as {
      rows: { code: string }[];
    };
    expect(rows.rows.map((r) => r.code).sort()).toEqual(['Fund EP', 'Fund GG']);
    // …and the dropped source is already a File (created at upload, before apply).
    const files = (await (await fetch(`${server.url}/api/tables/files/rows`)).json()) as {
      rows: { original_name?: string }[];
    };
    expect(files.rows.some((r) => r.original_name === 'data.json')).toBe(true);
  });

  it('apply with no fileId is a 400, not a 500', async () => {
    const { server } = await freshServer('lattice-import-bad-');
    const bad = await fetch(`${server.url}/api/import/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'both' }),
    });
    expect(bad.status).toBe(400);
  });

  it('imports an .xlsx drop: per-fund tabs become read-only views of the master', async () => {
    const { server, base } = await freshServer('lattice-xlsx-http-');
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
    const xlsxPath = join(base, 'book.xlsx');
    await wb.xlsx.writeFile(xlsxPath);

    const up = await uploadFile(
      server,
      'book.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      readFileSync(xlsxPath),
    );
    expect(up.autoImport?.reason).toBe('new-dataset');
    expect(up.autoImport?.views?.map((v) => v.name).sort()).toEqual(['f1', 'f2']);
    expect(up.autoImport?.views?.every((v) => v.master === 'investments')).toBe(true);
    expect(up.autoImport?.plan?.entities.map((e) => e.name)).toContain('investments');
    expect(up.autoImport?.plan?.entities.map((e) => e.name)).not.toContain('f1');

    const events = await applyImport(server, up.autoImport!.fileId!);
    const applied = events.find((e) => e.phase === 'done' && e.ok);
    expect(applied?.result?.views.find((v) => v.name === 'f1')?.rows).toBe(6);

    const all = (await (
      await fetch(`${server.url}/api/tables/investments/rows?limit=50`)
    ).json()) as { rows: unknown[] };
    expect(all.rows).toHaveLength(12);
    const view = (await (await fetch(`${server.url}/api/tables/f1/rows?limit=50`)).json()) as {
      rows: unknown[];
    };
    expect(view.rows).toHaveLength(6);
  });

  it('apply refuses an oversized source (the 50MB cap) instead of OOM-ing', async () => {
    const { server, base } = await freshServer('lattice-import-cap-');
    const up = await uploadFile(
      server,
      'data.json',
      'application/json',
      Buffer.from(JSON.stringify(fixture()), 'utf8'),
    );
    const fileId = up.autoImport?.fileId;
    expect(typeof fileId).toBe('string');

    // Grow the retained blob past the cap on disk — a swapped/grown source the
    // apply route must re-check (the upload cap only bounded the original bytes).
    const filesRows = (await (await fetch(`${server.url}/api/tables/files/rows`)).json()) as {
      rows: { id: string; blob_path?: string }[];
    };
    const blobPath = filesRows.rows.find((r) => r.id === fileId)?.blob_path;
    expect(typeof blobPath).toBe('string');
    // Locate the content-addressed blob wherever it landed under the workspace
    // (resolution-independent) and grow it past the cap.
    const sha = blobPath!.split(/[/\\]/).pop()!;
    const rel = (readdirSync(base, { recursive: true }) as string[]).find(
      (e) => e.split(/[/\\]/).pop() === sha,
    );
    expect(rel).toBeTruthy();
    truncateSync(join(base, rel!), 51_000_000);

    // The route statSyncs before reading and fails loudly rather than streaming
    // 51MB into memory.
    const events = await applyImport(server, fileId!);
    expect(events.some((e) => e.phase === 'error' && /too large/i.test(e.message ?? ''))).toBe(
      true,
    );
    expect(events.some((e) => e.phase === 'done' && e.ok)).toBe(false);
  });

  it('GET /api/history rejects a non-numeric limit (400) but defaults a missing one', async () => {
    const { server } = await freshServer('lattice-history-limit-');
    expect((await fetch(`${server.url}/api/history?limit=abc`)).status).toBe(400);
    expect((await fetch(`${server.url}/api/history?limit=50`)).status).toBe(200);
    expect((await fetch(`${server.url}/api/history`)).status).toBe(200);
  });
});
