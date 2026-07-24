import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
  inferSchema,
  materializeImport,
} from '../../src/index.js';
import { autoImportStructured, importDataFaithfully } from '../../src/gui/import-auto.js';
import { readImportSourceFromFile } from '../../src/gui/import-routes.js';
import { matchSchemaToExisting } from '../../src/import/match.js';
import { applySourceNameFallback, isAnonymousName } from '../../src/import/name-policy.js';
import { normalizeName } from '../../src/import/infer-core.js';
import { openConfig, type ActiveDb } from '../../src/gui/server.js';
import { createUserEntity } from '../../src/gui/schema-ops.js';

/**
 * "No anonymous tables, ever" — the naming ladder at the source, the shared
 * shape gate as a materialize pre-flight, the assistant's rejected create call,
 * and the corrective match decline, exercised through the real doors.
 */

const dirs: string[] = [];
const dbs: Lattice[] = [];
const actives: ActiveDb[] = [];
afterEach(() => {
  for (const a of actives.splice(0)) a.db.close();
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
});

async function freshWorkspace(): Promise<{ db: Lattice; configPath: string; base: string }> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-namegate-'));
  dirs.push(base);
  process.env.LATTICE_ROOT = join(base, '.lattice');
  const root = ensureLatticeRoot(base);
  const ws = addWorkspace(root, { displayName: 'NameGate' });
  const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
  dbs.push(db);
  return { db, configPath: resolveWorkspacePaths(root, ws).configPath, base };
}

/** A real .docx (zip container) whose document.xml holds `tables` unnamed tables. */
function buildDocx(tables: string[][][]): Uint8Array {
  const tbl = (rows: string[][]): string =>
    '<w:tbl>' +
    rows
      .map(
        (r) =>
          '<w:tr>' +
          r.map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join('') +
          '</w:tr>',
      )
      .join('') +
    '</w:tbl>';
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document><w:body>' +
    tables.map(tbl).join('<w:p><w:r><w:t>Some connecting prose between tables.</w:t></w:r></w:p>') +
    '</w:body></w:document>';
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    ),
    'word/document.xml': strToU8(documentXml),
  });
}

/** The reported regression's shape: 7 unnamed tables with DISTINCT column sets. */
function sevenTableDocx(): Uint8Array {
  const mk = (cols: string[], n: number): string[][] => [
    cols,
    ...Array.from({ length: n }, (_, i) => cols.map((c) => `${c}-${String(i)}`)),
  ];
  return buildDocx([
    mk(['Program', 'Owner'], 3),
    mk(['City', 'Population'], 4),
    mk(['Metric', 'Q1', 'Q2'], 3),
    mk(['Vendor', 'Amount'], 5),
    mk(['Course', 'Credits'], 3),
    mk(['Device', 'Serial'], 2),
    mk(['Site', 'Region', 'Lead'], 3),
  ]);
}

describe('the reported regression — a .docx with exactly 7 unnamed tables', () => {
  it('proposes ZERO anonymous table names (the off-by-one that slipped fanout >= 8)', async () => {
    const { db, configPath, base } = await freshWorkspace();
    const p = join(base, 'Program Review.docx');
    writeFileSync(p, sevenTableDocx());
    const r = await autoImportStructured(db, configPath, p, 'Program Review.docx');
    expect(r).not.toBeNull();
    expect(r?.reason).toBe('new-dataset');
    const names = (r?.plan?.entities ?? []).map((e) => e.name);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(isAnonymousName(normalizeName(n)), `proposed name "${n}" is anonymous`).toBe(false);
      expect(n).not.toMatch(/^table_?\d+$/i);
    }
  });

  it('materializes zero table_N tables end-to-end (faithful path)', async () => {
    const { db, configPath, base } = await freshWorkspace();
    const p = join(base, 'Program Review.docx');
    writeFileSync(p, sevenTableDocx());
    // Same read the import_spreadsheet tool performs, then the faithful materialize.
    const { docxToRecords } = await import('../../src/gui/ai/doc/doc-tables.js');
    const data = await docxToRecords(p, 'Program Review.docx');
    const result = await importDataFaithfully(db, configPath, data);
    expect(result).not.toBeNull();
    const registered = db.getRegisteredTableNames();
    expect(registered.filter((t) => /^table_?\d+$/i.test(t))).toEqual([]);
    expect(registered.filter((t) => isAnonymousName(normalizeName(t)))).toEqual([]);
    // Every row still landed somewhere.
    expect(result?.rows).toBeGreaterThanOrEqual(23); // 3+4+3+5+3+2+3 source rows
  });
});

