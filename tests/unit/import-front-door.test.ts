import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Lattice } from '../../src/index.js';
import { openConfig, type ActiveDb } from '../../src/gui/server.js';
import {
  buildImportPlan,
  documentsKeptAsFilesNotice,
  type BuildImportPlanInput,
} from '../../src/import/front-door.js';
import { checkSourceIsDuplicate } from '../../src/import/duplicate-source.js';
import { planSourceFor } from '../../src/import/plan-source.js';
import { autoImportStructured, importDataFaithfully } from '../../src/gui/import-auto.js';
import { isGenericTableName } from '../../src/gui/model-contract.js';

/**
 * The single import front door. Every import path builds its plan here, so
 * naming and the star-schema contract cannot be bypassed by whichever caller
 * happens to run; the same entry point also reports the outcomes that used to
 * be invisible (a rejected table, a degraded document pass).
 */

const dirs: string[] = [];
const actives: ActiveDb[] = [];
afterEach(() => {
  for (const a of actives.splice(0)) a.db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A real workspace: the `files` native entity has to exist, because the
 *  duplicate check reads its content hash. */
async function freshWorkspace(): Promise<{ db: Lattice; configPath: string; base: string }> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-frontdoor-'));
  dirs.push(base);
  mkdirSync(join(base, 'data'), { recursive: true });
  const configPath = join(base, 'lattice.config.yml');
  writeFileSync(configPath, 'db: ./data/test.db\n\nentities: {}\n', 'utf8');
  const active = await openConfig(configPath, join(base, 'context'), false);
  actives.push(active);
  await active.converged;
  return { db: active.db, configPath, base };
}

const INVOICES = [
  { invoice_no: 'A1', customer: 'Acme', amount: 10 },
  { invoice_no: 'A2', customer: 'Borden', amount: 20 },
  { invoice_no: 'A3', customer: 'Cortez', amount: 30 },
];

const PAYMENTS = [
  { payment_ref: 'P1', payer: 'Acme', settled_on: '2026-01-04' },
  { payment_ref: 'P2', payer: 'Borden', settled_on: '2026-01-11' },
  { payment_ref: 'P3', payer: 'Cortez', settled_on: '2026-01-18' },
];

/** `count` record sets with disjoint column names, so nothing dedupes together. */
function distinctSets(count: number): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    data['set ' + String(i)] = [
      { ['ref' + String(i)]: 'a' + String(i), ['qty' + String(i)]: 1 },
      { ['ref' + String(i)]: 'b' + String(i), ['qty' + String(i)]: 2 },
    ];
  }
  return data;
}

function input(over: Partial<BuildImportPlanInput> = {}): BuildImportPlanInput {
  return {
    data: { invoices: INVOICES },
    source: planSourceFor('ledger.json'),
    ...over,
  };
}

