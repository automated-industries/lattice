import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { CLOUD_INTERNAL_TABLE_DEFS } from '../../src/teams/internal-tables.js';
import { appendChangeEnvelope, findEnvelopeByEditId } from '../../src/teams/team-core.js';

/**
 * Phase A — change envelopes carry a `client_ts` distinct from the
 * server-receipt `created_at`, so an offline replay preserves the true edit
 * time while `seq` stays the authoritative monotonic ordering key. Exercised
 * on SQLite by registering the cloud change-log table directly (the real
 * NOTIFY trigger is Postgres-only and verified manually at release time).
 */
describe('appendChangeEnvelope — client_ts', () => {
  let tmpDir: string;
  let db: Lattice;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-envelope-'));
    db = new Lattice(join(tmpDir, 't.db'));
    const def = CLOUD_INTERNAL_TABLE_DEFS.__lattice_change_log;
    if (!def) throw new Error('change-log def missing');
    db.define('__lattice_change_log', def);
    await db.init();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults client_ts to the server-receipt time when omitted', async () => {
    const seq = await appendChangeEnvelope(db, {
      team_id: 'team-1',
      table_name: 'widgets',
      pk: 'w1',
      op: 'upsert',
      payload_json: JSON.stringify({ id: 'w1', name: 'A' }),
      owner_user_id: 'me',
    });
    expect(seq).toBe(1);
    const rows = (await db.query('__lattice_change_log', {})) as unknown as {
      seq: number;
      client_ts: string | null;
      created_at: string;
      owner_user_id: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.client_ts).toBe(rows[0]?.created_at);
    expect(rows[0]?.owner_user_id).toBe('me');
  });

  it('records an explicit client_ts (offline replay) and increments seq per team', async () => {
    const editedAt = '2020-02-02T02:02:02.000Z';
    await appendChangeEnvelope(db, {
      team_id: 'team-1',
      table_name: 'widgets',
      pk: 'w1',
      op: 'upsert',
      payload_json: '{}',
      owner_user_id: 'me',
      client_ts: editedAt,
    });
    const seq2 = await appendChangeEnvelope(db, {
      team_id: 'team-1',
      table_name: 'widgets',
      pk: 'w1',
      op: 'delete',
      payload_json: null,
      owner_user_id: 'me',
    });
    expect(seq2).toBe(2);
    const rows = (await db.query('__lattice_change_log', {
      orderBy: 'seq',
      orderDir: 'asc',
    })) as unknown as { seq: number; client_ts: string | null; created_at: string }[];
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    // The replayed edit kept its true edit time; seq still orders by arrival.
    expect(rows[0]?.client_ts).toBe(editedAt);
    expect(rows[0]?.client_ts).not.toBe(rows[0]?.created_at);
  });

  it('findEnvelopeByEditId locates a prior edit for idempotent offline replay', async () => {
    expect(await findEnvelopeByEditId(db, 'team-1', 'edit-abc')).toBeNull();
    await appendChangeEnvelope(db, {
      team_id: 'team-1',
      table_name: 'widgets',
      pk: 'w9',
      op: 'upsert',
      payload_json: '{}',
      owner_user_id: 'me',
      edit_id: 'edit-abc',
    });
    const found = await findEnvelopeByEditId(db, 'team-1', 'edit-abc');
    expect(found).not.toBeNull();
    expect(found?.pk).toBe('w9');
    // Scoped per team — a different team doesn't see it.
    expect(await findEnvelopeByEditId(db, 'team-2', 'edit-abc')).toBeNull();
  });
});
