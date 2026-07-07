import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAssistantCredential } from '../../src/framework/user-config.js';
import {
  resolveLlmProvider,
  readOpenAiCompatConfig,
  activeProviderKind,
  OPENAI_COMPAT_KIND,
  ACTIVE_PROVIDER_KIND,
} from '../../src/gui/ai/provider.js';

/**
 * Provider selection: a user can connect an OpenAI-compatible endpoint as the assistant
 * backend alongside (or instead of) a Claude subscription. Backward-compatible — with
 * nothing configured the resolver prefers Anthropic exactly as before.
 */

describe('LLM provider selection', () => {
  const saved: Record<string, string | undefined> = {};
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), 'lattice-provider-'));
    for (const k of [
      'LATTICE_CONFIG_DIR',
      'LATTICE_ENCRYPTION_KEY',
      'ANTHROPIC_API_KEY',
      'LATTICE_MANAGED_MODEL_AUTH',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.LATTICE_CONFIG_DIR = cfgDir;
    process.env.LATTICE_ENCRYPTION_KEY = 'provider-test-key';
    delete process.env.ANTHROPIC_API_KEY; // no managed/env Claude auth in this test
    delete process.env.LATTICE_MANAGED_MODEL_AUTH;
  });

  afterEach(() => {
    rmSync(cfgDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  it('reads a stored OpenAI-compatible config and rejects an incomplete one', () => {
    expect(readOpenAiCompatConfig()).toBeNull();
    setAssistantCredential(OPENAI_COMPAT_KIND, JSON.stringify({ baseUrl: 'https://x/v1' })); // no model
    expect(readOpenAiCompatConfig()).toBeNull();
    setAssistantCredential(
      OPENAI_COMPAT_KIND,
      JSON.stringify({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'gpt-4o' }),
    );
    expect(readOpenAiCompatConfig()).toEqual({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'gpt-4o',
    });
  });

  it('defaults the active provider to anthropic until explicitly switched', () => {
    expect(activeProviderKind()).toBe('anthropic');
    setAssistantCredential(ACTIVE_PROVIDER_KIND, 'openai_compat');
    expect(activeProviderKind()).toBe('openai_compat');
  });

  it('resolves the OpenAI-compatible provider when selected + configured', async () => {
    setAssistantCredential(
      OPENAI_COMPAT_KIND,
      JSON.stringify({ baseUrl: 'https://gw/v1', apiKey: 'sk', model: 'gpt-4o' }),
    );
    setAssistantCredential(ACTIVE_PROVIDER_KIND, 'openai_compat');
    const p = await resolveLlmProvider(null);
    expect(p?.kind).toBe('openai_compat');
    expect(p?.authorModel).toBe('gpt-4o');
    expect(p?.noteError(new Error('x'))).toBe('other'); // no subscription-limit UI for BYO
    expect(typeof p?.client.runTurn).toBe('function');
  });

  it('returns null when nothing is configured (no Claude, no endpoint)', async () => {
    expect(await resolveLlmProvider(null)).toBeNull();
  });

  it('managed deployment: a user OpenAI endpoint can NOT override the operator env key', async () => {
    // Operator supplies a managed Claude credential; the user tries to point the
    // assistant at their own endpoint and select it. The resolver must ignore it.
    process.env.LATTICE_MANAGED_MODEL_AUTH = '1';
    process.env.ANTHROPIC_API_KEY = 'operator-key';
    setAssistantCredential(
      OPENAI_COMPAT_KIND,
      JSON.stringify({ baseUrl: 'https://user-gw/v1', apiKey: 'u', model: 'gpt-4o' }),
    );
    setAssistantCredential(ACTIVE_PROVIDER_KIND, 'openai_compat');
    const p = await resolveLlmProvider(null);
    expect(p?.kind).toBe('anthropic'); // managed env wins, not the user endpoint
  });

  it('falls back to the OpenAI endpoint when it is configured but Claude is not, even at the default order', async () => {
    // Active selection is the default (anthropic), but Claude is not connected — the
    // resolver should still find the configured OpenAI-compatible endpoint rather than
    // report nothing.
    setAssistantCredential(
      OPENAI_COMPAT_KIND,
      JSON.stringify({ baseUrl: 'https://gw/v1', apiKey: 'sk', model: 'llama-3' }),
    );
    const p = await resolveLlmProvider(null);
    expect(p?.kind).toBe('openai_compat');
    expect(p?.authorModel).toBe('llama-3');
  });
});
