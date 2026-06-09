import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * Activity-card grouping + duration logic, pulled from the shipped client script
 * and executed. Regressions this guards:
 *  - bulk table-deletes must collapse into ONE counted card — the group key is
 *    op+sub-action+source with the TABLE intentionally excluded, so deleting many
 *    different tables stays one "Deleted N tables" card (the reported bug: a
 *    delete split into its own card);
 *  - the coarse live `op:'schema'` and the fine-grained replay
 *    `op:'schema.delete_entity'` must key identically (so live + reload match);
 *  - the timer formats a DURATION ("4s" / "4m 2s"), not a relative "ago".
 */

function extractDecl(src: string, name: string): string {
  // function <name>(…){…}  OR  var <name> = {…}/[…]
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
  // include a trailing ; for var declarations
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
  'formatElapsed',
];
const code = NAMES.map((n) => extractDecl(guiAppHtml, n)).join('\n');
const api = runInNewContext(
  code + '\n({ feedGroupKey, groupedSummary, schemaAction, formatElapsed });',
  {},
  { filename: 'gui-client-script.js' },
) as {
  feedGroupKey: (ev: unknown) => string | null;
  groupedSummary: (g: unknown) => string;
  schemaAction: (s: string) => string | null;
  formatElapsed: (ms: number) => string;
};

describe('activity-card grouping + duration', () => {
  it('groups table-deletes across DIFFERENT tables under one key (table excluded)', () => {
    const a = api.feedGroupKey({ op: 'schema', summary: 'Deleted table alpha', source: 'gui' });
    const b = api.feedGroupKey({ op: 'schema', summary: 'Deleted table beta', source: 'gui' });
    expect(a).toBe(b); // different tables → same group
    expect(a).toBe('schema|deleted-table|gui');
  });

  it('keys the coarse live op and the fine-grained replay op identically', () => {
    const live = api.feedGroupKey({ op: 'schema', summary: 'Deleted table x', source: 'ai' });
    const replay = api.feedGroupKey({
      op: 'schema.delete_entity',
      summary: 'Deleted table y',
      source: 'ai',
    });
    expect(live).toBe(replay);
  });

  it('collapses a delete run into one "Deleted N tables" summary', () => {
    const summary = api.groupedSummary({
      op: 'schema',
      schemaKey: 'deleted-table',
      count: 11,
      firstSummary: 'Deleted table execution_runs',
    });
    expect(summary).toBe('Deleted 11 tables');
  });

  it('does not over-group different schema actions (deletes vs renames)', () => {
    const del = api.feedGroupKey({ op: 'schema', summary: 'Deleted table x', source: 'gui' });
    const ren = api.feedGroupKey({ op: 'schema', summary: 'Renamed table x', source: 'gui' });
    expect(del).not.toBe(ren);
  });

  it('formats a DURATION, not a relative "ago"', () => {
    expect(api.formatElapsed(4000)).toBe('4s');
    expect(api.formatElapsed((4 * 60 + 2) * 1000)).toBe('4m 2s');
    expect(api.formatElapsed(0)).toBe('0s');
  });
});
