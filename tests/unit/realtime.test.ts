import { describe, expect, it } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import {
  CLOUD_NOTIFY_CHANGE_LOG_SQL,
  installCloudInternalTriggers,
} from '../../src/teams/internal-tables.js';
import { RealtimeBroker } from '../../src/gui/realtime.js';

describe('cloud realtime — trigger SQL', () => {
  it('payload mirrors __lattice_change_log columns minus payload_json', () => {
    // The trigger payload is what every SSE consumer receives, so the
    // column list is part of the public contract. Adding a column to
    // __lattice_change_log should require a deliberate update here.
    expect(CLOUD_NOTIFY_CHANGE_LOG_SQL).toContain("'seq', NEW.seq");
    expect(CLOUD_NOTIFY_CHANGE_LOG_SQL).toContain("'team_id', NEW.team_id");
    expect(CLOUD_NOTIFY_CHANGE_LOG_SQL).toContain("'table_name', NEW.table_name");
    expect(CLOUD_NOTIFY_CHANGE_LOG_SQL).toContain("'pk', NEW.pk");
    expect(CLOUD_NOTIFY_CHANGE_LOG_SQL).toContain("'op', NEW.op");
    expect(CLOUD_NOTIFY_CHANGE_LOG_SQL).toContain("'owner_user_id', NEW.owner_user_id");
    expect(CLOUD_NOTIFY_CHANGE_LOG_SQL).toContain("'created_at', NEW.created_at");
    // payload_json is intentionally excluded — clients fetch the row.
    expect(CLOUD_NOTIFY_CHANGE_LOG_SQL).not.toContain("'payload_json'");
  });

  it('uses pg_notify against the lattice_changes channel', () => {
    expect(CLOUD_NOTIFY_CHANGE_LOG_SQL).toContain("pg_notify('lattice_changes',");
  });

  it('trigger is idempotent (DROP IF EXISTS + CREATE OR REPLACE)', () => {
    expect(CLOUD_NOTIFY_CHANGE_LOG_SQL).toContain('CREATE OR REPLACE FUNCTION');
    expect(CLOUD_NOTIFY_CHANGE_LOG_SQL).toContain(
      'DROP TRIGGER IF EXISTS lattice_notify_change_log_trg',
    );
  });

  it('is a no-op on SQLite (LISTEN/NOTIFY is Postgres-only)', async () => {
    // Open an in-memory SQLite Lattice; installer should return without
    // touching the DB. Confirms callers can invoke unconditionally.
    const db = new Lattice(':memory:');
    await db.init();
    await expect(installCloudInternalTriggers(db)).resolves.toBeUndefined();
    db.close();
  });
});

describe('RealtimeBroker', () => {
  it('rejects non-postgres URLs', () => {
    expect(() => new RealtimeBroker('sqlite:///tmp/foo.db')).toThrow(/postgres:\/\//);
    expect(() => new RealtimeBroker('mysql://x@y/z')).toThrow(/postgres:\/\//);
  });

  it("starts in 'connecting' state before start() runs", () => {
    const broker = new RealtimeBroker('postgres://u:p@127.0.0.1:1/x');
    expect(broker.state()).toBe('connecting');
  });

  it('stop() is idempotent and transitions to stopped', async () => {
    const broker = new RealtimeBroker('postgres://u:p@127.0.0.1:1/x');
    await broker.stop();
    expect(broker.state()).toBe('stopped');
    // Second stop is a no-op.
    await broker.stop();
    expect(broker.state()).toBe('stopped');
  });
});