describe('doors parity — the proposal door and the apply door name identically', () => {
  it('readImportSourceFromFile (apply, via original_name) matches the upload read', async () => {
    const { db, base } = await freshWorkspace();
    const latticeRoot = join(base, '.lattice');
    // Retained-blob shape: bytes under the workspace root, named by content hash.
    const blobDir = join(latticeRoot, 'data', 'blobs');
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, 'deadbeef.docx');
    writeFileSync(blobPath, sevenTableDocx());
    // Minimal files table with the columns the apply door reads (the bare
    // workspace harness doesn't materialize the native files schema).
    await db.defineLate('files', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        original_name: 'TEXT',
        mime: 'TEXT',
        ref_kind: 'TEXT',
        ref_uri: 'TEXT',
        blob_path: 'TEXT',
        deleted_at: 'TEXT',
      },
      primaryKey: 'id',
    });
    const fileId = 'f-doors-parity';
    await db.insert('files', {
      id: fileId,
      name: 'Program Review',
      original_name: 'Program Review.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ref_kind: 'blob',
      blob_path: blobPath,
    });
    // Door 2 (apply route): reads the row's original_name and passes it to the reader.
    const applyRead = await readImportSourceFromFile(db, fileId, latticeRoot);
    // Door 1 (upload proposal): passes the upload's `name` to the same reader.
    const { docxToRecords } = await import('../../src/gui/ai/doc/doc-tables.js');
    const uploadRead = await docxToRecords(blobPath, 'Program Review.docx');
    expect(Object.keys(applyRead.data).sort()).toEqual(Object.keys(uploadRead).sort());
    // And neither door produced an anonymous key.
    for (const k of Object.keys(applyRead.data)) {
      expect(isAnonymousName(normalizeName(k))).toBe(false);
    }
  });
});

describe('materialize pre-flight — filter, report, never a partial write', () => {
  it('drops an anonymous entity, keeps the good one, and reports the skip', async () => {
    const { db, configPath } = await freshWorkspace();
    // A raw JSON source can still carry an anonymous top-level key (the ladder only
    // fixes documents) — the pre-flight is the backstop for every source kind.
    const data = {
      'Table 1': [
        { alpha: 'a', beta: 'b' },
        { alpha: 'c', beta: 'd' },
      ],
      invoices: [
        { vendor: 'Acme', amount: 10 },
        { vendor: 'Beta', amount: 20 },
      ],
    };
    const messages: string[] = [];
    const result = await materializeImport({ db, configPath }, data, inferSchema(data), [], {
      onProgress: (p) => {
        messages.push(p.message);
      },
    });
    expect(db.getRegisteredTableNames()).toContain('invoices');
    expect(db.getRegisteredTableNames()).not.toContain('table_1');
    expect(result.tablesCreated).not.toContain('table_1');
    expect(await db.count('invoices')).toBe(2);
    // The skip is reported through the existing import report, not silent.
    expect(messages.join(' ')).toMatch(/anonymous table name/i);
  });

  it('exempts an already-registered anonymous table (5.1.x workspaces keep working)', async () => {
    const { db, configPath } = await freshWorkspace();
    // A workspace 5.1.x already seeded with table_1 — a re-import must not fail it.
    await db.defineLate('table_1', {
      columns: { id: 'TEXT PRIMARY KEY', alpha: 'TEXT', beta: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'id',
    });
    const data = {
      'Table 1': [
        { alpha: 'a', beta: 'b' },
        { alpha: 'c', beta: 'd' },
      ],
    };
    await materializeImport({ db, configPath }, data, inferSchema(data));
    expect(await db.count('table_1')).toBe(2); // rows landed in the existing table
  });

  it('folds a rejected dimension back to a plain column — values are never lost', async () => {
    const { db, configPath } = await freshWorkspace();
    // A categorical column whose normalized name is anonymous ("Sheet1" as a column
    // header — pathological but possible). The dimension is refused; the VALUES must
    // survive as a plain text column on the entity.
    const rows = Array.from({ length: 12 }, (_, i) => ({
      item: 'Item ' + String(i),
      Sheet1: i % 2 === 0 ? 'Even' : 'Odd',
    }));
    const data = { inventory: rows };
    const plan = inferSchema(data);
    // Confirm the fixture actually infers the anonymous-named dimension.
    expect(plan.dimensions.map((d) => d.name)).toContain('sheet1');
    await materializeImport({ db, configPath }, data, plan);
    expect(db.getRegisteredTableNames()).not.toContain('sheet1'); // no dimension table
    const inv = await db.query('inventory');
    expect(inv).toHaveLength(12);
    // The values came through on the entity itself.
    expect(new Set(inv.map((r) => r.sheet1))).toEqual(new Set(['Even', 'Odd']));
  });
});

describe('faithful path — the shared table cap', () => {
  it('refuses an import that would create more tables than MAX_IMPORT_TABLES', async () => {
    const { db, configPath } = await freshWorkspace();
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 55; i++) {
      many['dataset_' + String(i)] = [
        { ref: 'a' + String(i), val: i },
        { ref: 'b' + String(i), val: i + 1 },
      ];
    }
    await expect(importDataFaithfully(db, configPath, many)).rejects.toThrow(/safe limit/);
    // Nothing was created — the cap fires before materialize.
    expect(db.getRegisteredTableNames().filter((t) => t.startsWith('dataset_'))).toEqual([]);
  });
});

