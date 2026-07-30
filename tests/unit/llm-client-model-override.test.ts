import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Guards the model ID override feature: DEFAULT_MODEL and CHEAPEST_MODEL
 * can be overridden via LATTICE_DEFAULT_MODEL and LATTICE_CHEAPEST_MODEL
 * environment variables, with hardcoded defaults used when env vars are unset.
 */

const savedDefaults = {
  defaultModel: process.env.LATTICE_DEFAULT_MODEL,
  cheapestModel: process.env.LATTICE_CHEAPEST_MODEL,
};

describe('DEFAULT_MODEL env override', () => {
  afterEach(() => {
    // Restore saved env vars and reset modules to reload with original env.
    if (savedDefaults.defaultModel === undefined) {
      delete process.env.LATTICE_DEFAULT_MODEL;
    } else {
      process.env.LATTICE_DEFAULT_MODEL = savedDefaults.defaultModel;
    }
    vi.resetModules();
  });

  it('falls back to hardcoded default when env unset', async () => {
    delete process.env.LATTICE_DEFAULT_MODEL;
    vi.resetModules();
    const { DEFAULT_MODEL } = await import('../../src/ai/llm-client.js');
    expect(DEFAULT_MODEL).toBe('claude-haiku-4-5');
  });

  it('uses env override when LATTICE_DEFAULT_MODEL is set', async () => {
    process.env.LATTICE_DEFAULT_MODEL = 'claude-opus-4-1';
    vi.resetModules();
    const { DEFAULT_MODEL } = await import('../../src/ai/llm-client.js');
    expect(DEFAULT_MODEL).toBe('claude-opus-4-1');
  });
});

describe('CHEAPEST_MODEL env override', () => {
  afterEach(() => {
    // Restore saved env vars and reset modules to reload with original env.
    if (savedDefaults.cheapestModel === undefined) {
      delete process.env.LATTICE_CHEAPEST_MODEL;
    } else {
      process.env.LATTICE_CHEAPEST_MODEL = savedDefaults.cheapestModel;
    }
    vi.resetModules();
  });

  it('falls back to hardcoded default when env unset', async () => {
    delete process.env.LATTICE_CHEAPEST_MODEL;
    vi.resetModules();
    const { CHEAPEST_MODEL } = await import('../../src/ai/llm-client.js');
    expect(CHEAPEST_MODEL).toBe('claude-haiku-4-5');
  });

  it('uses env override when LATTICE_CHEAPEST_MODEL is set', async () => {
    process.env.LATTICE_CHEAPEST_MODEL = 'claude-opus-4-1';
    vi.resetModules();
    const { CHEAPEST_MODEL } = await import('../../src/ai/llm-client.js');
    expect(CHEAPEST_MODEL).toBe('claude-opus-4-1');
  });
});
