import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setClaudeAuthWarning,
  clearClaudeAuthWarning,
  getClaudeAuthWarning,
} from '../../src/gui/ai/auth-warn-state.js';
import { resolveClaudeAuth } from '../../src/gui/assistant-routes.js';
import {
  setAssistantCredential,
  deleteAssistantCredential,
} from '../../src/framework/user-config.js';

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Reset auth warning state before each test
  clearClaudeAuthWarning();
  // Isolate the env fallback so assertions reflect only the stored credential
  savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // Point the config dir at a fresh temp dir per test
  savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
  savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-assistant-auth-warn-'));
  dirs.push(cfgDir);
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'auth-warn-test-key';
});

afterEach(() => {
  clearClaudeAuthWarning();
  if (savedEnv.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
  if (savedEnv.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
  else process.env.LATTICE_CONFIG_DIR = savedEnv.LATTICE_CONFIG_DIR;
  if (savedEnv.LATTICE_ENCRYPTION_KEY === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
  else process.env.LATTICE_ENCRYPTION_KEY = savedEnv.LATTICE_ENCRYPTION_KEY;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Claude auth warning lifecycle', () => {
  it('starts with no auth warning', () => {
    expect(getClaudeAuthWarning()).toBeNull();
  });

  it('setClaudeAuthWarning sets the warning', () => {
    setClaudeAuthWarning();
    const warning = getClaudeAuthWarning();
    expect(warning).not.toBeNull();
    expect(warning?.kind).toBe('reconnect_required');
  });

  it('clearClaudeAuthWarning clears the warning', () => {
    setClaudeAuthWarning();
    expect(getClaudeAuthWarning()).not.toBeNull();
    clearClaudeAuthWarning();
    expect(getClaudeAuthWarning()).toBeNull();
  });

  it('terminal failure (invalid_grant) sets the warning during token refresh', async () => {
    // Store a valid-looking OAuth credential with an expired access token
    const oauth = {
      access_token: 'expired-at',
      refresh_token: 'the-rt',
      expires_at: Date.now() - 1000, // already expired
    };
    setAssistantCredential('claude_oauth', JSON.stringify(oauth));

    // Mock fetch to simulate an invalid_grant response
    const realFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      fetchCalled = true;
      // Return 400 with invalid_grant error
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }),
        {
          status: 400,
        },
      );
    }) as unknown as typeof fetch;

    try {
      // resolveClaudeAuth should attempt a refresh, detect invalid_grant, and set the warning
      await resolveClaudeAuth(null);
      expect(fetchCalled).toBe(true);
      // The warning is set but auth still returns null (keep the expired subscription)
      expect(getClaudeAuthWarning()).not.toBeNull();
      expect(getClaudeAuthWarning()?.kind).toBe('reconnect_required');
    } finally {
      globalThis.fetch = realFetch;
      deleteAssistantCredential('claude_oauth');
    }
  });

  it('transient failure (5xx) does NOT set the warning', async () => {
    // Store a valid-looking OAuth credential with an expired access token
    const oauth = {
      access_token: 'expired-at',
      refresh_token: 'the-rt',
      expires_at: Date.now() - 1000, // already expired
    };
    setAssistantCredential('claude_oauth', JSON.stringify(oauth));

    // Mock fetch to simulate a transient error (500)
    const realFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      fetchCalled = true;
      return new Response('server error', { status: 500 });
    }) as unknown as typeof fetch;

    try {
      await resolveClaudeAuth(null);
      expect(fetchCalled).toBe(true);
      // Transient failure should NOT set the warning
      expect(getClaudeAuthWarning()).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      deleteAssistantCredential('claude_oauth');
    }
  });

  it('transient failure (network error) does NOT set the warning', async () => {
    // Store a valid-looking OAuth credential with an expired access token
    const oauth = {
      access_token: 'expired-at',
      refresh_token: 'the-rt',
      expires_at: Date.now() - 1000, // already expired
    };
    setAssistantCredential('claude_oauth', JSON.stringify(oauth));

    // Mock fetch to simulate a network error
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('Network error: failed to fetch');
    }) as unknown as typeof fetch;

    try {
      await resolveClaudeAuth(null);
      // Network error should NOT set the warning
      expect(getClaudeAuthWarning()).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      deleteAssistantCredential('claude_oauth');
    }
  });

  it('successful token refresh clears the warning', async () => {
    // Start with a warning already set
    setClaudeAuthWarning();
    expect(getClaudeAuthWarning()).not.toBeNull();

    // Store a valid-looking OAuth credential with an expired access token
    const oauth = {
      access_token: 'expired-at',
      refresh_token: 'the-rt',
      expires_at: Date.now() - 1000, // already expired
    };
    setAssistantCredential('claude_oauth', JSON.stringify(oauth));

    // Mock fetch to simulate a successful refresh
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      const auth = await resolveClaudeAuth(null);
      // Successful refresh should clear the warning
      expect(getClaudeAuthWarning()).toBeNull();
      expect(auth).not.toBeNull();
      expect(auth!.authToken).toBe('new-at');
    } finally {
      globalThis.fetch = realFetch;
      deleteAssistantCredential('claude_oauth');
    }
  });
});
