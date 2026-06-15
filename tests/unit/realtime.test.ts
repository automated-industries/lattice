import { describe, expect, it } from 'vitest';
import { RealtimeBroker, feedOpForChange, parsePayload } from '../../src/gui/realtime.js';

describe('#4.1 feedOpForChange — the change feed op domain is upsert|delete', () => {
  it('maps the real change-feed ops (upsert → update, delete → delete)', () => {
    // The bug: the feed merge matched only INSERT/UPDATE/DELETE, so every real
    // `upsert`/`delete` envelope mapped to null and was dropped.
    expect(feedOpForChange('upsert')).toBe('update');
    expect(feedOpForChange('delete')).toBe('delete');
  });
  it('still accepts legacy uppercase forms (forward-compat)', () => {
    expect(feedOpForChange('INSERT')).toBe('update');
    expect(feedOpForChange('UPDATE')).toBe('update');
    expect(feedOpForChange('DELETE')).toBe('delete');
  });
  it('returns null for anything else (skip)', () => {
    expect(feedOpForChange('schema')).toBeNull();
    expect(feedOpForChange('')).toBeNull();
  });
});

describe('#4.2 parsePayload — mirrors the NOTIFY trigger json_build_object', () => {
  it('extracts owner_role + keeps op=upsert from a trigger-shaped envelope', () => {
    const raw = JSON.stringify({
      seq: 7,
      table_name: 'contact',
      pk: 'r1',
      op: 'upsert',
      owner_role: 'lm_alice',
      created_at: '2026-01-01T00:00:00Z',
    });
    const p = parsePayload(raw);
    expect(p).not.toBeNull();
    // The pre-3.2 parser read team_id/owner_user_id/client_ts (never emitted) and
    // dropped owner_role — so the editor never resolved. It must resolve now.
    expect(p!.owner_role).toBe('lm_alice');
    expect(p!.op).toBe('upsert');
    expect(p!.seq).toBe(7);
    expect(p!.table_name).toBe('contact');
    expect(p!.pk).toBe('r1');
    // The removed fields are gone from the shape.
    expect(p as unknown as Record<string, unknown>).not.toHaveProperty('owner_user_id');
    expect(p as unknown as Record<string, unknown>).not.toHaveProperty('team_id');
    expect(p as unknown as Record<string, unknown>).not.toHaveProperty('client_ts');
  });
  it('returns null for malformed / non-change JSON', () => {
    expect(parsePayload(undefined)).toBeNull();
    expect(parsePayload('not json')).toBeNull();
    expect(parsePayload(JSON.stringify({ table_name: 'x' }))).toBeNull(); // no seq/op
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