describe('buildImportPlan — the shape gate', () => {
  it('admits a well-formed table and reports no problems', async () => {
    const r = await buildImportPlan(input());
    expect(r.plan.entities.map((e) => e.name)).toEqual(['invoices']);
    expect(r.admission.rejected).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.tableCount).toBeGreaterThanOrEqual(1);
    expect(r.overCap).toBe(false);
  });

  it('drops a shapeless table extracted from a document and names the condition', async () => {
    const r = await buildImportPlan(
      input({
        data: { Agenda: [{ item: 'Welcome' }] },
        source: planSourceFor('board-pack.docx'),
      }),
    );
    expect(r.plan.entities).toEqual([]);
    expect(r.dropped).toEqual(['agenda']);
    const rejected = r.admission.rejected[0];
    expect(rejected?.failed).toEqual(['C2', 'C3']);
    expect(r.notices.join(' ')).toContain('C2');
    expect(r.notices.join(' ')).toContain('agenda');
  });

  it('reports — but does not drop — a thin table from a spreadsheet', async () => {
    // A spreadsheet column stripped down to one field by dimension extraction is
    // a legitimate table; only a document fan-out is refused on shape.
    const r = await buildImportPlan(
      input({ data: { Prices: [{ price: 1 }] }, source: planSourceFor('prices.xlsx') }),
    );
    expect(r.plan.entities.map((e) => e.name)).toEqual(['prices']);
    expect(r.dropped).toEqual([]);
    expect(r.admission.reported[0]?.failed).toEqual(['C2', 'C3']);
    expect(r.notices.join(' ')).toContain('C2');
  });

  it('drops an unnameable table on every source kind (the naming backstop)', async () => {
    // Nothing should reach the gate anonymous — naming runs first — so this is a
    // backstop, exercised by handing the gate a table it cannot rename.
    const r = await buildImportPlan(
      input({ data: { Sheet1: INVOICES }, source: planSourceFor('untitled.xlsx') }),
    );
    // Named from the file, which itself is generic: falls back to the generic label.
    for (const e of r.plan.entities) expect(isGenericTableName(e.name)).toBe(false);
  });

  it('exempts a table already registered in the workspace from the gate', async () => {
    const r = await buildImportPlan(
      input({
        data: { Agenda: [{ item: 'Welcome' }] },
        source: planSourceFor('board-pack.docx'),
        registered: ['agenda'],
      }),
    );
    expect(r.dropped).toEqual([]);
    expect(r.plan.entities.map((e) => e.name)).toEqual(['agenda']);
  });

  it('flags a plan over the table cap rather than silently materializing it', async () => {
    const r = await buildImportPlan(input({ data: distinctSets(6), maxTables: 3 }));
    expect(r.tableCount).toBe(6);
    expect(r.overCap).toBe(true);
    expect(r.notices.join(' ')).toContain('over the safe limit of 3');
  });

  it('does not flag a plan inside the cap', async () => {
    const r = await buildImportPlan(input({ data: distinctSets(3), maxTables: 3 }));
    expect(r.overCap).toBe(false);
  });
});

describe('buildImportPlan — naming', () => {
  it('resolves anonymous source keys before inference ever sees them', async () => {
    const r = await buildImportPlan(
      input({
        data: { Sheet1: INVOICES, Sheet2: PAYMENTS },
        source: planSourceFor('Q3 Report.xlsx'),
      }),
    );
    expect(r.plan.entities.map((e) => e.name)).toEqual(['q3_report', 'q3_report_2']);
    for (const e of r.plan.entities) expect(isGenericTableName(e.name)).toBe(false);
  });

  it('returns the renamed source data so materialize reads the same keys', async () => {
    const r = await buildImportPlan(
      input({ data: { Sheet1: INVOICES }, source: planSourceFor('Q3 Report.xlsx') }),
    );
    expect(Object.keys(r.data)).toEqual(['Q3 Report']);
    expect(r.plan.entities[0]?.sourceKey).toBe('Q3 Report');
  });

  it('reports that the name assist was unavailable instead of hiding it', async () => {
    const r = await buildImportPlan(
      input({
        data: { Sheet1: INVOICES, Sheet2: PAYMENTS },
        source: planSourceFor('Q3 Report.xlsx'),
      }),
    );
    expect(r.naming.assistUnavailable).toBe(true);
    expect(r.notices.join(' ')).toContain('positional');
  });
});

describe('buildImportPlan — provider-free degradation', () => {
  it('reports documents kept as files when no model provider is configured', async () => {
    const r = await buildImportPlan(input({ documentsKeptAsFiles: 3, extractionAvailable: false }));
    expect(r.notices).toContain('Kept 3 documents as files - connect a model to extract them');
  });

  it('uses the singular form for one document', () => {
    expect(documentsKeptAsFilesNotice(1)).toBe(
      'Kept 1 document as a file - connect a model to extract it',
    );
  });

  it('says nothing when extraction is available, or when nothing was skipped', async () => {
    const withProvider = await buildImportPlan(
      input({ documentsKeptAsFiles: 3, extractionAvailable: true }),
    );
    expect(withProvider.notices.join(' ')).not.toContain('connect a model');
    const nothingSkipped = await buildImportPlan(
      input({ documentsKeptAsFiles: 0, extractionAvailable: false }),
    );
    expect(nothingSkipped.notices.join(' ')).not.toContain('connect a model');
  });
});

