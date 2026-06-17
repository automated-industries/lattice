/**
 * Identity-invariant guard for the per-viewer audience layer. The whole cloud
 * model binds visibility to `session_user` through `SECURITY DEFINER` helpers —
 * NEVER `current_user` (hijackable under `SET ROLE`) and never `SECURITY
 * INVOKER` (which would re-broaden a member's reach through an owner-executed
 * view). A single slip here is a silent cross-viewer leak, so this test fails
 * the build if the bootstrap or a per-table policy violates the invariant, and
 * if the Stage-0 audience helper predicates go missing or stop being DEFINER.
 */
import { describe, it, expect } from 'vitest';
import { CLOUD_RLS_BOOTSTRAP_SQL, tableRlsSql } from '../../src/cloud/rls.js';

/** The header of a CREATE FUNCTION block (name → its `$fn$` body opener), where
 *  the LANGUAGE / SECURITY clauses live. */
function fnHeader(sql: string, name: string): string {
  const start = sql.indexOf(`FUNCTION ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in bootstrap`);
  const bodyAt = sql.indexOf('$fn$', start);
  return sql.slice(start, bodyAt);
}

/** Strip `-- …` line comments so the invariant checks scan SQL *code*, not the
 *  prose that documents the invariant (which deliberately names current_user /
 *  SECURITY INVOKER as the things to avoid). */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

// Security-sensitive functions that MUST run with definer rights + session_user.
const DEFINER_FUNCTIONS = [
  'lattice_row_visible',
  'lattice_set_row_visibility',
  'lattice_grant_row',
  'lattice_revoke_row',
  'lattice_require_owner',
  'lattice_table_is_never_share',
  'lattice_source_visible',
  'lattice_is_owner',
];

describe('cloud RLS — session_user / SECURITY DEFINER identity invariant', () => {
  it('defines the live audience/visibility helpers', () => {
    for (const fn of ['lattice_source_visible', 'lattice_is_owner', 'lattice_require_owner']) {
      expect(CLOUD_RLS_BOOTSTRAP_SQL).toContain(`FUNCTION ${fn}(`);
    }
  });

  it('every visibility/audience function is SECURITY DEFINER', () => {
    for (const fn of DEFINER_FUNCTIONS) {
      expect(fnHeader(CLOUD_RLS_BOOTSTRAP_SQL, fn)).toMatch(/SECURITY DEFINER/);
    }
  });

  it('never uses SECURITY INVOKER anywhere in the bootstrap code', () => {
    expect(code(CLOUD_RLS_BOOTSTRAP_SQL).toLowerCase()).not.toContain('security invoker');
    expect(code(CLOUD_RLS_BOOTSTRAP_SQL).toLowerCase()).not.toContain('security_invoker');
  });

  it('the bootstrap code keys on session_user and never current_user', () => {
    expect(code(CLOUD_RLS_BOOTSTRAP_SQL)).toMatch(/\bsession_user\b/);
    expect(code(CLOUD_RLS_BOOTSTRAP_SQL)).not.toMatch(/\bcurrent_user\b/);
  });

  it('per-table policy SQL never uses current_user', () => {
    const single = code(tableRlsSql('demo', ['id']));
    const composite = code(tableRlsSql('memo', ['a', 'b']));
    expect(single).not.toMatch(/\bcurrent_user\b/);
    expect(composite).not.toMatch(/\bcurrent_user\b/);
    // The policies route through the session_user-keyed visibility function.
    expect(single).toMatch(/lattice_row_visible/);
  });

  it('source visibility reduces to the files row RLS (file-sharing drives it)', () => {
    expect(fnHeader(CLOUD_RLS_BOOTSTRAP_SQL, 'lattice_source_visible')).toMatch(/SECURITY DEFINER/);
    expect(CLOUD_RLS_BOOTSTRAP_SQL).toMatch(
      /lattice_source_visible[\s\S]{0,200}lattice_row_visible\('files'/,
    );
  });
});
