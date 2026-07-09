import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import type { MutationCtx } from '../../src/gui/mutations.js';
import type { TurnParams, TurnResult } from '../../src/gui/ai/chat.js';

/**
 * The shared enrichment engine used to link every extracted object only to the SOURCE
 * (the file/notes) — so a meeting extracted from notes was linked to the notes, but not
 * to its attendees. The extractor now emits, per object, the labels of the other objects
 * it relates to (`links`), and the engine materializes those record-to-record links
 * deterministically. Benefits every input (file / URL / pasted chat text) identically.
 */

const scripted = vi.hoisted(() => ({ extractJson: '', classifyJson: '```json\n[]\n```' }));
vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/ai/chat.js')>();
  return {
    ...actual,
    createAnthropicClient: () => ({
      runTurn(params: TurnParams): Promise<TurnResult> {
        const sys = params.system;
        let text = '';
        if (sys.includes('one or two sentence')) text = 'Notes.';
        else if (sys.includes('which existing records')) text = scripted.classifyJson;
        else if (sys.includes('extracting the key structured objects')) text = scripted.extractJson;
        return Promise.resolve({ stopReason: 'end_turn', text, toolUses: [] });
      },
    }),
  };
});
vi.mock('../../src/gui/assistant-routes.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/assistant-routes.js')>();
  return { ...actual, resolveClaudeAuth: () => Promise.resolve({ apiKey: 'test-key' }) };
});
import { enrichWithLlm } from '../../src/gui/ai/enrich.js';

const t = (cols: Record<string, string>, out: string) => ({
  columns: cols,
  render: () => '',
  outputFile: out,
});

