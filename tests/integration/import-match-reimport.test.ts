import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
  inferSchema,
  materializeImport,
  matchSchemaToExisting,
  NATIVE_ENTITY_NAMES,
  type ExistingTable,
} from '../../src/index.js';

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

/** Mirror the server's existingDataTables() helper against a live db. */
function existingDataTables(db: Lattice): ExistingTable[] {
  const native = new Set<string>(NATIVE_ENTITY_NAMES);
  const out: ExistingTable[] = [];
  for (const t of db.getRegisteredTableNames()) {
    if (native.has(t)) continue;
    const columns = Object.keys(db.getRegisteredColumns(t) ?? {});
    if (columns.length > 0) out.push({ name: t, columns });
  }
  return out;
}

describe('import: recognize a re-upload as a new period of an existing document', () => {
  it('matches a second-period upload against the tables created by the first', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-reimport-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'Reimport' });
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    dbs.push(db);
    const configPath = resolveWorkspacePaths(root, ws).configPath;

    // First period establishes the document (as a dated snapshot).
    await materializeImport({ db, configPath }, doc(), inferSchema(doc()), [], { asOf: '2025-06-30' });

    // A second upload of the same shape is recognized as the same document.
    const match = matchSchemaToExisting(existingDataTables(db), inferSchema(doc()));
    expect(match.isKnownDocument).toBe(true);
    expect(match.matches.find((m) => m.from === 'funds')?.to).toBe('funds');
    expect(match.matches.find((m) => m.from === 'investments')?.to).toBe('investments');

    // Importing it at a new date appends a snapshot into those same tables.
    await materializeImport({ db, configPath }, doc(), inferSchema(doc()), [], { asOf: '2026-03-31' });
    expect(await db.count('funds')).toBe(4); // 2 funds × 2 periods
    expect(await db.count('investments')).toBe(4);
  });
});
