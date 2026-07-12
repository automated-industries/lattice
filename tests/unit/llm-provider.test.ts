import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAssistantCredential } from '../../src/framework/user-config.js';
import {
  resolveLlmProvider,
  resolveVisionAuth,
  resolvedProviderKind,
  isAnthropicEndpoint,
  anthropicBaseFromEndpoint,
  readOpenAiCompatConfig,
  activeProviderKind,
  OPENAI_COMPAT_KIND,
  ACTIVE_PROVIDER_KIND,
} from '../../src/gui/ai/provider.js';
import { resolveClaudeAuth } from '../../src/gui/assistant-routes.js';

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

  // ── One config, wire auto-picked by endpoint ──────────────────────────────
  it('a Claude API key against an Anthropic endpoint resolves on the ANTHROPIC wire', async () => {
    // The SAME "API provider" config (base URL + key + model) — but the endpoint is
    // Anthropic, so it must use the Anthropic client (reusing the subscription/cloud-key
    // code path) and drive the Claude usage-limit UI, NOT the OpenAI-compat client.
    setAssistantCredential(
      OPENAI_COMPAT_KIND,
      JSON.stringify({
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-xxx',
        model: 'claude-sonnet-5',
      }),
    );
    setAssistantCredential(ACTIVE_PROVIDER_KIND, 'openai_compat');
    const p = await resolveLlmProvider(null);
    expect(p?.kind).toBe('anthropic'); // wire picked from the endpoint, not the config slot
    expect(p?.authorModel).toBe('claude-sonnet-5');
    expect(typeof p?.client.runTurn).toBe('function');
  });

  it('a non-Anthropic endpoint stays on the OpenAI-compat wire', async () => {
    setAssistantCredential(
      OPENAI_COMPAT_KIND,
      JSON.stringify({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-4o' }),
    );
    setAssistantCredential(ACTIVE_PROVIDER_KIND, 'openai_compat');
    expect((await resolveLlmProvider(null))?.kind).toBe('openai_compat');
  });

  it('resolvedProviderKind mirrors the resolved wire without building a client', async () => {
    expect(await resolvedProviderKind(null)).toBeNull(); // nothing configured
    setAssistantCredential(
      OPENAI_COMPAT_KIND,
      JSON.stringify({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-4o' }),
    );
    expect(await resolvedProviderKind(null)).toBe('openai_compat');
    setAssistantCredential(
      OPENAI_COMPAT_KIND,
      JSON.stringify({
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant',
        model: 'claude-sonnet-5',
      }),
    );
    expect(await resolvedProviderKind(null)).toBe('anthropic'); // anthropic endpoint → anthropic wire
  });

  it('isAnthropicEndpoint detects Anthropic hosts only', () => {
    expect(isAnthropicEndpoint('https://api.anthropic.com/v1')).toBe(true);
    expect(isAnthropicEndpoint('https://api.anthropic.com/v1/messages')).toBe(true);
    expect(isAnthropicEndpoint('https://eu.anthropic.com')).toBe(true);
    expect(isAnthropicEndpoint('https://api.openai.com/v1')).toBe(false);
    expect(isAnthropicEndpoint('https://anthropic.com.evil.example/v1')).toBe(false);
    expect(isAnthropicEndpoint('not a url')).toBe(false);
  });

  it('anthropicBaseFromEndpoint normalizes to the SDK host origin', () => {
    expect(anthropicBaseFromEndpoint('https://api.anthropic.com')).toBe(
      'https://api.anthropic.com',
    );
    expect(anthropicBaseFromEndpoint('https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com',
    );
    expect(anthropicBaseFromEndpoint('https://api.anthropic.com/v1/messages')).toBe(
      'https://api.anthropic.com',
    );
    expect(anthropicBaseFromEndpoint('https://api.anthropic.com/v1/')).toBe(
      'https://api.anthropic.com',
    );
    // A gateway path that isn't /v1 is preserved (the SDK still appends /v1/messages).
    expect(anthropicBaseFromEndpoint('https://proxy.example.com/anthropic')).toBe(
      'https://proxy.example.com/anthropic',
    );
  });

  // Vision (image/PDF captioning) must accept the SAME credentials chat + text enrichment
  // do. The bug: the narrow `resolveClaudeAuth` used by vision ignored a bring-your-own
  // Claude API key, so a BYO-key user got working chat but images ingested with no
  // description → the file view showed "No source text.".
  it('resolveVisionAuth accepts a BYO Claude API key on an Anthropic endpoint (the bug)', async () => {
    setAssistantCredential(
      OPENAI_COMPAT_KIND,
      JSON.stringify({
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-byo',
        model: 'claude-opus-4-8',
      }),
    );
    setAssistantCredential(ACTIVE_PROVIDER_KIND, 'openai_compat');
    // Root cause: the narrow resolver returns null in exactly this state…
    expect(await resolveClaudeAuth(null)).toBeNull();
    // …while the unified vision resolver returns the usable key, so captions can generate.
    expect(await resolveVisionAuth(null)).toEqual({ apiKey: 'sk-ant-byo' });
  });

  it('resolveVisionAuth gives NO vision auth for a non-Anthropic OpenAI-compat endpoint', async () => {
    // Vision is Anthropic-only; a plain OpenAI/gateway endpoint yields no Anthropic vision
    // auth (and there is no OAuth/managed fallback configured here).
    setAssistantCredential(
      OPENAI_COMPAT_KIND,
      JSON.stringify({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai',
        model: 'gpt-4o',
      }),
    );
    setAssistantCredential(ACTIVE_PROVIDER_KIND, 'openai_compat');
    expect(await resolveVisionAuth(null)).toBeNull();
  });

  it('resolveVisionAuth returns null when nothing is configured (unchanged default)', async () => {
    expect(await resolveVisionAuth(null)).toBeNull();
  });
});
