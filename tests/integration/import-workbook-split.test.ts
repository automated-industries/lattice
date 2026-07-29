import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
} from '../../src/index.js';
import { importDataFaithfully } from '../../src/gui/import-auto.js';
import {
  dispatchImportRoute,
  readImportSourceFromFile,
  type ImportRouteDeps,
} from '../../src/gui/import-routes.js';
import {
  excelFormulaSummaryForSheet,
  excelImportWarningsForSheet,
  excelToRecords,
} from '../../src/import/excel.js';
import { sheetFileRef } from '../../src/import/sheet-jobs.js';
import { FeedBus } from '../../src/gui/feed.js';

const dirs: string[] = [];
const dbs: Lattice[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
});

async function freshWorkspace(): Promise<{
  db: Lattice;
  configPath: string;
  base: string;
  latticeRoot: string;
}> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-split-'));
  dirs.push(base);
  process.env.LATTICE_ROOT = join(base, '.lattice');
  const root = ensureLatticeRoot(base);
  const ws = addWorkspace(root, { displayName: 'Split' });
  const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
  dbs.push(db);
  return {
    db,
    configPath: resolveWorkspacePaths(root, ws).configPath,
    base,
    latticeRoot: join(base, '.lattice'),
  };
}

/** A synthetic parsed workbook: `n` structurally-distinct sheets (each a small entity),
 *  keyed like `excelToRecords` output so it flows through the importer unchanged. Distinct
 *  per-sheet column names keep the whole-workbook inference from folding them together. */
function syntheticWorkbook(n: number): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    // Non-anonymous, structurally-distinct keys — a `tab_N`/`sheet_N` key would be
    // renamed positionally by the naming ladder, which would obscure what is being tested.
    data['region_' + String(i)] = [
      { id: 0, ['amt_' + String(i)]: 0 },
      { id: 1, ['amt_' + String(i)]: 10 },
    ];
  }
  return data;
}

/** Write a real `n`-sheet .xlsx (each sheet a 2-row table with a distinct value column) and
 *  return its path — for exercising the true excelToRecords → per-sheet apply path. */
async function writeManySheetWorkbook(n: number, dir: string): Promise<string> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  for (let i = 0; i < n; i++) {
    const ws = wb.addWorksheet('Region ' + String(i));
    ws.getRow(1).values = [null, 'id', 'amt_' + String(i)];
    ws.getRow(2).values = [null, 0, 0];
    ws.getRow(3).values = [null, 1, 10];
  }
  const path = join(dir, 'book.xlsx');
  await wb.xlsx.writeFile(path);
  return path;
}

/** Write a real .xlsx from an explicit sheet spec (name + headers + data rows) — for
 *  exercising the true excelToRecords → per-sheet apply path with hand-shaped sheets. */
async function writeWorkbook(
  dir: string,
  sheets: { name: string; headers: string[]; rows: (string | number)[][] }[],
  file = 'book.xlsx',
): Promise<string> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.getRow(1).values = [null, ...s.headers];
    s.rows.forEach((r, i) => {
      ws.getRow(i + 2).values = [null, ...r];
    });
  }
  const path = join(dir, file);
  await wb.xlsx.writeFile(path);
  return path;
}

/** Register a built .xlsx as a retained blob + `files` row, returning the files-row id. */
async function registerXlsxBlob(
  db: Lattice,
  latticeRoot: string,
  builtPath: string,
  fileId: string,
): Promise<string> {
  const blobDir = join(latticeRoot, 'data', 'blobs');
  mkdirSync(blobDir, { recursive: true });
  const blobPath = join(blobDir, fileId + '.xlsx');
  copyFileSync(builtPath, blobPath);
  if (!db.getRegisteredTableNames().includes('files')) {
    await db.defineLate('files', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        original_name: 'TEXT',
        mime: 'TEXT',
        ref_kind: 'TEXT',
        ref_uri: 'TEXT',
        blob_path: 'TEXT',
        deleted_at: 'TEXT',
      },
      primaryKey: 'id',
    });
  }
  await db.insert('files', {
    id: fileId,
    original_name: 'book.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ref_kind: 'blob',
    blob_path: blobPath,
  });
  return fileId;
}

