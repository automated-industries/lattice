import { describe, it, expect } from 'vitest';
import { RenderProgressBus } from '../../src/gui/render-progress.js';
import type { RenderProgress } from '../../src/render/progress.js';

const mk = (overrides: Partial<RenderProgress> = {}): RenderProgress => ({
  kind: 'table-progress',
  table: 't',
  entitiesRendered: 1,
  entitiesTotal: 2,
  tableIndex: 0,
  tableCount: 1,
  pct: 50,
  ...overrides,
});

describe('RenderProgressBus', () => {
  it('delivers published events to subscribers', () => {
    const bus = new RenderProgressBus();
    const received: RenderProgress[] = [];
    bus.subscribe((e) => received.push(e));

    const e1 = mk({ entitiesRendered: 1 });
    const e2 = mk({ entitiesRendered: 2, kind: 'table-done', pct: 100 });
    bus.publish(e1);
    bus.publish(e2);

    expect(received).toEqual([e1, e2]);
  });

  it('latest() returns null before any publish, then the most recent event', () => {
    const bus = new RenderProgressBus();
    expect(bus.latest()).toBeNull();

    const first = mk({ entitiesRendered: 1 });
    bus.publish(first);
    expect(bus.latest()).toEqual(first);

    const second = mk({ kind: 'done', table: null, pct: 100, durationMs: 12 });
    bus.publish(second);
    expect(bus.latest()).toEqual(second);
  });

  it('unsubscribe stops further delivery without affecting other subscribers', () => {
    const bus = new RenderProgressBus();
    const a: RenderProgress[] = [];
    const b: RenderProgress[] = [];
    const offA = bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.publish(mk({ entitiesRendered: 1 }));
    offA();
    bus.publish(mk({ entitiesRendered: 2 }));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it('does not keep a bounded replay buffer — only latest() is retained', () => {
    const bus = new RenderProgressBus();
    // No subscribers yet; publish many events.
    for (let i = 0; i < 250; i++) bus.publish(mk({ entitiesRendered: i }));
    // A late subscriber receives nothing retroactively; only latest() persists.
    const late: RenderProgress[] = [];
    bus.subscribe((e) => late.push(e));
    expect(late).toHaveLength(0);
    expect(bus.latest()!.entitiesRendered).toBe(249);
  });

  it('supports many concurrent subscribers (multi-tab)', () => {
    const bus = new RenderProgressBus();
    const counts: number[] = [];
    for (let i = 0; i < 50; i++) {
      let n = 0;
      bus.subscribe(() => {
        n++;
        counts[i] = n;
      });
    }
    expect(bus.listenerCount()).toBe(50);
    bus.publish(mk());
    expect(counts.every((c) => c === 1)).toBe(true);
  });
});
