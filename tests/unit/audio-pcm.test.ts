import { describe, it, expect } from 'vitest';
import {
  TARGET_SAMPLE_RATE,
  downmixToMono,
  resampledLength,
  resampleTo16k,
  toModelPcm,
} from '../../src/gui/app/audio-pcm.js';

describe('audio-pcm', () => {
  describe('downmixToMono', () => {
    it('returns a single channel unchanged (no copy needed)', () => {
      const ch = new Float32Array([0.1, -0.2, 0.3]);
      expect(downmixToMono([ch])).toBe(ch);
    });

    it('averages multiple channels sample-by-sample', () => {
      const left = new Float32Array([1, 0, -1, 0.5]);
      const right = new Float32Array([0, 1, -1, -0.5]);
      const mono = downmixToMono([left, right]);
      expect(Array.from(mono)).toEqual([0.5, 0.5, -1, 0]);
    });

    it('mixes against the shortest channel length (ragged-safe)', () => {
      const a = new Float32Array([1, 1, 1]);
      const b = new Float32Array([1, 1]);
      const mono = downmixToMono([a, b]);
      expect(mono.length).toBe(2);
      expect(Array.from(mono)).toEqual([1, 1]);
    });

    it('throws on zero channels (an empty decode is a real failure)', () => {
      expect(() => downmixToMono([])).toThrow(/no audio channels/i);
    });
  });

  describe('resampledLength', () => {
    it('matches an OfflineAudioContext render length: ceil(dur * 16000)', () => {
      // 48000 samples at 48 kHz = 1.0 s → exactly 16000 at 16 kHz.
      expect(resampledLength(48_000, 48_000)).toBe(16_000);
      // 44100 samples at 44.1 kHz = 1.0 s → 16000.
      expect(resampledLength(44_100, 44_100)).toBe(16_000);
      // A fractional duration rounds UP (ceil), matching OfflineAudioContext.
      expect(resampledLength(48_001, 48_000)).toBe(Math.ceil((48_001 / 48_000) * 16_000));
    });

    it('is 0 for empty input and throws for a non-positive rate', () => {
      expect(resampledLength(0, 48_000)).toBe(0);
      expect(() => resampledLength(100, 0)).toThrow(/positive/i);
    });
  });

  describe('resampleTo16k', () => {
    it('returns the input unchanged when already 16 kHz', () => {
      const pcm = new Float32Array([0.1, 0.2, 0.3]);
      expect(resampleTo16k(pcm, TARGET_SAMPLE_RATE)).toBe(pcm);
    });

    it('downsamples to the expected length and stays in range', () => {
      // A 1-second 48 kHz ramp → 16000 samples, values bounded by the source.
      const src = new Float32Array(48_000);
      for (let i = 0; i < src.length; i++) src[i] = i / src.length; // 0 → ~1 ramp
      const out = resampleTo16k(src, 48_000);
      expect(out.length).toBe(16_000);
      expect(out[0]).toBeCloseTo(0, 5);
      // Monotonic ramp stays monotonic-ish under linear interpolation.
      expect(out[15_999]!).toBeGreaterThan(out[0]!);
      for (const v of out) expect(v).toBeGreaterThanOrEqual(0);
    });

    it('upsamples a low-rate buffer to 16 kHz', () => {
      const src = new Float32Array([0, 1]); // 2 samples at 8 kHz = 0.25 ms
      const out = resampleTo16k(src, 8_000);
      expect(out.length).toBe(resampledLength(2, 8_000));
      expect(out[0]).toBeCloseTo(0, 5);
    });

    it('throws for a non-positive source rate', () => {
      expect(() => resampleTo16k(new Float32Array([1]), 0)).toThrow(/positive/i);
    });
  });

  describe('toModelPcm', () => {
    it('downmixes then resamples to mono 16 kHz', () => {
      const left = new Float32Array(48_000).fill(0.5);
      const right = new Float32Array(48_000).fill(-0.5);
      const out = toModelPcm([left, right], 48_000);
      expect(out.length).toBe(16_000);
      // The two channels cancel to ~0 after averaging.
      for (const v of out) expect(Math.abs(v)).toBeLessThan(1e-6);
    });
  });
});
