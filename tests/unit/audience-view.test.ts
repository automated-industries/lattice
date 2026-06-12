/**
 * Audience grammar → cell-masking view SQL (Stage 2). Pure-function coverage of
 * the predicate compiler + view generator: row-audience passes through unmasked,
 * each clause maps to its session_user-keyed helper, '+' is OR, unknown/malformed
 * clauses fail closed (throw), and a table with no audience columns needs no view.
 */
import { describe, it, expect } from 'vitest';
import {
  audiencePredicate,
  audienceViewSql,
  isRowAudience,
  tableNeedsAudienceView,
} from '../../src/cloud/audience.js';

describe('audiencePredicate', () => {
  it('treats empty / everyone / row-audience as unmasked (true)', () => {
    expect(audiencePredicate('')).toBe('true');
    expect(audiencePredicate('everyone')).toBe('true');
    expect(audiencePredicate('row-audience')).toBe('true');
    expect(isRowAudience('everyone')).toBe(true);
    expect(isRowAudience('role:hr')).toBe(false);
  });

  it('maps each clause to its session_user-keyed helper', () => {
    expect(audiencePredicate('role:hr')).toBe("(lattice_has_role('hr'))");
    expect(audiencePredicate('subject:owner_role')).toBe('(lattice_is_subject("owner_role"))');
    expect(audiencePredicate('source:source_ref')).toBe('(lattice_source_visible("source_ref"))');
  });

  it('joins multiple clauses with OR', () => {
    expect(audiencePredicate('subject:owner_role+role:hr')).toBe(
      '(lattice_is_subject("owner_role")) OR (lattice_has_role(\'hr\'))',
    );
  });

  it('fails closed on an unknown or malformed clause', () => {
    expect(() => audiencePredicate('wat:x')).toThrow(/unknown audience clause/);
    expect(() => audiencePredicate('role:has spaces')).toThrow(/invalid role/);
    expect(() => audiencePredicate('subject:1bad')).toThrow(/invalid subject column/);
    expect(() => audiencePredicate("role:'; DROP TABLE x;--")).toThrow(/invalid role/);
  });
});

describe('audienceViewSql', () => {
  it('passes unmasked columns through and CASE-masks audience columns', () => {
    const sql = audienceViewSql('person', ['id', 'name', 'comp', 'owner_role'], ['id'], {
      comp: 'subject:owner_role+role:hr',
    });
    expect(sql).toContain('CREATE OR REPLACE VIEW "person_v"');
    expect(sql).toContain('FROM "person"');
    expect(sql).toContain('GRANT SELECT ON "person_v" TO lattice_members');
    // Base SELECT is revoked so the mask can't be bypassed.
    expect(sql).toContain('REVOKE SELECT ON "person" FROM lattice_members');
    // The view re-applies row visibility via the session_user-keyed helper.
    expect(sql).toContain('WHERE lattice_row_visible(\'person\', CAST("id" AS TEXT))');
    // Plain columns pass through verbatim.
    expect(sql).toMatch(/SELECT "id", "name",/);
    // The audience column is wrapped with the column predicate OR a per-card
    // override (lattice_cell_visible), masked to NULL otherwise.
    expect(sql).toContain(
      'CASE WHEN ((lattice_is_subject("owner_role")) OR (lattice_has_role(\'hr\')))' +
        ' OR lattice_cell_visible(\'person\', CAST("id" AS TEXT), \'comp\') THEN "comp" END AS "comp"',
    );
  });

  it('an everyone/row-audience column is not wrapped', () => {
    const sql = audienceViewSql('t', ['id', 'a'], ['id'], { a: 'everyone' });
    expect(sql).not.toContain('CASE WHEN');
    expect(sql).toMatch(/SELECT "id", "a" FROM "t"/);
  });

  it('serializes a composite pk for the row filter (matches the RLS policy)', () => {
    const sql = audienceViewSql('memo', ['a', 'b', 'secret'], ['a', 'b'], { secret: 'role:hr' });
    expect(sql).toContain(
      'WHERE lattice_row_visible(\'memo\', CAST("a" AS TEXT) || chr(9) || CAST("b" AS TEXT))',
    );
  });
});

describe('tableNeedsAudienceView', () => {
  it('is false when every column is row-audience', () => {
    expect(tableNeedsAudienceView({})).toBe(false);
    expect(tableNeedsAudienceView({ a: 'everyone', b: 'row-audience' })).toBe(false);
  });
  it('is true when any column declares a real audience', () => {
    expect(tableNeedsAudienceView({ comp: 'role:hr' })).toBe(true);
  });
});
