import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
  inferSchema,
  materializeImport,
} from '../../src/index.js';
import { autoImportStructured } from '../../src/gui/import-auto.js';

const dirs: string[] = [];
const dbs: Lattice[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
});

function doc() {
  return {
    funds: [
      { code: 'EP', name: 'Early Plays', vintage: 1999, fundSize: 100 },
      { code: 'GG', name: 'Global Growth', vintage: 2022, fundSize: 200 },
    ],
    investments: [
      { company: 'Acme', invested: 5, region: 'Europe' },
      { company: 'Beta', invested: 8, region: 'Asia' },
    ],
  };
}

async function freshWorkspace(): Promise<{ db: Lattice; configPath: string; base: string }> {
  const base = mkdtempSync(join(tmpdir(), 'lattice-auto-'));
  dirs.push(base);
  process.env.LATTICE_ROOT = join(base, '.lattice');
  const root = ensureLatticeRoot(base);
  const ws = addWorkspace(root, { displayName: 'Auto' });
  const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
  dbs.push(db);
  return { db, configPath: resolveWorkspacePaths(root, ws).configPath, base };
}

describe('autoImportStructured (assistant-door smart import)', () => {
  it('auto-imports a recognized new period as a dated snapshot', async () => {
    const { db, configPath, base } = await freshWorkspace();
    await materializeImport({ db, configPath }, doc(), inferSchema(doc()), [], {
      asOf: '2025-06-30',
    });

    // A drop whose name carries the period → recognized + dated automatically.
    const p = join(base, 'Track Record 3.31.2026.json');
    writeFileSync(p, JSON.stringify(doc()));
    const r = await autoImportStructured(db, configPath, p, 'Track Record 3.31.2026.json');
    expect(r?.imported).toBe(true);
    expect(r?.asOf).toBe('2026-03-31');
    expect(r?.matchedCount).toBe(2);
    expect(await db.count('funds')).toBe(4); // snapshot appended, not overwritten
  });

  // Regression: a materialized entity's overview must land in the hidden
  // .schema-only/ dir, NOT as a bare <NAME>.md at the Context ROOT. A root file is
  // an orphan — it clutters the visible Markdown tree and duplicates the per-row
  // <Entity>/ context dir. (The bug set outputFile = name.toUpperCase()+'.md'.)
  it('persists imported entities with a .schema-only/ overview, never a root <NAME>.md orphan', async () => {
    const { configPath } = await freshWorkspace();
    await materializeImport(
      { db: dbs[dbs.length - 1]!, configPath },
      doc(),
      inferSchema(doc()),
      [],
      {
        asOf: '2025-06-30',
      },
    );
    const cfg = readFileSync(configPath, 'utf8');
    // Every entity overview path is under .schema-only/ …
    expect(cfg).toMatch(/outputFile:\s*\.schema-only\/funds\.md/);
    expect(cfg).toMatch(/outputFile:\s*\.schema-only\/investments\.md/);
    // … and NOT a bare uppercase root file (the orphan the bug produced).
    expect(cfg).not.toMatch(/outputFile:\s*FUNDS\.md/);
    expect(cfg).not.toMatch(/outputFile:\s*INVESTMENTS\.md/);
  });

  it('surfaces a brand-new structured drop as a new-dataset proposal (no silent create)', async () => {
    const { db, configPath, base } = await freshWorkspace();
    await materializeImport({ db, configPath }, doc(), inferSchema(doc()), [], {
      asOf: '2025-06-30',
    });
    const p = join(base, 'orders.json');
    writeFileSync(p, JSON.stringify({ orders: [{ order_id: 1, sku: 'X', qty: 3, buyer: 'Bob' }] }));
    const r = await autoImportStructured(db, configPath, p, 'orders.json');
    // Structured but not a known dataset → propose, never silently create.
    expect(r?.imported).toBe(false);
    expect(r?.reason).toBe('new-dataset');
    expect(r?.plan?.entities.length).toBeGreaterThan(0); // a proposal to confirm
    expect(r?.schemaMatch?.isKnownDocument).toBe(false);
    expect(db.getRegisteredTableNames()).not.toContain('orders'); // created only on Apply
  });

  it('leaves a truly-unstructured file as a plain reference (null)', async () => {
    const { db, configPath, base } = await freshWorkspace();
    const p = join(base, 'note.json'); // valid JSON but no record arrays → 0 entities
    writeFileSync(p, JSON.stringify({ greeting: 'hi', count: 3 }));
    const r = await autoImportStructured(db, configPath, p, 'note.json');
    expect(r).toBeNull();
  });

  it('flags a matched document with no detectable date instead of overwriting', async () => {
    const { db, configPath, base } = await freshWorkspace();
    await materializeImport({ db, configPath }, doc(), inferSchema(doc()), [], {
      asOf: '2025-06-30',
    });
    const p = join(base, 'book.json'); // no date in name, no date in content
    writeFileSync(p, JSON.stringify(doc()));
    const r = await autoImportStructured(db, configPath, p, 'book.json');
    expect(r?.imported).toBe(false);
    expect(r?.reason).toBe('needs-confirm');
    expect(r?.plan?.entities.length).toBeGreaterThan(0); // full proposal present
    expect(await db.count('funds')).toBe(2); // untouched — no silent overwrite
  });
});
