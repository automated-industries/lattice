import { describe, it, expect } from 'vitest';
import { ChatProgressBus, type ChatProgressEnvelope } from '../../src/gui/chat-progress.js';

/**
 * The per-workspace bus that carries a chat turn's streamed events to the GUI over
 * `/api/stream` (the async replacement for the held-open POST response). It must deliver
 * to every subscriber, stop cleanly on unsubscribe, and pass the envelope — especially
 * `ownerUserId` — through UNCHANGED, since the Stage-5 forwarder gates delivery per user
 * off that field (a chat is private to its author on a cloud workspace).
 */
describe('ChatProgressBus', () => {
  const env = (over: Partial<ChatProgressEnvelope> = {}): ChatProgressEnvelope => ({
    threadId: 't1',
    messageId: 'm1',
    ownerUserId: null,
    event: { type: 'text_delta', delta: 'hi' },
    ...over,
  });

  it('delivers a published envelope to every subscriber', () => {
    const bus = new ChatProgressBus();
    const a: ChatProgressEnvelope[] = [];
    const b: ChatProgressEnvelope[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    const payload = env();
    bus.publish(payload);
    expect(a).toEqual([payload]);
    expect(b).toEqual([payload]);
    expect(bus.listenerCount()).toBe(2);
  });

  it('stops delivering after unsubscribe (and drops the listener)', () => {
    const bus = new ChatProgressBus();
    const got: ChatProgressEnvelope[] = [];
    const off = bus.subscribe((e) => got.push(e));
    bus.publish(env({ messageId: 'm1' }));
    off();
    bus.publish(env({ messageId: 'm2' }));
    expect(got.map((e) => e.messageId)).toEqual(['m1']);
    expect(bus.listenerCount()).toBe(0);
  });

  it('passes ownerUserId + the event through unchanged', () => {
    const bus = new ChatProgressBus();
    const got: ChatProgressEnvelope[] = [];
    bus.subscribe((e) => got.push(e));
    bus.publish(
      env({ ownerUserId: 'u-42', event: { type: 'assistant_message_end', hadTools: true } }),
    );
    expect(got[0]?.ownerUserId).toBe('u-42');
    expect(got[0]?.event).toEqual({ type: 'assistant_message_end', hadTools: true });
  });
});
