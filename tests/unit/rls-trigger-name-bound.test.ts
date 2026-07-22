import { describe, it, expect } from 'vitest';
import { tableRlsSql } from '../../src/cloud/rls.js';

/**
 * Release-review blocker: the per-table RLS ownership trigger AND its schema-global
 * trigger function share one name, `lattice_track_<table>`. Postgres SILENTLY truncates
 * any identifier to 63 bytes, so two distinct connector tables whose names share a long
 * prefix would collapse to the SAME truncated function name — the second CREATE OR
 * REPLACE FUNCTION overwrites the first and corrupts row-ownership on a cloud. (SQLite
 * has no 63-byte limit, so CI never sees it.) The name must be bounded + collision-free.
 */
function trgName(sql: string): string {
  const m = /CREATE OR REPLACE FUNCTION "([^"]+)"\(\) RETURNS trigger/.exec(sql);
  if (!m || !m[1]) throw new Error('could not find the trigger function name in the SQL');
  return m[1];
}

describe('RLS trigger/function name stays within the Postgres 63-byte identifier limit', () => {
  it('a short table name yields the plain lattice_track_<table> name', () => {
    expect(trgName(tableRlsSql('jira_issues', ['id'], 'g'))).toBe('lattice_track_jira_issues');
  });

  it('a long table name is bounded to <= 63 bytes', () => {
    const long = 'mcp_' + 'a'.repeat(55) + '_deduction_types';
    expect(Buffer.byteLength(trgName(tableRlsSql(long, ['id'], 'g')), 'utf8')).toBeLessThanOrEqual(
      63,
    );
  });

  it('two long tables sharing their first 49 bytes get DISTINCT bounded names (no truncation collision)', () => {
    const base = 'mcp_' + 'a'.repeat(50) + '_deduction_';
    const a = trgName(tableRlsSql(base + 'types', ['id'], 'g'));
    const b = trgName(tableRlsSql(base + 'records', ['id'], 'g'));
    expect(Buffer.byteLength(a, 'utf8')).toBeLessThanOrEqual(63);
    expect(Buffer.byteLength(b, 'utf8')).toBeLessThanOrEqual(63);
    expect(a).not.toBe(b); // the hash suffix keeps them distinct — the whole point
  });

  it('the trigger and its function keep the SAME (bounded) name so they stay paired', () => {
    const long = 'mcp_' + 'b'.repeat(60) + '_x';
    const sql = tableRlsSql(long, ['id'], 'g');
    const fn = trgName(sql);
    expect(sql).toContain(`CREATE TRIGGER "${fn}"`);
    expect(sql).toContain(`EXECUTE FUNCTION "${fn}"()`);
  });
});