/** A parsed workbook whose `sharedNames` sheets all share ONE column signature (distinct
 *  sheet names, distinct row values), padded with `filler` structurally-distinct sheets so
 *  the total exceeds the per-import table cap and takes the per-sheet split. */
function sharedSchemaWorkbook(sharedNames: string[], filler: number): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  sharedNames.forEach((nm, idx) => {
    data[nm] = [
      { region: 'North', revenue: idx * 10 + 1 },
      { region: 'South', revenue: idx * 10 + 2 },
    ];
  });
  for (let i = 0; i < filler; i++) {
    data['filler_' + String(i)] = [
      { id: 0, ['col_' + String(i)]: 0 },
      { id: 1, ['col_' + String(i)]: 10 },
    ];
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// importDataFaithfully — the explicit executor. A large multi-sheet workbook is
// imported per sheet (no over-cap dead-end); everything else is unchanged.
// ─────────────────────────────────────────────────────────────────────────────
describe('importDataFaithfully: large-workbook per-sheet split', () => {
  it('imports every sheet of a 60-sheet workbook — no cap throw', async () => {
    const { db, configPath } = await freshWorkspace();
    const data = syntheticWorkbook(60);
    const result = await importDataFaithfully(db, configPath, data, { sourceName: 'big.xlsx' });
    expect(result).not.toBeNull();
    // All 60 sheets landed as their own tables (well past the 50-table per-import cap).
    expect(result!.tables.length).toBeGreaterThanOrEqual(60);
    expect(result!.rows).toBe(120); // 60 sheets × 2 rows
    // Every table is distinct (sequential naming across per-sheet jobs never collides).
    expect(new Set(result!.tables).size).toBe(result!.tables.length);
    // Sample sheets are real, queryable tables.
    expect(result!.tables).toContain('region_0');
    expect(result!.tables).toContain('region_59');
    expect(await db.count('region_0')).toBe(2);
    expect(await db.count('region_59')).toBe(2);
  });

  it('leaves a single-sheet workbook on the unchanged whole-source path', async () => {
    const { db, configPath } = await freshWorkspace();
    const data = {
      ledger: [
        { ref: 'A', amount: 1 },
        { ref: 'B', amount: 2 },
      ],
    };
    const result = await importDataFaithfully(db, configPath, data, { sourceName: 'one.xlsx' });
    expect(result?.tables).toEqual(['ledger']);
    expect(result?.rows).toBe(2);
    expect(await db.count('ledger')).toBe(2);
  });

  it('imports a real multi-sheet .xlsx through excelToRecords, every sheet its own table', async () => {
    const { db, configPath, base } = await freshWorkspace();
    const path = await writeManySheetWorkbook(55, base);
    const data = await excelToRecords(path);
    expect(Object.keys(data).length).toBe(55);
    const result = await importDataFaithfully(db, configPath, data, { sourceName: 'book.xlsx' });
    expect(result).not.toBeNull();
    expect(result!.tables.length).toBeGreaterThanOrEqual(55);
    expect(result!.rows).toBe(110); // 55 × 2
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The per-sheet caches + per-sheet file reference — one sheet can be re-read on
// its own, keyed by (path, sheet), and two sheets get distinct references.
// ─────────────────────────────────────────────────────────────────────────────
describe('per-sheet cache accessors + file reference', () => {
  it('excelFormulaSummaryForSheet / excelImportWarningsForSheet slice by (path, sheet)', async () => {
    const { base } = await freshWorkspace();
    const path = await writeManySheetWorkbook(3, base);
    await excelToRecords(path); // populates the (path, sheet) caches
    // A formula-free fixture: each per-sheet slice is either empty or scoped to that one sheet.
    const s0 = excelFormulaSummaryForSheet(path, 'Region 0');
    expect(Object.keys(s0).every((k) => k === 'Region 0')).toBe(true);
    // A sheet that was never in the workbook slices to nothing.
    expect(excelFormulaSummaryForSheet(path, 'Nope')).toEqual({});
    expect(excelImportWarningsForSheet(path, 'Region 0')).toEqual([]);
  });

  it('a per-sheet file reference re-reads exactly one sheet', async () => {
    const { db, base, latticeRoot } = await freshWorkspace();
    const blobDir = join(latticeRoot, 'data', 'blobs');
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, 'book.xlsx');
    const built = await writeManySheetWorkbook(4, base);
    copyFileSync(built, blobPath);
    await db.defineLate('files', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        original_name: 'TEXT',
        mime: 'TEXT',
        ref_kind: 'TEXT',
        ref_uri: 'TEXT',
        blob_path: 'TEXT',
        deleted_at: 'TEXT',
      },
      primaryKey: 'id',
    });
    const fileId = 'f-book';
    await db.insert('files', {
      id: fileId,
      original_name: 'book.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ref_kind: 'blob',
      blob_path: blobPath,
    });
    // Whole-file reference → every sheet.
    const whole = await readImportSourceFromFile(db, fileId, latticeRoot);
    expect(Object.keys(whole.data).length).toBe(4);
    // Per-sheet reference → just that one sheet (and it is the RIGHT one — its unique
    // value column identifies it).
    const one = await readImportSourceFromFile(db, sheetFileRef(fileId, 'Region 2'), latticeRoot);
    expect(Object.keys(one.data)).toEqual(['Region 2']);
    const rows = one.data['Region 2'] as Record<string, unknown>[];
    expect(Object.keys(rows[0]!)).toContain('amt_2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The apply route (/api/import/apply) — a large multi-sheet workbook silently
// imports every sheet instead of dead-ending at the over-cap forced card.
// ─────────────────────────────────────────────────────────────────────────────
function mockReq(body: unknown): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/import/apply';
  return req;
}

function mockRes(): { res: ServerResponse; events: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const res = {
    writeHead() {
      return res;
    },
    write(s: string) {
      chunks.push(s);
      return true;
    },
    end() {
      return res;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    events: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('apply route: large multi-sheet workbook imports per sheet', () => {
  it('materializes all sheets with no error phase (no override needed)', async () => {
    const { db, configPath, base, latticeRoot } = await freshWorkspace();
    const blobDir = join(latticeRoot, 'data', 'blobs');
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, 'book.xlsx');
    const built = await writeManySheetWorkbook(55, base);
    copyFileSync(built, blobPath);
    await db.defineLate('files', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        original_name: 'TEXT',
        mime: 'TEXT',
        ref_kind: 'TEXT',
        ref_uri: 'TEXT',
        blob_path: 'TEXT',
        deleted_at: 'TEXT',
      },
      primaryKey: 'id',
    });
    await db.insert('files', {
      id: 'f-big',
      original_name: 'book.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ref_kind: 'blob',
      blob_path: blobPath,
    });

    const deps: ImportRouteDeps = {
      db,
      configPath,
      latticeRoot,
      validTables: new Set<string>(),
      softDeletable: new Set<string>(),
      feed: new FeedBus(),
    };
    const { res, events } = mockRes();
    // No `override` — this is the silent-import shape. The old behavior forced an
    // over-cap error here; the per-sheet split imports every sheet instead.
    await dispatchImportRoute(mockReq({ fileId: 'f-big', mode: 'both' }), res, deps);

    const evts = events();
    expect(evts.some((e) => e.phase === 'error')).toBe(false);
    const done = evts.find((e) => e.phase === 'done');
    expect(done).toBeDefined();
    const result = done!.result as { rowsByTable: Record<string, number> };
    expect(Object.keys(result.rowsByTable).length).toBeGreaterThanOrEqual(55);
    // Every sheet's rows really landed.
    const total = Object.values(result.rowsByTable).reduce((a, b) => a + b, 0);
    expect(total).toBe(110); // 55 × 2
    // Honest aggregate: the per-sheet path reports how many sheets landed (never "nothing imported").
    expect(
      evts.some(
        (e) =>
          e.phase === 'detect' &&
          typeof e.message === 'string' &&
          /Imported \d+ tables? from \d+ of \d+ sheets?/.test(e.message),
      ),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sibling tabs that share a column signature must stay DISTINCT tables. The per-
// sheet split matches each sheet against the tables that existed BEFORE the
// workbook started — not against a table an earlier sibling just created — so a
// multi-tab book of same-schema tabs is not collapsed into its first tab.
// ─────────────────────────────────────────────────────────────────────────────
describe('per-sheet split: same-schema sibling sheets are not folded together', () => {
  it('keeps monthly/regional tabs that share a signature as their own tables (faithful path)', async () => {
    const { db, configPath } = await freshWorkspace();
    // jan/feb/mar all carry the SAME [region, revenue] signature; 49 fillers push the total
    // past the 50-table cap so the workbook takes the per-sheet split.
    const data = sharedSchemaWorkbook(['jan', 'feb', 'mar'], 49);
    const result = await importDataFaithfully(db, configPath, data, { sourceName: 'book.xlsx' });
    expect(result).not.toBeNull();
    // Each shared-schema sheet is its own table with its own two rows — NOT one table holding
    // all six rows while feb/mar vanish (the collapse this guards against).
    for (const t of ['jan', 'feb', 'mar']) {
      expect(db.getRegisteredTableNames()).toContain(t);
      expect(await db.count(t)).toBe(2);
      expect(result!.tables).toContain(t);
    }
  });

  it('keeps same-signature tabs distinct through the real .xlsx apply route', async () => {
    const { db, configPath, base, latticeRoot } = await freshWorkspace();
    // 3 shared-schema tabs + 49 distinct filler tabs = 52 sheets (> the 50-table cap).
    const sheets: { name: string; headers: string[]; rows: (string | number)[][] }[] = [
      {
        name: 'Jan',
        headers: ['region', 'revenue'],
        rows: [
          ['North', 1],
          ['South', 2],
        ],
      },
      {
        name: 'Feb',
        headers: ['region', 'revenue'],
        rows: [
          ['North', 11],
          ['South', 12],
        ],
      },
      {
        name: 'Mar',
        headers: ['region', 'revenue'],
        rows: [
          ['North', 21],
          ['South', 22],
        ],
      },
    ];
    for (let i = 0; i < 49; i++) {
      sheets.push({
        name: 'Filler ' + String(i),
        headers: ['id', 'col_' + String(i)],
        rows: [
          [0, 0],
          [1, 10],
        ],
      });
    }
    const built = await writeWorkbook(base, sheets);
    const fileId = await registerXlsxBlob(db, latticeRoot, built, 'f-shared');

    const deps: ImportRouteDeps = {
      db,
      configPath,
      latticeRoot,
      validTables: new Set<string>(),
      softDeletable: new Set<string>(),
      feed: new FeedBus(),
    };
    const { res, events } = mockRes();
    await dispatchImportRoute(mockReq({ fileId, mode: 'both' }), res, deps);

    const evts = events();
    expect(evts.some((e) => e.phase === 'error')).toBe(false);
    const result = (
      evts.find((e) => e.phase === 'done')!.result as {
        rowsByTable: Record<string, number>;
      }
    ).rowsByTable;
    // All three same-schema tabs survive as their own tables — the collapse would leave only
    // `jan` holding six rows with feb/mar missing.
    for (const t of ['jan', 'feb', 'mar']) {
      expect(result[t]).toBe(2);
      expect(await db.count(t)).toBe(2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One sheet's runtime failure must NOT sink the whole workbook: the sheets that
// already imported stay, the rest still run, and the failure is surfaced rather
// than the client being told nothing imported.
// ─────────────────────────────────────────────────────────────────────────────
describe('per-sheet split: a single sheet failure is isolated + surfaced', () => {
  /** Pre-create a table with a NOT NULL column the import can't satisfy; a sheet that matches
   *  it by containment will throw on insert — a deterministic single-sheet materialize failure. */
  async function seedFailingTarget(db: Lattice): Promise<void> {
    await db.defineLate('targets', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        ref: 'TEXT',
        val: 'TEXT',
        must_have: 'TEXT NOT NULL',
        deleted_at: 'TEXT',
      },
      primaryKey: 'id',
    });
  }

  it('imports the healthy sheets and reports the failed one (faithful path)', async () => {
    const { db, configPath } = await freshWorkspace();
    await seedFailingTarget(db);
    // `boomtab` matches `targets` (its [ref,val] is contained in [ref,val,must_have]) and
    // fails on insert; 50 distinct `ok_*` sheets push the total past the cap and import fine.
    const data: Record<string, unknown> = {
      boomtab: [
        { ref: 'a', val: 1 },
        { ref: 'b', val: 2 },
      ],
    };
    for (let i = 0; i < 50; i++) {
      data['ok_' + String(i)] = [
        { id: 0, ['n_' + String(i)]: 0 },
        { id: 1, ['n_' + String(i)]: 1 },
      ];
    }
    const result = await importDataFaithfully(db, configPath, data, { sourceName: 'book.xlsx' });
    // The workbook did NOT abort: the 50 healthy sheets landed even though one sheet threw.
    expect(result).not.toBeNull();
    expect(result!.tables).toContain('ok_0');
    expect(result!.tables).toContain('ok_49');
    expect(await db.count('ok_0')).toBe(2);
    // The failing sheet's rows never landed in the target...
    expect(await db.count('targets')).toBe(0);
    // ...and the failure was surfaced (never a silent drop), naming the sheet.
    expect(
      result!.notices.some((n) => n.includes('boomtab') && n.includes('could not be imported')),
    ).toBe(true);
  });

  it('finishes with a warning + done (never a whole-import error) through the apply route', async () => {
    const { db, configPath, base, latticeRoot } = await freshWorkspace();
    await seedFailingTarget(db);
    const sheets: { name: string; headers: string[]; rows: (string | number)[][] }[] = [
      {
        name: 'Boomtab',
        headers: ['ref', 'val'],
        rows: [
          ['a', 1],
          ['b', 2],
        ],
      },
    ];
    for (let i = 0; i < 51; i++) {
      sheets.push({
        name: 'Ok ' + String(i),
        headers: ['id', 'n_' + String(i)],
        rows: [
          [0, 0],
          [1, 1],
        ],
      });
    }
    const built = await writeWorkbook(base, sheets);
    const fileId = await registerXlsxBlob(db, latticeRoot, built, 'f-fail');

    const deps: ImportRouteDeps = {
      db,
      configPath,
      latticeRoot,
      validTables: new Set<string>(),
      softDeletable: new Set<string>(),
      feed: new FeedBus(),
    };
    const { res, events } = mockRes();
    await dispatchImportRoute(mockReq({ fileId, mode: 'both' }), res, deps);

    const evts = events();
    // The whole import did not error out — it completed with a done frame carrying the
    // sheets that landed, plus a warning naming the sheet that failed.
    expect(evts.some((e) => e.phase === 'error')).toBe(false);
    expect(
      evts.some(
        (e) =>
          e.phase === 'warning' &&
          typeof e.message === 'string' &&
          /Boomtab/i.test(e.message) &&
          e.message.includes('could not be imported'),
      ),
    ).toBe(true);
    const done = evts.find((e) => e.phase === 'done');
    expect(done).toBeDefined();
    const result = done!.result as { rowsByTable: Record<string, number> };
    // The 51 healthy sheets landed; the failing one is absent from the target.
    expect(Object.keys(result.rowsByTable).length).toBeGreaterThanOrEqual(51);
    expect(await db.count('targets')).toBe(0);
    // The honest aggregate also names the sheet that could not be imported — never a silent drop.
    expect(
      evts.some(
        (e) =>
          e.phase === 'detect' &&
          typeof e.message === 'string' &&
          /could not be imported:.*Boomtab/i.test(e.message),
      ),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The assistant import_spreadsheet path reads the file THEN materializes; it must
// forward the source's original name so a large multi-sheet .xlsx splits per sheet
// instead of dead-ending on the over-cap refusal. This pins the read → materialize
// composition the server wiring performs.
// ─────────────────────────────────────────────────────────────────────────────
describe('read → faithful-import composition forwards the source name', () => {
  it('splits a >50-sheet workbook when the name is forwarded, and would dead-end without it', async () => {
    const { db, configPath, base, latticeRoot } = await freshWorkspace();
    const built = await writeManySheetWorkbook(55, base);
    const fileId = await registerXlsxBlob(db, latticeRoot, built, 'f-name');

    // The read hands back BOTH the parsed data and the original name.
    const read = await readImportSourceFromFile(db, fileId, latticeRoot);
    expect(read.name).toBe('book.xlsx');

    // Dropping the name (the regressed wiring) leaves sourceName='' → the split guard is
    // skipped → the over-cap refusal fires.
    await expect(importDataFaithfully(db, configPath, read.data)).rejects.toThrow(/safe limit/);

    // Forwarding the name (the correct wiring) takes the per-sheet split → every sheet lands.
    const result = await importDataFaithfully(db, configPath, read.data, { sourceName: read.name });
    expect(result).not.toBeNull();
    expect(result!.tables.length).toBeGreaterThanOrEqual(55);
    expect(result!.rows).toBe(110); // 55 × 2
  });
});
