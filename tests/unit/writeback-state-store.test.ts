import { describe, it, expect } from 'vitest';
import { InMemoryStateStore } from '../../src/writeback/state-store.js';

describe('InMemoryStateStore — bounded seen-set', () => {
  it('is unbounded by default (no behavior change)', () => {
    const store = new InMemoryStateStore();
    const file = '/tmp/log.md';

    // Mark far more keys than any reasonable cap would allow.
    for (let i = 0; i < 10_000; i++) {
      store.markSeen(file, `key-${i}`);
    }

    // Every single key — including the very first — must still be present.
    expect(store.isSeen(file, 'key-0')).toBe(true);
    expect(store.isSeen(file, 'key-5000')).toBe(true);
    expect(store.isSeen(file, 'key-9999')).toBe(true);
  });

  it('caps the per-file set to N, evicting the oldest after N+1 markSeen', () => {
    const cap = 3;
    const store = new InMemoryStateStore({ maxSeenPerFile: cap });
    const file = '/tmp/log.md';

    // Insert exactly the cap — all present, none evicted yet.
    store.markSeen(file, 'a');
    store.markSeen(file, 'b');
    store.markSeen(file, 'c');
    expect(store.isSeen(file, 'a')).toBe(true);
    expect(store.isSeen(file, 'b')).toBe(true);
    expect(store.isSeen(file, 'c')).toBe(true);

    // The N+1th insert evicts the OLDEST key ('a') and keeps the newest ('d').
    store.markSeen(file, 'd');
    expect(store.isSeen(file, 'a')).toBe(false); // oldest gone
    expect(store.isSeen(file, 'b')).toBe(true);
    expect(store.isSeen(file, 'c')).toBe(true);
    expect(store.isSeen(file, 'd')).toBe(true); // newest present
  });

  it('keeps size at or below the cap across many inserts', () => {
    const cap = 5;
    const store = new InMemoryStateStore({ maxSeenPerFile: cap });
    const file = '/tmp/log.md';

    for (let i = 0; i < 100; i++) {
      store.markSeen(file, `k-${i}`);
    }

    // Only the most-recent `cap` keys survive; everything older is evicted.
    for (let i = 0; i < 95; i++) {
      expect(store.isSeen(file, `k-${i}`)).toBe(false);
    }
    for (let i = 95; i < 100; i++) {
      expect(store.isSeen(file, `k-${i}`)).toBe(true);
    }
  });

  it('caps each file independently', () => {
    const cap = 2;
    const store = new InMemoryStateStore({ maxSeenPerFile: cap });
    const fileA = '/tmp/a.md';
    const fileB = '/tmp/b.md';

    store.markSeen(fileA, 'a1');
    store.markSeen(fileA, 'a2');
    store.markSeen(fileB, 'b1');
    store.markSeen(fileB, 'b2');

    // Both files at the cap, all present.
    expect(store.isSeen(fileA, 'a1')).toBe(true);
    expect(store.isSeen(fileB, 'b1')).toBe(true);

    // Overflow fileA only — fileB is untouched.
    store.markSeen(fileA, 'a3');
    expect(store.isSeen(fileA, 'a1')).toBe(false); // evicted from A
    expect(store.isSeen(fileA, 'a3')).toBe(true);
    expect(store.isSeen(fileB, 'b1')).toBe(true); // B unaffected
    expect(store.isSeen(fileB, 'b2')).toBe(true);
  });

  it('re-marking an existing key does not change the cap accounting', () => {
    const cap = 2;
    const store = new InMemoryStateStore({ maxSeenPerFile: cap });
    const file = '/tmp/log.md';

    store.markSeen(file, 'a');
    store.markSeen(file, 'b');
    // Re-mark 'a' — already present, so set size stays 2 (Set.add is idempotent).
    store.markSeen(file, 'a');
    expect(store.isSeen(file, 'a')).toBe(true);
    expect(store.isSeen(file, 'b')).toBe(true);

    // Next distinct key evicts the oldest still-present key.
    store.markSeen(file, 'c');
    expect(store.isSeen(file, 'c')).toBe(true);
  });
});