describe('createUserEntity — rejectAnonymous is scoped to ingest/chat callers', () => {
  async function boot(): Promise<ActiveDb> {
    const root = mkdtempSync(join(tmpdir(), 'lattice-namegate-active-'));
    dirs.push(root);
    mkdirSync(join(root, 'data'), { recursive: true });
    const configPath = join(root, 'lattice.config.yml');
    writeFileSync(
      configPath,
      [
        'db: ./data/test.db',
        '',
        'entities:',
        '  people:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '      deleted_at: { type: text }',
        '    outputFile: people.md',
        '',
      ].join('\n'),
      'utf8',
    );
    const active = await openConfig(configPath, join(root, 'context'), false);
    actives.push(active);
    await active.converged;
    return active;
  }

  it('rejects an anonymous name with the opt set; accepts the same name without it', async () => {
    const active = await boot();
    expect(
      await createUserEntity(active, 'table_9', ['alpha'], 'sess', { rejectAnonymous: true }),
    ).toBeNull();
    // The manual data-model route sets no opt — a user may type what they like.
    expect(await createUserEntity(active, 'table_9', ['alpha'], 'sess')).toBe('table_9');
  });

  it('still returns an EXISTING anonymous table (reuse precedes the check)', async () => {
    const active = await boot();
    expect(await createUserEntity(active, 'sheet1', ['alpha'], 'sess')).toBe('sheet1');
    // A later ingest call against the same name reuses rather than refuses.
    expect(
      await createUserEntity(active, 'sheet1', ['alpha'], 'sess', { rejectAnonymous: true }),
    ).toBe('sheet1');
  });

  it('accepts a meaningful name with the opt set', async () => {
    const active = await boot();
    expect(
      await createUserEntity(active, 'invoices', ['amount'], 'sess', { rejectAnonymous: true }),
    ).toBe('invoices');
  });
});

