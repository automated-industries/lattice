import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../../src/gui/concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves order regardless of completion time', async () => {
    const items = [50, 10, 30, 5, 20];
    const out = await mapWithConcurrency(items, 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:50', '1:10', '2:30', '3:5', '4:20']);
  });

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    // With 20 items and a real delay the cap should actually be reached.
    expect(maxInFlight).toBe(4);
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    const items = Array.from({ length: 13 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 5, async (n) => {
      seen.push(n);
      return n * 2;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
    expect(out).toEqual(items.map((n) => n * 2));
  });

  it('handles an empty input', async () => {
    const out = await mapWithConcurrency([], 4, async () => {
      throw new Error('should not be called');
    });
    expect(out).toEqual([]);
  });

  it('does not spawn more workers than items', async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    const out = await mapWithConcurrency([1, 2], 16, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(out).toEqual([1, 2]);
  });
});
