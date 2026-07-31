import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { runImportCommand } from '../../src/cli-import.js';
import { openConfig, disposeActive } from '../../src/gui/lifecycle.js';
import { importDataFaithfully } from '../../src/gui/import-auto.js';

/**
 * An import brings in tables and rows nobody was asked to approve. The whole
 * reason that is acceptable is that it can be taken back — so what the product
 * SAYS about taking it back has to match what taking it back actually does.
 *
 * It did not. A spreadsheet import wrote no entry at all into the change log:
 * the tables, the rows, the shared value sets and the links it made were
 * invisible there the moment the live activity bubble scrolled away, and the
 * one-action undo the assistant documentation promised had nothing to act on.
 * The claim was strictly stronger than the behaviour.
 *
 * An import genuinely cannot be reversed in one action: it creates tables,
 * declares them in the workspace, and loads rows in bulk (a single sheet is
 * designed to carry a hundred thousand of them), and the change log's one-action
 * reversal replays recorded per-row inverses under a bounded ceiling. So the
 * product is made HONEST instead: every import leaves one entry that says what
 * it made, states plainly that it cannot be undone in one step, and names what
 * to do instead — and asking to reverse that entry REFUSES in those words rather
 * than reporting a success that restored nothing.
 *
 * This drives a real import and a real undo, over the real command and the real
 * routes, and asserts exactly that.
 */

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface HistoryEntry {
  id: string;
  ts: string;
  table_name: string;
  row_id: string | null;
  operation: string;
  before_json: string | null;
  after_json: string | null;
  undone: number;
  op_group: string | null;
}

/** A workspace on disk plus the spreadsheet we are about to import into it. */
function makeWorkspace(): { configPath: string; contextDir: string; csv: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-import-activity-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  articles:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '    outputFile: articles.md',
      '',
    ].join('\n'),
  );
  const csv = join(root, 'catalog.csv');
  writeFileSync(
    csv,
    [
      'sku,product,supplier,units',
      'A-1,Desk lamp,Northwind,12',
      'A-2,Floor lamp,Northwind,4',
      'B-7,Office chair,Contoso,9',
      'B-8,Standing desk,Contoso,3',
      'C-3,Filing cabinet,Fabrikam,6',
    ].join('\n'),
  );
  return { configPath, contextDir: join(root, 'context'), csv };
}

/** Run the real `lattice import` command against that workspace. */
async function importCatalog(configPath: string, csv: string): Promise<string[]> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runImportCommand(
    { target: csv, config: configPath, explicitConfig: true },
    { out: (l) => out.push(l), err: (l) => err.push(l) },
  );
  expect(code, ['the import failed:', ...err].join('\n')).toBe(0);
  return out;
}

const post = (s: GuiServerHandle, path: string): Promise<Response> =>
  fetch(`${s.url}${path}`, { method: 'POST' });

async function history(s: GuiServerHandle): Promise<HistoryEntry[]> {
  const r = (await (await fetch(`${s.url}/api/history?limit=200`)).json()) as {
    entries: HistoryEntry[];
  };
  return r.entries;
}

async function rowCount(s: GuiServerHandle, table: string): Promise<number> {
  const r = (await (await fetch(`${s.url}/api/tables/${table}/rows`)).json()) as {
    rows?: unknown[];
  };
  return r.rows?.length ?? 0;
}

