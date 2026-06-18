import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildAnthropicConfig } from '../../src/ai/llm-client.js';
import { buildAnthropicConfig as buildChatConfig } from '../../src/gui/ai/chat.js';
import { buildVisionAnthropicConfig } from '../../src/ai/vision.js';

/**
 * Guards the assistant-auth fix: the Anthropic SDK constructor config must NEVER
 * leave `apiKey` undefined, because the SDK then defaults it from
 * `process.env.ANTHROPIC_API_KEY`. On the OAuth (Bearer token) path that env
 * default would add an `x-api-key` header alongside the `Authorization: Bearer`
 * header, and the API rejects a request carrying both — i.e. an env key would
 * silently break a connected subscription. So `apiKey` is always pinned: to a
 * real key, or explicitly to null.
 */

const savedEnv: string | undefined = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  // Set the env key so a leak (apiKey left undefined) would be observable.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-env-should-not-leak';
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedEnv;
});

describe('buildAnthropicConfig (llm-client)', () => {
  it('OAuth: pins apiKey to null (no env leak) and sets authToken', () => {
    const config = buildAnthropicConfig({ authToken: 'tok' });
    // null is meaningful — it stops the SDK from defaulting apiKey from env.
    expect(config.apiKey).toBeNull();
    expect(config.authToken).toBe('tok');
  });

  it('explicit key: uses the key, sets no authToken', () => {
    const config = buildAnthropicConfig({ apiKey: 'k' });
    expect(config.apiKey).toBe('k');
    expect(config.authToken).toBeUndefined();
  });

  it('no auth: pins apiKey to null so the env key is not leaked', () => {
    const config = buildAnthropicConfig({});
    expect(config.apiKey).toBeNull();
    expect(config.authToken).toBeUndefined();
  });
});

describe('buildAnthropicConfig (gui chat — the live assistant path)', () => {
  it('OAuth: pins apiKey to null (no env leak) and sets authToken', () => {
    const config = buildChatConfig({ authToken: 'tok' });
    expect(config.apiKey).toBeNull();
    expect(config.authToken).toBe('tok');
  });

  it('explicit key: uses the key, sets no authToken', () => {
    const config = buildChatConfig({ apiKey: 'k' });
    expect(config.apiKey).toBe('k');
    expect(config.authToken).toBeUndefined();
  });

  it('no auth: pins apiKey to null so the env key is not leaked', () => {
    const config = buildChatConfig({});
    expect(config.apiKey).toBeNull();
    expect(config.authToken).toBeUndefined();
  });
});

describe('buildVisionAnthropicConfig (vision senders)', () => {
  it('OAuth: pins apiKey to null (no env leak) and sets authToken', () => {
    const config = buildVisionAnthropicConfig({ authToken: 'tok' });
    expect(config.apiKey).toBeNull();
    expect(config.authToken).toBe('tok');
  });

  it('explicit key: uses the key, sets no authToken', () => {
    const config = buildVisionAnthropicConfig({ apiKey: 'k' });
    expect(config.apiKey).toBe('k');
    expect(config.authToken).toBeUndefined();
  });

  it('no auth: pins apiKey to null so the env key is not leaked', () => {
    const config = buildVisionAnthropicConfig({});
    expect(config.apiKey).toBeNull();
    expect(config.authToken).toBeUndefined();
  });
});

describe('no env leak through the real SDK constructor', () => {
  it('OAuth config built here yields a client with apiKey === null (env suppressed)', async () => {
    // End-to-end proof: feed the built OAuth config to the REAL Anthropic ctor
    // and confirm the resolved client carries no api key, even with the env set.
    // The SDK is an optionalDependency; skip cleanly if it is not installed.
    let Anthropic:
      | (new (cfg: Record<string, unknown>) => { apiKey: unknown; authToken: unknown })
      | null = null;
    try {
      const mod = (await import('@anthropic-ai/sdk')) as {
        Anthropic?: new (cfg: Record<string, unknown>) => { apiKey: unknown; authToken: unknown };
        default?: new (cfg: Record<string, unknown>) => { apiKey: unknown; authToken: unknown };
      };
      Anthropic = mod.Anthropic ?? mod.default ?? null;
    } catch {
      Anthropic = null;
    }
    if (!Anthropic) return; // SDK absent — the pure-builder assertions above still cover the fix.
    const client = new Anthropic(buildChatConfig({ authToken: 'tok' }) as Record<string, unknown>);
    expect(client.apiKey).toBeNull();
    expect(client.authToken).toBe('tok');
  });
});
