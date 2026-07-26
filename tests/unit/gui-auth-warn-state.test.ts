import { describe, it, expect, beforeEach } from 'vitest';
import {
  setClaudeAuthWarning,
  clearClaudeAuthWarning,
  getClaudeAuthWarning,
} from '../../src/gui/ai/auth-warn-state.js';

describe('auth-warn-state module-level singleton', () => {
  beforeEach(() => {
    // Reset state before each test
    clearClaudeAuthWarning();
  });

  it('starts with no warning', () => {
    expect(getClaudeAuthWarning()).toBeNull();
  });

  it('sets the warning when setClaudeAuthWarning is called', () => {
    setClaudeAuthWarning();
    const warning = getClaudeAuthWarning();
    expect(warning).not.toBeNull();
    expect(warning?.kind).toBe('reconnect_required');
    expect(warning?.message).toMatch(/reconnect|Claude|expired/i);
  });

  it('clears the warning when clearClaudeAuthWarning is called', () => {
    setClaudeAuthWarning();
    expect(getClaudeAuthWarning()).not.toBeNull();
    clearClaudeAuthWarning();
    expect(getClaudeAuthWarning()).toBeNull();
  });

  it('multiple set calls do not accumulate', () => {
    setClaudeAuthWarning();
    setClaudeAuthWarning();
    const warning = getClaudeAuthWarning();
    expect(warning).not.toBeNull();
    expect(Array.isArray(warning)).toBe(false);
  });

  it('warning object has required fields', () => {
    setClaudeAuthWarning();
    const warning = getClaudeAuthWarning()!;
    expect(warning.kind).toBe('reconnect_required');
    expect(typeof warning.message).toBe('string');
    expect(warning.message.length).toBeGreaterThan(0);
  });
});
