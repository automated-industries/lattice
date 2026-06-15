import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RealtimeBroker, type RealtimePayload } from '../../src/gui/realtime.js';

/**
 * The realtime backstop watchdog: a transaction-mode pooler / managed-Postgres
 * proxy can silently drop a LISTEN registration WITHOUT closing the socket, so
 * the broker sits "connected" receiving zero NOTIFYs forever. The watchdog
 * periodically re-runs the bounded, visibility-gated `lattice_changes_since`
 * query so missed changes are still delivered — detect + recover in one. These
 * tests drive it via the clientFactory seam + fake timers, no real Postgres.
 */
type Handler = (arg?: unknown) => void;
class FakeClient {
  readonly handlers = new Map<string, Handler[]>();
  readonly queries: { sql: string; params?: unknown[] }[] = [];
  constructor(
    private readonly respond: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[] }>,
  ) {}
  on(ev: string, h: Handler): this {
    const a = this.handlers.get(ev) ?? [];
    a.push(h);
    this.handlers.set(ev, a);
    return this;
  }
  fire(ev: string, arg?: unknown): void {
    for (const h of this.handlers.get(ev) ?? []) h(arg);
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.queries.push({ sql, params });
    return this.respond(sql, params);
  }
  end(): Promise<void> {
    return Promise.resolve();
  }
}

const URL = 'postgres://u:p@localhost:5432/db';
const SINCE = 'lattice_changes_since';
const row = (seq: number): Record<string, unknown> => ({
  seq,
  table_name: 'contact',
  pk: `r${String(seq)}`,
  op: 'upsert',
  owner_role: 'lm_a',
  created_at: '2026-01-01T00:00:00Z',
});
/** Push the cursor (lastSeq) past 0 — the poll's guard — via a live NOTIFY. */
function notify(c: FakeClient, seq: number): void {
  c.fire('notification', { channel: 'lattice_changes', payload: JSON.stringify(row(seq)) });
}
function sinceCalls(c: FakeClient): { sql: string; params?: unknown[] }[] {
  return c.queries.filter((q) => q.sql.includes(SINCE));
}

describe('RealtimeBroker watchdog (silent-LISTEN-drop backstop)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls lattice_changes_since past the cursor and delivers the missed rows', async () => {
    let sinceRows: Record<string, unknown>[] = [row(6), row(7)];
    const c = new FakeClient((sql) =>
      Promise.resolve({ rows: sql.includes(SINCE) ? sinceRows : [] }),
    );
    const broker = new RealtimeBroker(URL, { watchdogIntervalMs: 20, clientFactory: () => c });
    const seen: RealtimePayload[] = [];
    broker.subscribePayload((p) => seen.push(p));
    await broker.start();
    notify(c, 5); // cursor → 5
    sinceRows = [row(6), row(7)];

    await vi.advanceTimersByTimeAsync(20);

    const polls = sinceCalls(c);
    expect(polls).toHaveLength(1);
    expect(polls[0]?.params).toEqual([5, 500]); // [lastSeq, CATCHUP_LIMIT]
    expect(seen.map((p) => p.seq)).toEqual([5, 6, 7]); // the notify + the two missed
    await broker.stop();
  });

  it('advances the cursor so the next poll never re-fetches delivered rows', async () => {
    let sinceRows: Record<string, unknown>[] = [row(6), row(7)];
    const c = new FakeClient((sql) =>
      Promise.resolve({ rows: sql.includes(SINCE) ? sinceRows : [] }),
    );
    const broker = new RealtimeBroker(URL, { watchdogIntervalMs: 20, clientFactory: () => c });
    await broker.start();
    notify(c, 5);

    await vi.advanceTimersByTimeAsync(20); // delivers 6,7 → cursor 7
    sinceRows = []; // nothing new
    await vi.advanceTimersByTimeAsync(20);

    const polls = sinceCalls(c);
    expect(polls).toHaveLength(2);
    expect(polls[0]?.params).toEqual([5, 500]);
    expect(polls[1]?.params).toEqual([7, 500]); // advanced past what it delivered
    await broker.stop();
  });

  it('overlap guard: a slow poll never starts a second concurrent query', async () => {
    let release!: (v: { rows: Record<string, unknown>[] }) => void;
    const pending = new Promise<{ rows: Record<string, unknown>[] }>((r) => (release = r));
    const c = new FakeClient((sql) =>
      sql.includes(SINCE) ? pending : Promise.resolve({ rows: [] }),
    );
    const broker = new RealtimeBroker(URL, { watchdogIntervalMs: 20, clientFactory: () => c });
    await broker.start();
    notify(c, 5);

    await vi.advanceTimersByTimeAsync(20); // poll #1 starts, hangs
    await vi.advanceTimersByTimeAsync(20); // tick #2 — must be skipped (in flight)
    expect(sinceCalls(c)).toHaveLength(1);

    release({ rows: [] });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20); // now a fresh poll may run
    expect(sinceCalls(c)).toHaveLength(2);
    await broker.stop();
  });

  it('is disabled when the interval is 0 (no poll ever fires)', async () => {
    const c = new FakeClient((sql) =>
      Promise.resolve({ rows: sql.includes(SINCE) ? [row(6)] : [] }),
    );
    const broker = new RealtimeBroker(URL, { watchdogIntervalMs: 0, clientFactory: () => c });
    await broker.start();
    notify(c, 5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sinceCalls(c)).toHaveLength(0);
    await broker.stop();
  });

  it('stops polling after stop()', async () => {
    const c = new FakeClient((sql) => Promise.resolve({ rows: sql.includes(SINCE) ? [] : [] }));
    const broker = new RealtimeBroker(URL, { watchdogIntervalMs: 20, clientFactory: () => c });
    await broker.start();
    notify(c, 5);
    await vi.advanceTimersByTimeAsync(20);
    const before = sinceCalls(c).length;
    await broker.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(sinceCalls(c).length).toBe(before); // no further polls
  });

  it('a poll error does not throw or reconnect — stays connected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let fail = false;
    const c = new FakeClient((sql) => {
      if (sql.includes(SINCE) && fail) return Promise.reject(new Error('pooler dropped'));
      return Promise.resolve({ rows: [] });
    });
    const broker = new RealtimeBroker(URL, { watchdogIntervalMs: 20, clientFactory: () => c });
    await broker.start();
    notify(c, 5);
    fail = true;
    await vi.advanceTimersByTimeAsync(20);
    expect(broker.state()).toBe('connected'); // no reconnect on a poll error
    expect(warn).toHaveBeenCalled();
    await broker.stop();
    warn.mockRestore();
  });
});
