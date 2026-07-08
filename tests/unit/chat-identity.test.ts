import { describe, it, expect } from 'vitest';
import { mayReceiveChat } from '../../src/gui/chat-identity.js';
import type { ChatProgressEnvelope } from '../../src/gui/chat-progress.js';

/**
 * The per-user chat-progress delivery gate — the load-bearing defense that keeps one
 * cloud member's streamed chat text off another member's socket (the ChatProgressBus is
 * per-process, shared across every socket). Chat leaked 3× before this class of gate
 * existed, and RLS does not help (the app connects BYPASSRLS) — so the leak cases below
 * are asserts, not nice-to-haves.
 */
const env = (ownerUserId: string | null): ChatProgressEnvelope => ({
  threadId: 't1',
  messageId: 'm1',
  ownerUserId,
  event: { type: 'text_delta', delta: 'secret' },
});

describe('mayReceiveChat (per-user chat-progress gate)', () => {
  it('LOCAL (not cloud): delivers to every socket regardless of owner', () => {
    expect(mayReceiveChat(null, false, env(null))).toBe(true);
    expect(mayReceiveChat(null, false, env('whatever'))).toBe(true);
  });

  it('CLOUD: delivers a turn to the socket owned by the SAME user', () => {
    expect(mayReceiveChat('user-A', true, env('user-A'))).toBe(true);
  });

  it('CLOUD LEAK CASE — member A must NEVER receive member B’s chat', () => {
    expect(mayReceiveChat('user-A', true, env('user-B'))).toBe(false);
  });

  it('CLOUD LEAK CASE — an un-owned (null-owner) turn must never reach a cloud socket', () => {
    expect(mayReceiveChat('user-A', true, env(null))).toBe(false);
  });

  it('CLOUD LEAK CASE — a socket with UNRESOLVED identity receives nothing (fail closed)', () => {
    expect(mayReceiveChat(null, true, env('user-A'))).toBe(false);
    expect(mayReceiveChat(null, true, env(null))).toBe(false);
  });
});
