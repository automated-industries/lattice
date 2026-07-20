import { describe, it, expect, beforeEach } from 'vitest';

import {
  classifyClaudeError,
  noteClaudeError,
  getClaudeLimitState,
  clearClaudeLimit,
  CLAUDE_LIMIT_MESSAGE,
} from '../../src/gui/ai/limit-state.js';

// A 429 with an optional retry-after (seconds). Shape mirrors an Anthropic SDK
// error: `.status` + `.headers`.
function err429(retryAfterSec?: number): { status: number; headers: Record<string, string> } {
  return {
    status: 429,
    headers: retryAfterSec != null ? { 'retry-after': String(retryAfterSec) } : {},
  };
}

describe('classifyClaudeError', () => {
  it('a 429 on the default chat model with no / long retry-after is a usage limit', () => {
    expect(classifyClaudeError(err429())).toBe('usage');
    expect(classifyClaudeError(err429(3600))).toBe('usage');
  });

  it('a 429 with a SHORT retry-after is transient (the SDK already retried)', () => {
    expect(classifyClaudeError(err429(5))).toBe('transient');
  });

  it('a 429 on a NON-default model is an entitlement gap, not a usage limit', () => {
    // The plan lacks that model, so it 429s every call — must NOT flip the banner.
    expect(classifyClaudeError(err429(), 'claude-sonnet-4-6')).toBe('entitlement');
  });

  it('anything that is not a 429 is "other"', () => {
    expect(classifyClaudeError({ status: 500 })).toBe('other');
    expect(classifyClaudeError(new Error('network'))).toBe('other');
    expect(classifyClaudeError(null)).toBe('other');
  });
});

describe('shared usage-limit state', () => {
  beforeEach(() => {
    clearClaudeLimit();
  });

  it('flips ON only for a genuine usage limit — never for transient / entitlement', () => {
    expect(noteClaudeError(err429(5))).toBe('transient');
    expect(getClaudeLimitState()).toBeNull();

    expect(noteClaudeError(err429(), 'claude-sonnet-4-6')).toBe('entitlement');
    expect(getClaudeLimitState()).toBeNull();

    expect(noteClaudeError(err429())).toBe('usage');
    const state = getClaudeLimitState();
    expect(state?.kind).toBe('usage');
    expect(state?.message).toBe(CLAUDE_LIMIT_MESSAGE);
    expect(typeof state?.resetAt).toBe('number');
  });

  it('a retry-after sets the reset horizon; clearClaudeLimit resets it', () => {
    noteClaudeError(err429(7200)); // 2h → a real usage cap
    const state = getClaudeLimitState();
    expect(state).not.toBeNull();
    expect(state!.resetAt).toBeGreaterThan(Date.now());
    clearClaudeLimit(); // a later successful call
    expect(getClaudeLimitState()).toBeNull();
  });
});