describe('enrich cross-links co-extracted objects', () => {
  let tmpDir: string;
  let cfgDir: string;
  let db: Lattice;
  let mctx: MutationCtx;

  beforeEach(async () => {
    scripted.extractJson = '';
    scripted.classifyJson = '```json\n[]\n```';
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-crosslink-'));
    cfgDir = mkdtempSync(join(tmpdir(), 'lattice-crosslink-cfg-'));
    process.env.LATTICE_CONFIG_DIR = cfgDir; // default clarify threshold (0.6)
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define(
      'files',
      t(
        { id: 'TEXT PRIMARY KEY', description: 'TEXT', extracted_text: 'TEXT', deleted_at: 'TEXT' },
        '.s/files.md',
      ),
    );
    db.define(
      'meetings',
      t({ id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' }, '.s/m.md'),
    );
    db.define('people', t({ id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' }, '.s/p.md'));
    db.define('orgs', t({ id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' }, '.s/o.md'));
    db.define(
      'meetings_people',
      t({ id: 'TEXT PRIMARY KEY', meeting_id: 'TEXT', people_id: 'TEXT' }, '.s/mp.md'),
    );
    db.define(
      'meetings_orgs',
      t({ id: 'TEXT PRIMARY KEY', meeting_id: 'TEXT', orgs_id: 'TEXT' }, '.s/mo.md'),
    );
    db.define(
      '_lattice_gui_audit',
      t(
        {
          id: 'TEXT PRIMARY KEY',
          ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
          table_name: 'TEXT NOT NULL',
          row_id: 'TEXT',
          operation: 'TEXT NOT NULL',
          before_json: 'TEXT',
          after_json: 'TEXT',
          undone: 'INTEGER NOT NULL DEFAULT 0',
        },
        '.s/audit.md',
      ),
    );
    await db.init();
    await db.insert('files', { id: 'f1' });
    mctx = {
      db,
      feed: new FeedBus(),
      softDeletable: new Set(['files', 'meetings', 'people']),
      source: 'ingest',
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it('does NOT manufacture rows from a SPREADSHEET — the deterministic importer owns those', async () => {
    // The LLM extractor is prose-oriented and lossy on tabular data (a 53-row workbook
    // collapsed to a 3-row summary). For a spreadsheet the structured importer materializes
    // every row, so the enricher must skip object extraction entirely. Script an extract
    // that WOULD create a meeting, then prove it doesn't run for an .xlsx.
    scripted.extractJson =
      '```json\n' +
      JSON.stringify([
        {
          entity: 'meetings',
          isNew: false,
          columns: ['name'],
          values: { name: 'Should Not Exist' },
          label: 'Should Not Exist',
        },
      ]) +
      '\n```';
    const createEntity = vi.fn(() => Promise.resolve<string | null>(null));
    await enrichWithLlm(
      mctx,
      db,
      'f1',
      'some rows',
      'ARR Jan - Mar 2021 Summary v0.xlsx', // a spreadsheet → extraction is skipped
      [],
      {},
      vi.fn(() => Promise.resolve(null)),
      0.9,
      createEntity,
    );
    // No rows manufactured from the workbook, and the entity creator was never consulted.
    expect((await db.query('meetings', {})).length).toBe(0);
    expect(createEntity).not.toHaveBeenCalled();
  });

  it('materializes the meeting↔attendee link the extractor stated (not just file↔object)', async () => {
    scripted.extractJson =
      '```json\n' +
      JSON.stringify([
        {
          entity: 'meetings',
          isNew: false,
          columns: ['name'],
          values: { name: 'Weekly Sync' },
          label: 'Weekly Sync',
          links: ['Ada Lovelace'], // the meeting's attendee, by label
        },
        {
          entity: 'people',
          isNew: false,
          columns: ['name'],
          values: { name: 'Ada Lovelace' },
          label: 'Ada Lovelace',
        },
      ]) +
      '\n```';
    const createEntity = vi.fn(() => Promise.resolve<string | null>(null)); // entities exist → reused
    const createFileJx = vi.fn(() => Promise.resolve(null)); // file↔object link isn't the focus
    const createObjectJunction = vi.fn(() =>
      Promise.resolve({
        junction: 'meetings_people',
        tableA: 'meetings',
        aFk: 'meeting_id',
        tableB: 'people',
        bFk: 'people_id',
      }),
    );

    await enrichWithLlm(
      mctx,
      db,
      'f1',
      'Weekly sync with Ada Lovelace.',
      'notes',
      [],
      {},
      createFileJx,
      0.9,
      createEntity,
      false,
      false,
      createObjectJunction,
    );

    // Both objects were created…
    const meetings = (await db.query('meetings', {})) as { id: string }[];
    const people = (await db.query('people', {})) as { id: string }[];
    expect(meetings.length).toBe(1);
    expect(people.length).toBe(1);

    // …AND the engine linked the meeting to its attendee, per the extractor's `links`.
    const links = (await db.query('meetings_people', {})) as {
      meeting_id: string;
      people_id: string;
    }[];
    expect(links.length).toBe(1);
    expect(links[0]?.meeting_id).toBe(meetings[0]?.id);
    expect(links[0]?.people_id).toBe(people[0]?.id);
    expect(createObjectJunction).toHaveBeenCalledWith('meetings', 'people');
  });

  it('links an extracted object to an EXISTING record the classifier matched (not only co-extracted)', async () => {
    // An attendee that already EXISTS as a record — not re-extracted this pass.
    await db.insert('people', { id: 'grace-1', name: 'Grace Hopper' });
    // Classifier matches the existing person; extractor pulls out ONLY the meeting
    // (no co-extracted person) and states the meeting relates to "Grace Hopper".
    scripted.classifyJson =
      '```json\n' + JSON.stringify([{ table: 'people', id: 'grace-1' }]) + '\n```';
    scripted.extractJson =
      '```json\n' +
      JSON.stringify([
        {
          entity: 'meetings',
          isNew: false,
          columns: ['name'],
          values: { name: 'Weekly Sync' },
          label: 'Weekly Sync',
          links: ['Grace Hopper'], // an EXISTING record, not co-extracted
        },
      ]) +
      '\n```';
    const createEntity = vi.fn(() => Promise.resolve<string | null>(null)); // reuse existing
    const createFileJx = vi.fn(() => Promise.resolve(null));
    const createObjectJunction = vi.fn(() =>
      Promise.resolve({
        junction: 'meetings_people',
        tableA: 'meetings',
        aFk: 'meeting_id',
        tableB: 'people',
        bFk: 'people_id',
      }),
    );

    await enrichWithLlm(
      mctx,
      db,
      'f1',
      'Weekly sync with Grace Hopper.',
      'notes',
      [],
      {},
      createFileJx,
      0.9,
      createEntity,
      false,
      false,
      createObjectJunction,
    );

    // The meeting was created and linked to the PRE-EXISTING person record — even
    // though that person was never re-extracted (createdObjects had only the meeting).
    const meetings = (await db.query('meetings', {})) as { id: string }[];
    expect(meetings.length).toBe(1);
    const links = (await db.query('meetings_people', {})) as {
      meeting_id: string;
      people_id: string;
    }[];
    expect(links.length).toBe(1);
    expect(links[0]?.meeting_id).toBe(meetings[0]?.id);
    expect(links[0]?.people_id).toBe('grace-1'); // the existing record, by its own id
    expect(createObjectJunction).toHaveBeenCalledWith('meetings', 'people');
  });

  it('does NOT guess when a link label is ambiguous across tables (skips, never wrong-links)', async () => {
    // Two existing records share the label "Apollo" in DIFFERENT tables. A bare-label
    // link must not be guessed — linking the wrong record silently corrupts the graph.
    await db.insert('people', { id: 'apollo-person', name: 'Apollo' });
    await db.insert('orgs', { id: 'apollo-org', name: 'Apollo' });
    scripted.classifyJson =
      '```json\n' +
      JSON.stringify([
        { table: 'people', id: 'apollo-person' },
        { table: 'orgs', id: 'apollo-org' },
      ]) +
      '\n```';
    scripted.extractJson =
      '```json\n' +
      JSON.stringify([
        {
          entity: 'meetings',
          isNew: false,
          columns: ['name'],
          values: { name: 'Weekly Sync' },
          label: 'Weekly Sync',
          links: ['Apollo'], // ambiguous — matches both the person AND the org
        },
      ]) +
      '\n```';
    const createEntity = vi.fn(() => Promise.resolve<string | null>(null));
    const createFileJx = vi.fn(() => Promise.resolve(null));
    const createObjectJunction = vi.fn(() =>
      Promise.resolve({
        junction: 'meetings_people',
        tableA: 'meetings',
        aFk: 'meeting_id',
        tableB: 'people',
        bFk: 'people_id',
      }),
    );

    await enrichWithLlm(
      mctx,
      db,
      'f1',
      'Weekly sync about Apollo.',
      'notes',
      [],
      {},
      createFileJx,
      0.9,
      createEntity,
      false,
      false,
      createObjectJunction,
    );

    // The meeting was created, but NO cross-link was materialized to either "Apollo"
    // record — the ambiguity is skipped, not resolved to a coin-flip.
    const meetings = (await db.query('meetings', {})) as { id: string }[];
    expect(meetings.length).toBe(1);
    const mp = (await db.query('meetings_people', {})) as unknown[];
    const mo = (await db.query('meetings_orgs', {})) as unknown[];
    expect(mp.length).toBe(0);
    expect(mo.length).toBe(0);
    expect(createObjectJunction).not.toHaveBeenCalled();
  });
});
