/**
 * Audience grammar → cell-masking view SQL. Pure-function coverage of the
 * predicate compiler + view generator: row-audience passes through unmasked, the
 * `owner` (secret-column) clause maps to its session_user-keyed helper, anything
 * else fails closed (throw), and a table with no audience columns needs no view.
 */
import { describe, it, expect } from 'vitest';
import {
  audiencePredicate,
  audienceViewSql,
  isRowAudience,
  tableNeedsAudienceView,
} from '../../src/cloud/audience.js';

const ownerCtx = { tableLit: "'person'", pkExpr: 'CAST("id" AS TEXT)' };

describe('audiencePredicate', () => {
  it('treats empty / everyone / row-audience as unmasked (true)', () => {
    expect(audiencePredicate('')).toBe('true');
    expect(audiencePredicate('everyone')).toBe('true');
    expect(audiencePredicate('row-audience')).toBe('true');
    expect(isRowAudience('everyone')).toBe(true);
    expect(isRowAudience('owner')).toBe(false);
  });

  it('maps the owner (secret-column) clause to lattice_is_owner', () => {
    expect(audiencePredicate('owner', ownerCtx)).toBe(
      'lattice_is_owner(\'person\', CAST("id" AS TEXT))',
    );
  });

  it('requires a row context for the owner clause', () => {
    expect(() => audiencePredicate('owner')).toThrow(/needs a row context/);
  });

  it('fails closed on any other clause (incl. the retired role/subject/source)', () => {
    expect(() => audiencePredicate('wat:x')).toThrow(/unknown audience clause/);
    expect(() => audiencePredicate('role:hr')).toThrow(/unknown audience clause/);
    expect(() => audiencePredicate('subject:owner_role')).toThrow(/unknown audience clause/);
    expect(() => audiencePredicate('source:source_ref')).toThrow(/unknown audience clause/);
    expect(() => audiencePredicate("owner'; DROP TABLE x;--", ownerCtx)).toThrow(
      /unknown audience clause/,
    );
  });
});

describe('audienceViewSql', () => {
  it('passes unmasked columns through and CASE-masks the owner secret column', () => {
    const sql = audienceViewSql(
      'person',
      ['id', 'name', 'comp', 'owner_role'],
      ['id'],
      { comp: 'owner' },
      'lattice_members',
    );
    expect(sql).toContain('CREATE OR REPLACE VIEW "person_v"');
    expect(sql).toContain('FROM "person"');
    expect(sql).toContain('GRANT SELECT ON "person_v" TO lattice_members');
    // Base SELECT is revoked so the mask can't be bypassed.
    expect(sql).toContain('REVOKE SELECT ON "person" FROM lattice_members');
    // The view re-applies row visibility via the session_user-keyed helper.
    expect(sql).toContain('WHERE lattice_row_visible(\'person\', CAST("id" AS TEXT))');
    // Plain columns pass through verbatim.
    expect(sql).toMatch(/SELECT "id", "name",/);
    // The secret column reveals only to the row owner, masked to NULL otherwise.
    expect(sql).toContain(
      'CASE WHEN lattice_is_owner(\'person\', CAST("id" AS TEXT)) THEN "comp" END AS "comp"',
    );
  });

  it('an everyone/row-audience column is not wrapped', () => {
    const sql = audienceViewSql('t', ['id', 'a'], ['id'], { a: 'everyone' }, 'lattice_members');
    expect(sql).not.toContain('CASE WHEN');
    expect(sql).toMatch(/SELECT "id", "a" FROM "t"/);
  });

  it('serializes a composite pk for the row filter (matches the RLS policy)', () => {
    const sql = audienceViewSql(
      'memo',
      ['a', 'b', 'secret'],
      ['a', 'b'],
      { secret: 'owner' },
      'lattice_members',
    );
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
    expect(tableNeedsAudienceView({ comp: 'owner' })).toBe(true);
  });
});
