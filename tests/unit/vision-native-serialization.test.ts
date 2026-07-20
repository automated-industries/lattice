import { describe, it, expect, vi } from 'vitest';
import type { ClaudeAuth } from '../../src/ai/llm-client.js';

/**
 * Regression: bulk folder ingest ran several native `sharp`/libvips JPEG
 * pipelines at once inside the packaged desktop runtime and crashed the process
 * (native SIGTRAP). `normalizeImage` must serialize the native step so at most
 * ONE libvips pipeline is ever in flight, regardless of how many images ingest
 * concurrently. This test fakes `sharp` to count in-flight `.toBuffer()` calls.
 */
const state = vi.hoisted(() => ({ active: 0, maxActive: 0 }));

vi.mock('sharp', () => {
  function factory() {
    return {
      rotate() {
        return this;
      },
      resize() {
        return this;
      },
      jpeg() {
        return this;
      },
      async toBuffer() {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        // Hold the "native" work open across a tick so overlap is observable.
        await new Promise((r) => setTimeout(r, 5));
        state.active -= 1;
        // Small buffer (< maxBytes) → no quality-reduction re-render loop.
        return Buffer.from('normalized-jpeg');
      },
    };
  }
  (factory as unknown as { concurrency: (n: number) => number }).concurrency = () => 1;
  return { default: factory };
});

const { describeImage } = await import('../../src/ai/vision.js');

describe('vision: native image normalization is serialized', () => {
  it('never runs two libvips pipelines at once across concurrent describeImage calls', async () => {
    const auth = {} as unknown as ClaudeAuth; // unused: sender is injected
    const sender = async (): Promise<string> => 'a factual description';

    await Promise.all(
      ['/a.png', '/b.png', '/c.png', '/d.png', '/e.png'].map((p) =>
        describeImage(auth, p, { sender }),
      ),
    );

    expect(state.maxActive).toBe(1);
  });
});
