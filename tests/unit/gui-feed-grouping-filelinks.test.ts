import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * #5 regression — junction-materialization activity ("Linked files ↔ project",
 * "Linked authors ↔ books") arrives as a schema op but matched NO schemaAction
 * rule, so feedGroupKey returned null and every link spammed its own pill. They
 * must now collapse into one counted "Linked N relationships" bubble. Logic is
 * pulled verbatim from the shipped client script and executed.
 */
function extractDecl(src: string, name: string): string {
  let i = src.indexOf('function ' + name + '(');
  let opener = '{';
  if (i < 0) {
    i = src.indexOf('var ' + name + ' =');
    if (i < 0) throw new Error('declaration not found: ' + name);
    const brace = src.indexOf('{', i);
    const bracket = src.indexOf('[', i);
    opener = brace >= 0 && (bracket < 0 || brace < bracket) ? '{' : '[';
  }
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let k = src.indexOf(opener, i);
  for (; k < src.length; k++) {
    if (src[k] === opener) depth++;
    else if (src[k] === closer) {
      depth--;
      if (depth === 0) {
        k++;
        break;
      }
    }
  }
  return src.slice(i, k) + (src[i] === 'v' ? ';' : '');
}

const NAMES = [
  'SCHEMA_GROUP',
  'GROUPABLE_OPS',
  'ROW_VERB',
  'ROW_PREP',
  'isSchemaOp',
  'schemaAction',
  'onlyKey',
  'groupedRowSummary',
  'schemaGroupSummary',
  'groupedSummary',
  'feedGroupKey',
];
const code = NAMES.map((n) => extractDecl(guiAppHtml, n)).join('\n');
const api = runInNewContext(
  code + '\n({ feedGroupKey, groupedSummary, schemaAction });',
  {},
  { filename: 'gui-client-script.js' },
) as {
  feedGroupKey: (ev: unknown) => string | null;
  groupedSummary: (g: unknown) => string;
  schemaAction: (s: string) => string | null;
};

describe('#5 feed grouping — junction "Linked X ↔ Y" events collapse', () => {
  it('schemaAction maps a "Linked X ↔ Y" summary to a groupable sub-action', () => {
    expect(api.schemaAction('Linked files ↔ project')).toBe('linked-rel');
    expect(api.schemaAction('Linked authors ↔ books')).toBe('linked-rel');
  });

  it('groups link events across DIFFERENT tables under one key (no longer null)', () => {
    const a = api.feedGroupKey({
      op: 'schema.create_junction',
      summary: 'Linked files ↔ project',
      source: 'gui',
    });
    const b = api.feedGroupKey({
      op: 'schema.create_junction',
      summary: 'Linked files ↔ contact',
      source: 'gui',
    });
    expect(a).not.toBeNull(); // the bug was: this returned null → ungrouped
    expect(a).toBe(b);
    expect(a).toBe('schema|linked-rel|gui');
  });

  it('keys the coarse live op:schema and the fine op:schema.create_junction identically', () => {
    const live = api.feedGroupKey({ op: 'schema', summary: 'Linked files ↔ a', source: 'ai' });
    const fine = api.feedGroupKey({
      op: 'schema.create_junction',
      summary: 'Linked files ↔ b',
      source: 'ai',
    });
    expect(live).toBe(fine);
  });

  it('collapses a run into one "Linked N relationships" summary; a single keeps its text', () => {
    expect(
      api.groupedSummary({
        op: 'schema',
        schemaKey: 'linked-rel',
        count: 5,
        firstSummary: 'Linked files ↔ project',
      }),
    ).toBe('Linked 5 relationships');
    // count 1 keeps the descriptive original.
    expect(
      api.groupedSummary({
        op: 'schema',
        schemaKey: 'linked-rel',
        count: 1,
        firstSummary: 'Linked files ↔ project',
      }),
    ).toBe('Linked files ↔ project');
  });

  it('does not over-group: a relationship link and a table-create stay distinct', () => {
    const link = api.feedGroupKey({ op: 'schema', summary: 'Linked files ↔ x', source: 'gui' });
    const create = api.feedGroupKey({ op: 'schema', summary: 'Created table x', source: 'gui' });
    expect(link).not.toBe(create);
  });
});

describe('#I feed grouping — "Added column(s)" auto-create events collapse', () => {
  it('schemaAction maps BOTH the generic and the specific add-column summary', () => {
    // The bug: ingest auto-create emits "Added columns a, b to files" (plural,
    // with names) which the old /^Added a column/ regex missed → each spammed an
    // ungrouped pill. Both the generic and the specific form must group now.
    expect(api.schemaAction('Added a column to files')).toBe('added-column');
    expect(api.schemaAction('Added column slug to files')).toBe('added-column');
    expect(api.schemaAction('Added columns slug, name, title to files')).toBe('added-column');
  });

  it('repeated identical add-column events share one group key', () => {
    const a = api.feedGroupKey({
      op: 'schema.add_column',
      summary: 'Added columns slug, name, title to files',
      source: 'ai',
    });
    const b = api.feedGroupKey({
      op: 'schema.add_column',
      summary: 'Added columns slug, name, title to files',
      source: 'ai',
    });
    expect(a).not.toBeNull(); // was null → duplicate pills
    expect(a).toBe(b);
  });
});
