import { describe, it, expect } from 'vitest';
import { isJunctionByColumns } from '../../src/gui/data.js';

/**
 * Regression: a cloud MEMBER joins with no entity/relation config (relations live
 * only in the owner's config, never in the database), so the GUI discovered every
 * table from the catalog and listed junction/link tables in the sidebar as fake
 * objects — while the owner's config-driven sidebar correctly omitted them.
 *
 * The member now classifies junctions from the physical column shape alone (the
 * DB is the source of truth): a lattice junction is materialized as exactly
 * `(id, "<x>_id", "<y>_id")`, so once system columns are stripped the remainder
 * is exactly two `*_id` columns with no payload. `isJunctionByColumns` is that
 * test; this suite pins its semantics.
 */
describe('isJunctionByColumns (member-side, DB-only junction detection)', () => {
  it('treats a two-FK link table as a junction', () => {
    expect(isJunctionByColumns(['id', 'project_id', 'message_id'])).toBe(true);
  });

  it('matches the exact shape materializeJunction creates (id + two *_id)', () => {
    expect(isJunctionByColumns(['id', 'file_id', 'tasks_id'])).toBe(true);
  });

  it('ignores system columns when judging the payload', () => {
    expect(
      isJunctionByColumns([
        'id',
        'project_id',
        'member_id',
        'created_at',
        'updated_at',
        'deleted_at',
      ]),
    ).toBe(true);
  });

  it('tolerates a composite-key junction with no surrogate id', () => {
    expect(isJunctionByColumns(['project_id', 'member_id'])).toBe(true);
  });

  it('is NOT a junction when it carries a payload column (a real entity)', () => {
    // `tasks` with a title is a first-class entity even with two FK-ish columns.
    expect(isJunctionByColumns(['id', 'title', 'project_id'])).toBe(false);
  });

  it('is NOT a junction with only one FK column', () => {
    expect(isJunctionByColumns(['id', 'project_id'])).toBe(false);
  });

  it('is NOT a junction with three FK columns', () => {
    expect(isJunctionByColumns(['id', 'a_id', 'b_id', 'c_id'])).toBe(false);
  });

  it('is NOT a junction when the two payload columns are not *_id', () => {
    // A two-column key/value entity is real data, not a relationship.
    expect(isJunctionByColumns(['id', 'key', 'value'])).toBe(false);
  });
});