describe('the Sheet1 backstop — default-named sources still import in full', () => {
  it('a JSON drop keyed by an anonymous name imports under the file-derived name', async () => {
    // The regression the review caught: without the source-name fallback, the
    // pre-flight refused a default-named source outright and ZERO rows landed.
    const { db, configPath, base } = await freshWorkspace();
    const p = join(base, 'Q3 Budget.json');
    writeFileSync(
      p,
      JSON.stringify({
        Sheet1: [
          { region: 'East', revenue: 10 },
          { region: 'West', revenue: 20 },
        ],
      }),
    );
    const r = await autoImportStructured(db, configPath, p, 'Q3 Budget.json');
    expect(r?.reason).toBe('new-dataset');
    const names = (r?.plan?.entities ?? []).map((e) => e.name);
    expect(names).toEqual(['q3_budget']); // file-derived, not sheet1, not dropped
    // And the faithful path materializes every row under that name.
    const data = applySourceNameFallback(
      {
        Sheet1: [
          { region: 'East', revenue: 10 },
          { region: 'West', revenue: 20 },
        ],
      },
      'Q3 Budget.json',
    );
    const result = await importDataFaithfully(db, configPath, data);
    expect(result?.tables).toContain('q3_budget');
    expect(await db.count('q3_budget')).toBe(2);
  });
});

describe('views ride the pre-flight — no mid-loop throw on a dropped master', () => {
  it('skips a view whose master was dropped instead of throwing after partial writes', async () => {
    const { db, configPath } = await freshWorkspace();
    // Hand-built plan: one good entity plus a view over an anonymous (dropped)
    // master — the shape a crafted/legacy caller could still hand materialize.
    const data = {
      'Table 1': [
        { alpha: 'a', kind: 'x' },
        { alpha: 'b', kind: 'y' },
      ],
      invoices: [
        { vendor: 'Acme', amount: 10 },
        { vendor: 'Beta', amount: 20 },
      ],
    };
    const plan = inferSchema(data);
    const views = [
      { name: 'x_rows', master: 'table_1', filterColumn: 'kind', filterValue: 'x', matchedRows: 1 },
    ];
    // Must complete — never a mid-loop throw that leaves a half-built model.
    const result = await materializeImport({ db, configPath }, data, plan, views);
    expect(result.views).toEqual([]); // the orphaned view was skipped, reported
    expect(db.getRegisteredTableNames()).toContain('invoices');
    expect(db.getRegisteredTableNames()).not.toContain('x_rows');
    expect(await db.count('invoices')).toBe(2);
  });
});

describe('match — anonymous names never short-circuit onto an unrelated table', () => {
  it('declines the name-equality shortcut for table_N; containment still applies', async () => {
    const { db, configPath, base } = await freshWorkspace();
    // A 5.1.x leftover: table_3 with its own columns.
    await db.defineLate('table_3', {
      columns: { id: 'TEXT PRIMARY KEY', alpha: 'TEXT', beta: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'id',
    });
    await db.insert('table_3', { alpha: 'x', beta: 'y' });
    // A JSON drop whose key also normalizes to table_3 but shares NO columns.
    const p = join(base, 'other.json');
    writeFileSync(
      p,
      JSON.stringify({
        'Table 3': [
          { gamma: 'g1', delta: 'd1' },
          { gamma: 'g2', delta: 'd2' },
        ],
      }),
    );
    const r = await autoImportStructured(db, configPath, p, 'other.json');
    // Without the decline, name equality alone made this a "known document" and the
    // unrelated rows would merge into table_3. Now it must be a fresh proposal.
    expect(r?.imported).toBe(false);
    expect(r?.schemaMatch?.isKnownDocument).toBeFalsy();
    expect(await db.count('table_3')).toBe(1); // untouched
  });

  it('an anonymous 5.1.x table still EARNS the match on column containment', () => {
    // The corrective half: a leftover table_3 with the SAME columns as the new
    // upload is genuinely the same dataset — containment (not name equality)
    // recognizes it, so the re-import lands in the existing table.
    const match = matchSchemaToExisting(
      [{ name: 'table_3', columns: ['id', 'alpha', 'beta', 'deleted_at'] }],
      inferSchema({
        rates: [
          { alpha: 'x', beta: 'y' },
          { alpha: 'p', beta: 'q' },
        ],
      }),
    );
    expect(match.matches).toHaveLength(1);
    expect(match.matches[0]).toMatchObject({ from: 'rates', to: 'table_3' });
    expect(match.rename).toEqual({ rates: 'table_3' });
  });
});
