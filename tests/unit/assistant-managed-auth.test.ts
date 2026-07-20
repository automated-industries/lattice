import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveClaudeAuth,
  isManagedModelAuth,
  getAnthropicApiKey,
} from '../../src/gui/assistant-routes.js';

/**
 * Managed-deployment mode (`LATTICE_MANAGED_MODEL_AUTH`): the operator supplies
 * the model credential via the environment, and per-user credentials are ignored
 * so a user cannot substitute their own (and cannot bypass an operator-provided
 * `ANTHROPIC_BASE_URL` endpoint). These tests pin the env directly and pass
 * db=null — managed mode short-circuits BEFORE any stored-credential read, so a
 * connected subscription or workspace key is never consulted.
 */

const saved = {
  managed: process.env.LATTICE_MANAGED_MODEL_AUTH,
  key: process.env.ANTHROPIC_API_KEY,
};

afterEach(() => {
  if (saved.managed === undefined) delete process.env.LATTICE_MANAGED_MODEL_AUTH;
  else process.env.LATTICE_MANAGED_MODEL_AUTH = saved.managed;
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.key;
});

describe('isManagedModelAuth', () => {
  it('is true only when the flag is set to 1/true', () => {
    process.env.LATTICE_MANAGED_MODEL_AUTH = '1';
    expect(isManagedModelAuth()).toBe(true);
    process.env.LATTICE_MANAGED_MODEL_AUTH = 'true';
    expect(isManagedModelAuth()).toBe(true);
    process.env.LATTICE_MANAGED_MODEL_AUTH = '';
    expect(isManagedModelAuth()).toBe(false);
    delete process.env.LATTICE_MANAGED_MODEL_AUTH;
    expect(isManagedModelAuth()).toBe(false);
  });
});

describe('managed model auth resolution', () => {
  it('resolveClaudeAuth uses the operator env key and returns an apiKey (no Bearer)', async () => {
    process.env.LATTICE_MANAGED_MODEL_AUTH = '1';
    process.env.ANTHROPIC_API_KEY = 'operator-key';
    const auth = await resolveClaudeAuth(null);
    expect(auth).toEqual({ apiKey: 'operator-key' });
  });

  it('resolveClaudeAuth returns null when managed but no operator credential is set', async () => {
    process.env.LATTICE_MANAGED_MODEL_AUTH = '1';
    delete process.env.ANTHROPIC_API_KEY;
    expect(await resolveClaudeAuth(null)).toBeNull();
  });

  it('getAnthropicApiKey returns only the operator env key in managed mode', async () => {
    process.env.LATTICE_MANAGED_MODEL_AUTH = '1';
    process.env.ANTHROPIC_API_KEY = 'operator-key';
    expect(await getAnthropicApiKey(null)).toBe('operator-key');
  });
});
