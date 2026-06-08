import { describe, it, expect } from 'vitest';
import { FeedBus } from '../../src/gui/feed.js';

describe('FeedBus', () => {
  it('assigns monotonically increasing sequence numbers', () => {
    const bus = new FeedBus();
    const a = bus.publish({ table: 'people', op: 'insert', rowId: '1', source: 'gui' });
    const b = bus.publish({ table: 'people', op: 'update', rowId: '1', source: 'ai' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it('fills in a timestamp when none is provided', () => {
    const bus = new FeedBus();
    const e = bus.publish({ table: 'people', op: 'insert', rowId: '1', source: 'gui' });
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves an explicit timestamp + summary', () => {
    const bus = new FeedBus();
    const e = bus.publish({
      table: 'projects',
      op: 'insert',
      rowId: 'p1',
      source: 'command',
      ts: '2026-01-01T00:00:00.000Z',
      summary: 'Created row in Projects',
    });
    expect(e.ts).toBe('2026-01-01T00:00:00.000Z');
    expect(e.summary).toBe('Created row in Projects');
  });

  it('delivers events to subscribers and stops after unsubscribe', () => {
    const bus = new FeedBus();
    const received: number[] = [];
    const off = bus.subscribe((e) => received.push(e.seq));
    bus.publish({ table: 'people', op: 'insert', rowId: '1', source: 'gui' });
    bus.publish({ table: 'people', op: 'insert', rowId: '2', source: 'gui' });
    off();
    bus.publish({ table: 'people', op: 'insert', rowId: '3', source: 'gui' });
    expect(received).toEqual([1, 2]);
    expect(bus.listenerCount()).toBe(0);
  });

  it('replays only the most recent events via recent(n)', () => {
    const bus = new FeedBus(3);
    for (let i = 0; i < 5; i++) {
      bus.publish({ table: 't', op: 'insert', rowId: String(i), source: 'gui' });
    }
    const last = bus.recent(2);
    expect(last.map((e) => e.rowId)).toEqual(['3', '4']);
    // Buffer is bounded to 3, so the oldest events were evicted.
    expect(bus.recent(10)).toHaveLength(3);
  });

  it('recent(0) returns an empty array', () => {
    const bus = new FeedBus();
    bus.publish({ table: 't', op: 'insert', rowId: '1', source: 'gui' });
    expect(bus.recent(0)).toEqual([]);
  });

  it('rejects a non-positive buffer size', () => {
    expect(() => new FeedBus(0)).toThrow();
  });
});
