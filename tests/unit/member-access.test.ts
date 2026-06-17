/**
 * The member-access registry is the single source of truth for what a cloud
 * MEMBER may reach. These pure-function tests pin the registry shape + the grant
 * SQL it emits, so the "forgot to grant / accidentally granted" class is caught
 * here rather than as a production GUI degradation.
 */
import { describe, it, expect } from 'vitest';
import {
  MEMBER_READABLE_BOOKKEEPING,
  OWNER_ONLY_BOOKKEEPING,
  grantMemberTableAccessSql,
  grantMemberBookkeepingSql,
  grantMemberExecuteSql,
} from '../../src/cloud/member-access.js';

describe('member-access registry', () => {
  it('keeps readable and owner-only sets disjoint (no table is both)', () => {
    const readable = new Set(MEMBER_READABLE_BOOKKEEPING.map((e) => e.name));
    for (const t of OWNER_ONLY_BOOKKEEPING) {
      expect(readable.has(t), `${t} must not be both member-readable and owner-only`).toBe(false);
    }
  });

  it('lists the GUI/identity/changelog tables as member-readable', () => {
    const names = MEMBER_READABLE_BOOKKEEPING.map((e) => e.name);
    expect(names).toContain('_lattice_gui_meta');
    expect(names).toContain('_lattice_gui_column_meta');
    expect(names).toContain('_lattice_gui_audit');
    expect(names).toContain('__lattice_user_identity');
    expect(names).toContain('__lattice_changelog');
  });

  it('keeps the sensitive bookkeeping tables owner-only', () => {
    for (const t of [
      '__lattice_owners',
      '__lattice_row_grants',
      '__lattice_member_invites',
      '__lattice_cloud_settings',
      '__lattice_column_policy',
    ]) {
      expect(OWNER_ONLY_BOOKKEEPING).toContain(t);
    }
  });

  it('grantMemberTableAccessSql: an unmasked table gets full DML + SELECT on the base', () => {
    expect(grantMemberTableAccessSql('people', { masked: false })).toEqual([
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "people" TO lattice_members',
    ]);
  });

  it('grantMemberTableAccessSql: a masked table reads the _v view; base SELECT stays withheld', () => {
    expect(grantMemberTableAccessSql('people', { masked: true })).toEqual([
      'GRANT SELECT ON "people_v" TO lattice_members',
      'GRANT INSERT, UPDATE, DELETE ON "people" TO lattice_members',
    ]);
  });

  it('grantMemberBookkeepingSql emits one to_regclass-guarded GRANT per readable entry', () => {
    const sql = grantMemberBookkeepingSql();
    expect(sql).toHaveLength(MEMBER_READABLE_BOOKKEEPING.length);
    for (const e of MEMBER_READABLE_BOOKKEEPING) {
      expect(
        sql.some((s) => s.includes(`"${e.name}"`) && s.includes('to_regclass')),
        `${e.name} must have a guarded grant`,
      ).toBe(true);
    }
  });

  it('grantMemberExecuteSql grants EXECUTE on the SQLite-compat polyfills only', () => {
    const sql = grantMemberExecuteSql();
    expect(sql).toContain('json_extract(text, text)');
    expect(sql).toContain('strftime(text, text)');
    expect(sql).toContain('lattice_members');
    // The DEFINER RLS helpers must NOT be in the member EXECUTE grant.
    expect(sql).not.toContain('lattice_is_owner');
  });
});
