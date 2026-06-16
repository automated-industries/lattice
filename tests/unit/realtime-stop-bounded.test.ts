import { afterEach, describe, expect, it } from 'vitest';
import { RealtimeBroker } from '../../src/gui/realtime.js';

/**
 * Regression: a transaction-mode pooler can drop a LISTEN and leave a wedged /
 * half-open socket, so pg's `client.end()` never resolves. stop() used to
 * `await client.end()` unbounded, hanging forever — which froze workspace
 * switches (the GUI awaits stop() while tearing the previous workspace down).
 * stop() now bounds the graceful close and force-destroys the socket on timeout,
 * so it always returns promptly AND releases the connection (no leak). Driven via
 * the clientFactory seam — no real Postgres.
 */
const URL = 'postgres://u:p@localhost:5432/db';

// Resolvers for `end()` promises we leave pending (the wedged close). Drained
// after each test so nothing stays unsettled across the file.
const pendingEnds: (() => void)[] = [];
afterEach(() => {
  for (const resolve of pendingEnds.splice(0)) resolve();
});

interface FakeClient {
  on(): this;
  connect(): Promise<void>;
  query(): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  connection: { stream: { destroy: () => void } };
}

function makeClient(opts: { endResolves: boolean; onDestroy: () => void }): FakeClient {
  return {
    on() {
      return this;
    },
    connect() {
      return Promise.resolve();
    },
    query() {
      return Promise.resolve({ rows: [] });
    },
    end() {
      if (opts.endResolves) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pendingEnds.push(resolve); // never settles during the test — the wedged close
      });
    },
    connection: { stream: { destroy: opts.onDestroy } },
  };
}

describe('RealtimeBroker.stop() — bounded close', () => {
  it('returns promptly and force-destroys the socket when client.end() hangs', async () => {
    let destroyed = 0;
    const client = makeClient({ endResolves: false, onDestroy: () => (destroyed += 1) });
    const broker = new RealtimeBroker(URL, {
      watchdogIntervalMs: 0,
      stopEndTimeoutMs: 30,
      clientFactory: () => client as never,
    });
    await broker.start();
    const t0 = Date.now();
    await broker.stop();
    // Before the fix this awaited a never-resolving end() forever.
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(destroyed).toBe(1); // socket force-closed → connection released, not leaked
  });

  it('closes gracefully (no force-destroy) when client.end() resolves normally', async () => {
    let destroyed = 0;
    const client = makeClient({ endResolves: true, onDestroy: () => (destroyed += 1) });
    const broker = new RealtimeBroker(URL, {
      watchdogIntervalMs: 0,
      stopEndTimeoutMs: 1000,
      clientFactory: () => client as never,
    });
    await broker.start();
    await broker.stop();
    expect(destroyed).toBe(0); // graceful close won the race — no force-destroy
  });
});