describe('an import says what taking it back will and will not restore', () => {
  it('records one honest activity entry, and refuses to reverse it in those words', async () => {
    const { configPath, contextDir, csv } = makeWorkspace();
    await importCatalog(configPath, csv);

    const s = await startGuiServer({
      configPath,
      outputDir: contextDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(s);

    // ── The import is IN the change log, once ────────────────────────────
    const entries = await history(s);
    const imports = entries.filter((e) => e.operation === 'schema.import');
    expect(
      imports.length,
      'a spreadsheet import must leave exactly one entry in the change log — ' +
        `saw operations: ${entries.map((e) => e.operation).join(', ') || '(none at all)'}`,
    ).toBe(1);
    const entry = imports[0]!;

    // ── …and that entry states what it made and what undo will not restore ──
    const payload = JSON.parse(entry.after_json ?? '{}') as {
      source?: string;
      tablesCreated?: string[];
      rowsByTable?: Record<string, number>;
      rows?: number;
      asOf?: string | null;
      reversible?: boolean;
      note?: string;
    };
    expect(payload.source, 'the entry names the file it came from').toBe('catalog.csv');
    expect(payload.tablesCreated ?? [], 'the entry names the tables the import created').toContain(
      'catalog',
    );
    expect(payload.rows, 'the entry carries how many rows landed').toBeGreaterThan(0);
    expect(
      payload.reversible,
      'the entry states, in a form nothing has to parse out of prose, that this is NOT reversible',
    ).toBe(false);

    const note = payload.note ?? '';
    expect(note, 'the entry names the tables it created, in words').toContain('catalog');
    expect(
      note.toLowerCase(),
      'the entry says plainly that this cannot be undone in one step',
    ).toContain('cannot be undone in one step');
    expect(
      note.toLowerCase(),
      'the entry says what an undo will NOT restore, rather than implying full reversal',
    ).toContain('will not remove');
    expect(note.toLowerCase(), 'the entry says what to do instead of an undo').toContain('delete');

    // ── An import is not a bulk operation group; the product must not pretend ──
    expect(
      imports.every((e) => e.op_group === null),
      'an import carries no operation group — there is no group undo to offer',
    ).toBe(true);

    const before = {
      catalog: await rowCount(s, 'catalog'),
      supplier: await rowCount(s, 'supplier'),
    };
    expect(before.catalog, 'the import really loaded rows').toBe(5);

    // ── The real undo: asking to reverse the import REFUSES, in those words ──
    const revert = await post(s, `/api/history/revert/${encodeURIComponent(entry.id)}`);
    expect(revert.status, 'reversing an import is refused, not silently accepted').toBe(400);
    const refusal = ((await revert.json()) as { error?: string }).error ?? '';
    expect(refusal.toLowerCase()).toContain('cannot be undone in one step');
    expect(refusal.toLowerCase()).toContain('will not remove');

    // ── …and it changed nothing: not the entry, not the tables, not the rows ──
    const after = await history(s);
    const stillThere = after.find((e) => e.id === entry.id);
    expect(stillThere?.undone, 'a refused reversal never marks the entry undone').toBe(0);
    expect(await rowCount(s, 'catalog'), 'the rows are still there').toBe(before.catalog);
    expect(await rowCount(s, 'supplier'), 'the shared value set is still there').toBe(
      before.supplier,
    );

    // ── A group undo has nothing to act on, and says so rather than no-op ──
    const group = await post(s, `/api/history/undo-group/${encodeURIComponent(entry.id)}`);
    expect(group.status, 'there is no operation group for an import').toBe(404);

    // ── Step-back undo never claims to have undone the import ────────────
    const undo = await post(s, '/api/history/undo');
    if (undo.ok) {
      const body = (await undo.json()) as { entry?: { operation?: string } };
      expect(
        body.entry?.operation,
        'the step-back undo must never report that it undid an import',
      ).not.toBe('schema.import');
    }
    expect(await rowCount(s, 'catalog'), 'the rows survive a step-back undo too').toBe(
      before.catalog,
    );
  });

  it('tells a re-import to delete the rows it added, never the table holding earlier ones', async () => {
    const { configPath, contextDir, csv } = makeWorkspace();
    // The same file twice. The second run is recognised as a new period of a
    // dataset already held: it creates NO table, it adds rows to one that is
    // already there and already holds the first import. Telling somebody to
    // "delete the tables it created" there would destroy the earlier snapshot
    // along with this one — so what the entry advises has to follow what the
    // import actually did, not a fixed sentence.
    await importCatalog(configPath, csv);
    await importCatalog(configPath, csv);

    const s = await startGuiServer({
      configPath,
      outputDir: contextDir,
      port: 0,
      openBrowser: false,
    });
    servers.push(s);

    const imports = (await history(s)).filter((e) => e.operation === 'schema.import');
    expect(imports.length, 'each import leaves its own entry').toBe(2);
    // Newest first — the re-import.
    const reimport = JSON.parse(imports[0]!.after_json ?? '{}') as {
      tablesCreated?: string[];
      note?: string;
    };
    expect(reimport.tablesCreated ?? ['unset'], 'a recognised re-import creates no table').toEqual(
      [],
    );
    const note = (reimport.note ?? '').toLowerCase();
    expect(note, 'it still says it cannot be undone in one step').toContain(
      'cannot be undone in one step',
    );
    expect(note, 'it says what an undo will not restore').toContain(
      'will not remove the rows it added',
    );
    expect(
      note,
      'it must NOT advise deleting the table — that would take the earlier snapshot with it',
    ).not.toContain('delete those tables');
  });

  it('records the assistant’s own spreadsheet import the same way', async () => {
    // The assistant's `import_spreadsheet` tool goes through a different importer
    // (`importDataFaithfully`), which used to record nothing at all while its own
    // documentation said every write it made was "auditable + reversible like any
    // other". Same door, same entry, same honest sentence.
    const { configPath, contextDir } = makeWorkspace();
    const active = await openConfig(configPath, contextDir);
    try {
      const result = await importDataFaithfully(
        active.db,
        active.configPath,
        {
          shipments: [
            { tracking: 'T-1', carrier: 'Northwind', weight: 4 },
            { tracking: 'T-2', carrier: 'Contoso', weight: 9 },
          ],
        },
        { sourceName: 'shipments.xlsx', feed: active.feed },
      );
      expect(result?.tablesCreated, 'the import created the table').toContain('shipments');

      const entries = (await active.db.query('_lattice_gui_audit', {})) as {
        operation: string;
        after_json: string | null;
      }[];
      const imports = entries.filter((e) => e.operation === 'schema.import');
      expect(
        imports.length,
        'the assistant door leaves the same single change-log entry as every other door',
      ).toBe(1);
      const payload = JSON.parse(imports[0]!.after_json ?? '{}') as {
        reversible?: boolean;
        note?: string;
      };
      expect(payload.reversible).toBe(false);
      expect(payload.note ?? '').toContain('shipments.xlsx');
      expect((payload.note ?? '').toLowerCase()).toContain('cannot be undone in one step');
      expect((payload.note ?? '').toLowerCase()).toContain('will not remove');
    } finally {
      await disposeActive(active);
    }
  });
});
