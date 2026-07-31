import { describe, expect, it } from 'vitest';

import { appJs } from '../../src/gui/app/script.js';
import { importActivityNote } from '../../src/gui/mutations.js';

/**
 * What the change-log card says about an import, and whether it offers to reverse
 * one.
 *
 * An import cannot be reversed in one action — it creates tables, declares them,
 * and loads rows in bulk. A card that shows a Revert button anyway promises
 * something the server refuses, which is the exact shape of the problem this
 * change exists to remove: a safety claim stronger than the behaviour. So the
 * card renders the entry's OWN sentence (what it made, that it cannot be undone
 * in one step, what to do instead) and offers no control that would suggest
 * otherwise — while every schema change that IS revertible keeps its button.
 *
 * The helpers are pulled out of the shipped client bundle and run, the same way
 * the bulk-grouping helper is, so this asserts the code that is actually served.
 */

interface LabelHelpers {
  schemaEntryLabel: (e: Record<string, unknown>) => string;
  notRevertibleReason: (op: string) => string;
}

function loadLabelHelpers(): LabelHelpers {
  const start = appJs.indexOf('function schemaEntryLabel');
  const end = appJs.indexOf('function historyEntryHtml');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('could not locate schemaEntryLabel/notRevertibleReason in appJs');
  }
  const slice = appJs.slice(start, end);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'escapeHtml',
    'safeParse',
    `${slice}\n;return { schemaEntryLabel: schemaEntryLabel, notRevertibleReason: notRevertibleReason };`,
  ) as (escapeHtml: (s: unknown) => string, safeParse: (s: string) => unknown) => LabelHelpers;
  return factory(
    (s) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;'),
    (s) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return null;
      }
    },
  );
}

const helpers = loadLabelHelpers();

/** One import entry as the history route serves it. */
function importEntry(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'a1',
    table_name: 'catalog',
    operation: 'schema.import',
    before_json: null,
    after_json: JSON.stringify(payload),
    undone: 0,
    op_group: null,
  };
}

describe('the change-log card for an import', () => {
  it('shows the entry’s own sentence — what it made, and what undo will not restore', () => {
    const note = importActivityNote({
      source: 'catalog.csv',
      tablesCreated: ['catalog', 'supplier'],
      rowsByTable: { catalog: 5, supplier: 3 },
      asOf: '2026-07-31',
      asOfColumn: null,
    });
    const label = helpers.schemaEntryLabel(importEntry({ note }));
    expect(label).toContain('catalog');
    expect(label).toContain('cannot be undone in one step');
    expect(label).toContain('Undo will not remove the tables it created');
    expect(label).toContain('delete those tables');
  });

  it('offers no Revert control for an import, and says why', () => {
    expect(helpers.notRevertibleReason('schema.import')).toBe('not undoable in one step');
  });

  it('still offers Revert for the schema changes that really are revertible', () => {
    for (const op of [
      'schema.create_entity',
      'schema.delete_entity',
      'schema.add_column',
      'schema.rename_entity',
      'schema.delete_link',
      'schema.create_computed',
    ]) {
      expect(helpers.notRevertibleReason(op), `${op} must keep its Revert button`).toBe('');
    }
    expect(helpers.notRevertibleReason('schema.purge')).toBe('permanent');
    expect(helpers.notRevertibleReason('schema.refresh_computed')).toBe('not revertible');
  });

  it('wires the reason into the rendered card, not just into a helper nobody calls', () => {
    expect(appJs).toContain('var noRevert = notRevertibleReason(e.operation)');
  });
});

describe('what an import entry promises about taking it back', () => {
  it('names the tables to delete when the import created them', () => {
    const note = importActivityNote({
      source: 'books.xlsx',
      tablesCreated: ['books', 'genre'],
      rowsByTable: { books: 5, genre: 2 },
      asOf: '2026-07-31',
      asOfColumn: null,
    });
    expect(note).toContain('Imported "books.xlsx" — 7 rows across books, genre');
    expect(note).toContain('filed as the 2026-07-31 snapshot');
    expect(note).toContain('New: books, genre.');
    expect(note).toContain('Undo will not remove the tables it created or the rows in them.');
    expect(note).toContain('To take this import back, delete those tables.');
  });

  it('points at the rows, never the table, when the import only added to one', () => {
    const note = importActivityNote({
      source: 'books.xlsx',
      tablesCreated: [],
      rowsByTable: { books: 12 },
      asOf: '2026-08-02',
      asOfColumn: null,
    });
    expect(note).toContain('Undo will not remove the rows it added.');
    expect(note).toContain('delete the rows it added (the 2026-08-02 snapshot)');
    // Deleting the table would take every earlier snapshot in it with them.
    expect(note).not.toContain('delete those tables');
  });

  it('says how the rows are dated when the source dated them itself', () => {
    const note = importActivityNote({
      source: 'ledger.csv',
      tablesCreated: [],
      rowsByTable: { ledger: 1 },
      asOf: null,
      asOfColumn: 'posted_on',
    });
    expect(note).toContain('1 row across ledger');
    expect(note).toContain('dated row by row from "posted_on"');
    expect(note).toContain('cannot be undone in one step');
  });
});
