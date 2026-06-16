import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  urlIngestConfig,
  assertUrlPolicy,
  Semaphore,
  FetchBudget,
  takeHostSlot,
  resetFetchPolicyState,
  type UrlIngestConfig,
} from '../../src/ai/fetch-policy.js';

const BASE: UrlIngestConfig = {
  enabled: true,
  maxBytes: 1_000_000,
  timeoutMs: 5_000,
  maxConcurrency: 2,
  fetchBudget: 5,
  hostMinIntervalMs: 0,
  allowDomains: [],
  blockDomains: [],
};

describe('urlIngestConfig (env)', () => {
  const KEYS = [
    'LATTICE_URL_INGEST',
    'LATTICE_URL_MAX_BYTES',
    'LATTICE_URL_MAX_CONCURRENCY',
    'LATTICE_URL_FETCH_BUDGET',
    'LATTICE_URL_ALLOW_DOMAINS',
    'LATTICE_URL_BLOCK_DOMAINS',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });

  it('defaults are conservative and on', () => {
    for (const k of KEYS) Reflect.deleteProperty(process.env, k);
    const cfg = urlIngestConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxConcurrency).toBeGreaterThanOrEqual(1);
    expect(cfg.fetchBudget).toBeGreaterThanOrEqual(1);
    expect(cfg.allowDomains).toEqual([]);
    expect(cfg.blockDomains).toEqual([]);
  });

  it('reads overrides and parses domain lists (lowercased, trimmed)', () => {
    process.env.LATTICE_URL_INGEST = 'off';
    process.env.LATTICE_URL_MAX_BYTES = '2048';
    process.env.LATTICE_URL_FETCH_BUDGET = '3';
    process.env.LATTICE_URL_ALLOW_DOMAINS = 'Example.com, docs.foo.io ';
    process.env.LATTICE_URL_BLOCK_DOMAINS = 'evil.test';
    const cfg = urlIngestConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxBytes).toBe(2048);
    expect(cfg.fetchBudget).toBe(3);
    expect(cfg.allowDomains).toEqual(['example.com', 'docs.foo.io']);
    expect(cfg.blockDomains).toEqual(['evil.test']);
  });
});

const checkPolicy = (url: string, cfg: UrlIngestConfig): (() => void) => {
  return () => {
    assertUrlPolicy(new URL(url), cfg);
  };
};

describe('assertUrlPolicy', () => {
  it('passes any host with the default (empty-list) config', () => {
    expect(checkPolicy('https://anything.example/x', BASE)).not.toThrow();
  });

  it('throws when ingestion is disabled', () => {
    expect(checkPolicy('https://a.example', { ...BASE, enabled: false })).toThrow(/disabled/i);
  });

  it('refuses a block-listed host (incl. subdomains)', () => {
    const cfg = { ...BASE, blockDomains: ['evil.test'] };
    expect(checkPolicy('https://evil.test/x', cfg)).toThrow(/block-list/i);
    expect(checkPolicy('https://api.evil.test/x', cfg)).toThrow(/block-list/i);
    expect(checkPolicy('https://ok.test/x', cfg)).not.toThrow();
  });

  it('with an allow-list, only listed hosts (and their subdomains) pass', () => {
    const cfg = { ...BASE, allowDomains: ['good.test'] };
    expect(checkPolicy('https://good.test/x', cfg)).not.toThrow();
    expect(checkPolicy('https://docs.good.test/x', cfg)).not.toThrow();
    expect(checkPolicy('https://other.test/x', cfg)).toThrow(/allow-list/i);
  });
});

describe('Semaphore', () => {
  it('allows up to `max` holders and queues the rest FIFO', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    let third = false;
    const p3 = sem.acquire().then((rel) => {
      third = true;
      return rel;
    });
    // Third acquire is parked — both permits are held.
    await Promise.resolve();
    expect(third).toBe(false);
    r1(); // hand the permit to the waiter
    const r3 = await p3;
    expect(third).toBe(true);
    r2();
    r3();
  });

  it('a double-release is a no-op (does not over-grant permits)', async () => {
    const sem = new Semaphore(1);
    const rel = await sem.acquire();
    rel();
    rel(); // second call must do nothing
    // Only one permit should exist: acquire, then the next acquire must park.
    await sem.acquire();
    let got = false;
    void sem.acquire().then(() => (got = true));
    await Promise.resolve();
    expect(got).toBe(false);
  });
});

describe('FetchBudget', () => {
  it('allows `max` takes then throws', () => {
    const b = new FetchBudget(2);
    expect(b.remaining).toBe(2);
    b.take();
    b.take();
    expect(b.remaining).toBe(0);
    expect(() => {
      b.take();
    }).toThrow(/budget exhausted/i);
  });
});

describe('takeHostSlot', () => {
  beforeEach(() => {
    resetFetchPolicyState();
  });
  afterEach(() => {
    resetFetchPolicyState();
  });

  it('returns immediately for the first call and throttles the second to the same host', async () => {
    const t0 = Date.now();
    await takeHostSlot('host.test', 60);
    const firstElapsed = Date.now() - t0;
    expect(firstElapsed).toBeLessThan(40);
    const t1 = Date.now();
    await takeHostSlot('host.test', 60);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(40);
  });

  it('does not throttle across different hosts', async () => {
    await takeHostSlot('a.test', 1000);
    const t = Date.now();
    await takeHostSlot('b.test', 1000);
    expect(Date.now() - t).toBeLessThan(40);
  });
});
