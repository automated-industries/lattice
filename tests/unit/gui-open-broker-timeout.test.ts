import { describe, expect, it } from 'vitest';
import { startBrokerWithinTimeout, BrokerConnectTimeoutError } from '../../src/gui/lifecycle.js';
import type { RealtimeBroker } from '../../src/gui/realtime.js';

/**
 * Regression (Phase 4): openConfig awaited the realtime broker's start()
 * (client.connect + LISTEN) with NO timeout. start() has no connectionTimeoutMillis,
 * so a degraded Postgres that accepts the TCP connection but never completes the
 * startup handshake hung every open path (boot, switch, create, reopen) forever.
 * startBrokerWithinTimeout bounds the connect: a hang throws (loud, fail-fast) and
 * the half-open broker is torn down in the background; a genuine connect rejection
 * still propagates unchanged (openConfig keeps its swallow-to-local-mode path for
 * real failures and only rethrows the timeout).
 */
function fakeBroker(start: () => Promise<void>, onStop?: () => void): RealtimeBroker {
  return {
    start,
    stop: () => {
      onStop?.();
      return Promise.resolve();
    },
  } as unknown as RealtimeBroker;
}

describe('startBrokerWithinTimeout', () => {
  it('returns the started broker on a fast connect', async () => {
    const b = fakeBroker(() => Promise.resolve());
    expect(await startBrokerWithinTimeout(b, 1000)).toBe(b);
  });

  it('throws BrokerConnectTimeoutError + tears down the orphan when connect hangs', async () => {
    let stopped = false;
    const b = fakeBroker(
      () => new Promise<void>(() => undefined), // never resolves — the hang
      () => {
        stopped = true;
      },
    );
    const t0 = Date.now();
    await expect(startBrokerWithinTimeout(b, 40)).rejects.toBeInstanceOf(BrokerConnectTimeoutError);
    expect(Date.now() - t0).toBeLessThan(2000); // bounded — would hang forever before the fix
    await new Promise<void>((r) => setTimeout(r, 20)); // let the fire-and-forget teardown run
    expect(stopped).toBe(true); // half-open broker torn down, no leaked pg socket/LISTEN
  });

  it('propagates a genuine connect rejection unchanged (not a timeout)', async () => {
    const b = fakeBroker(() => Promise.reject(new Error('connect refused')));
    await expect(startBrokerWithinTimeout(b, 1000)).rejects.toThrow('connect refused');
    await expect(startBrokerWithinTimeout(b, 1000)).rejects.not.toBeInstanceOf(BrokerConnectTimeoutError);
  });
});