describe('duplicate source detection runs before any import work', () => {
  it('recognizes a re-added file and does NOT re-import it', async () => {
    const { db, configPath, base } = await freshWorkspace();
    const csv = join(base, 'people.csv');
    writeFileSync(csv, 'name,role\nAda,eng\nGrace,eng\nAlan,eng\n');
    const sha256 = createHash('sha256')
      .update('name,role\nAda,eng\nGrace,eng\nAlan,eng\n')
      .digest('hex');

    // First drop: brand-new structured data, so the importer claims it.
    const first = await autoImportStructured(db, configPath, csv, 'people.csv');
    expect(first?.reason).toBe('new-dataset');

    // The file is now in the workspace under the same bytes.
    await db.insert('files', { original_name: 'people.csv', sha256 });

    const check = await checkSourceIsDuplicate(db, csv);
    expect(check.available).toBe(true);
    expect(check.sha256).toBe(sha256);
    expect(check.duplicateOfFileId).toBeTruthy();

    const before = db.getRegisteredTableNames().length;
    const again = await autoImportStructured(db, configPath, csv, 'people.csv');
    expect(again).toBeNull();
    expect(db.getRegisteredTableNames().length).toBe(before);
  });

  it('reports the check as unavailable rather than guessing when there is nothing to match on', async () => {
    const { db, base } = await freshWorkspace();
    const csv = join(base, 'other.csv');
    writeFileSync(csv, 'a,b\n1,2\n');
    const check = await checkSourceIsDuplicate(db, csv, { table: 'no_such_table' });
    expect(check.available).toBe(false);
    expect(check.duplicateOfFileId).toBeNull();
  });
});

describe('the import paths route through the front door', () => {
  it('the passive-drop door names anonymous sheets through the resolver', async () => {
    const { db, configPath, base } = await freshWorkspace();
    const json = join(base, 'Q3 Report.json');
    writeFileSync(json, JSON.stringify({ Sheet1: INVOICES }));
    const r = await autoImportStructured(db, configPath, json, 'Q3 Report.json');
    expect(r?.plan?.entities.map((e) => e.name)).toEqual(['q3_report']);
  });

  it('the explicit-import door applies the gate and reports its outcomes', async () => {
    const { db, configPath } = await freshWorkspace();
    const r = await importDataFaithfully(
      db,
      configPath,
      { table_1: INVOICES },
      { sourceName: 'Holdings.xlsx' },
    );
    expect(r?.tables).toEqual(['holdings']);
    expect(r?.notices).toEqual([]);
    expect(db.getRegisteredTableNames()).toContain('holdings');
  });

  it('the explicit-import door refuses a shapeless document table loudly', async () => {
    const { db, configPath } = await freshWorkspace();
    // Every table the gate saw was refused: an explicit "import this" that ends
    // up importing nothing must say why, not report a clean no-op.
    await expect(
      importDataFaithfully(
        db,
        configPath,
        { Agenda: [{ item: 'Welcome' }] },
        {
          sourceName: 'board-pack.docx',
        },
      ),
    ).rejects.toThrow(/agenda/i);
    expect(db.getRegisteredTableNames()).not.toContain('agenda');
  });

  it('the explicit-import door still reports nothing-to-import as nothing', async () => {
    const { db, configPath } = await freshWorkspace();
    const r = await importDataFaithfully(
      db,
      configPath,
      { note: 'not a record set' },
      {
        sourceName: 'notes.json',
      },
    );
    expect(r).toBeNull();
  });
});
