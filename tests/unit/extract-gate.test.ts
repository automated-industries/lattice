import { describe, it, expect } from 'vitest';
import { withHeavyExtractionGate, HEAVY_EXTRACT_BYTES } from '../../src/gui/ai/extract-gate.js';

/**
 * Regression: bulk folder ingest ran several large-document extractions at once
 * inside the packaged desktop runtime and exhausted the JS heap (V8
 * "Ineffective mark-compacts near heap limit" abort). Extraction transients are
 * input-side — full archive inflation, PDF parse graphs, a base64 copy of the
 * whole file in the scanned-PDF request body — so concurrency × peak-transient
 * is what has to fit the heap. Files at/above the heavy threshold must extract
 * one at a time through a process-wide lane, while smaller files keep the
 * ingest pool's full concurrency.
 */

function tracker() {
  const state = { active: 0, maxActive: 0 };
  const run = async () => {
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    // Hold the "extraction" open across a tick so overlap is observable.
    await new Promise((r) => setTimeout(r, 5));
    state.active -= 1;
  };
  return { state, run };
}

describe('heavy-extraction lane', () => {
  it('serializes extractions at/above the heavy threshold', async () => {
    const { state, run } = tracker();
    await Promise.all(
      Array.from({ length: 5 }, () => withHeavyExtractionGate(HEAVY_EXTRACT_BYTES, run)),
    );
    expect(state.maxActive).toBe(1);
  });

  it('small files run concurrently, unaffected by the gate', async () => {
    const { state, run } = tracker();
    await Promise.all(Array.from({ length: 5 }, () => withHeavyExtractionGate(1024, run)));
    expect(state.maxActive).toBeGreaterThan(1);
  });

  it('small files are not blocked while a heavy extraction holds the lane', async () => {
    let releaseHeavy!: () => void;
    const heavyDone = withHeavyExtractionGate(
      HEAVY_EXTRACT_BYTES,
      () => new Promise<void>((r) => (releaseHeavy = r)),
    );
    // The heavy extraction is parked holding the lane; a small file must pass.
    let smallRan = false;
    await withHeavyExtractionGate(1024, async () => {
      smallRan = true;
    });
    expect(smallRan).toBe(true);
    releaseHeavy();
    await heavyDone;
  });

  it('a rejected heavy extraction releases the lane for the next waiter', async () => {
    const failing = withHeavyExtractionGate(HEAVY_EXTRACT_BYTES, async () => {
      throw new Error('extraction blew up');
    });
    await expect(failing).rejects.toThrow('extraction blew up');
    // The lane must not be poisoned: the next heavy extraction still runs.
    const result = await withHeavyExtractionGate(HEAVY_EXTRACT_BYTES, async () => 'ok');
    expect(result).toBe('ok');
  });
});
