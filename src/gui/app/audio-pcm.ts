/**
 * Pure audio-PCM math for on-device speech-to-text.
 *
 * The browser captures a compressed audio blob (webm/opus, mp4/aac, …) which the
 * speech model can't read directly — it wants mono 16 kHz `Float32Array` PCM.
 * The decode step itself (`AudioContext.decodeAudioData`) is a browser API and
 * can't run under Node, but the math that turns a decoded multi-channel buffer
 * into the model's input IS pure: downmix to mono, then resample to 16 kHz. Both
 * are extracted here so they can be unit-tested against synthetic buffers without
 * a browser or a real audio file.
 *
 * No DOM / Web Audio types are referenced — the functions take plain
 * `Float32Array` channel data plus the source sample rate, so they compile and
 * run identically in Node and the browser.
 */

/** The sample rate the speech model expects. Whisper-family models are 16 kHz. */
export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Average N channel buffers into a single mono `Float32Array`. All channels are
 * assumed the same length (true for a decoded `AudioBuffer`); the shortest
 * length is used defensively so a ragged input can never read past an end.
 *
 * One channel is returned as-is (no copy needed — already mono). Zero channels
 * throws: an empty decode is a real failure, not silently an empty transcript.
 */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) {
    throw new Error('downmixToMono: no audio channels to mix');
  }
  const first = channels[0];
  if (first === undefined) {
    throw new Error('downmixToMono: no audio channels to mix');
  }
  if (channels.length === 1) return first;
  let length = first.length;
  for (const ch of channels) length = Math.min(length, ch.length);
  const out = new Float32Array(length);
  const channelCount = channels.length;
  // Accumulate each channel into `out`, then divide — avoids indexed reads that
  // the strict checker can't prove in-bounds, and is cache-friendlier per channel.
  for (const ch of channels) {
    for (let i = 0; i < length; i++) {
      out[i] = (out[i] ?? 0) + (ch[i] ?? 0);
    }
  }
  for (let i = 0; i < length; i++) {
    out[i] = (out[i] ?? 0) / channelCount;
  }
  return out;
}

/**
 * The output sample count for resampling `inputLength` samples from
 * `sourceRate` to {@link TARGET_SAMPLE_RATE}. Matches an `OfflineAudioContext`
 * render length: `ceil(durationSeconds * targetRate)`. Exposed so a caller (and
 * the tests) can size the offline render buffer identically to this resampler.
 */
export function resampledLength(inputLength: number, sourceRate: number): number {
  if (sourceRate <= 0) throw new Error('resampleTo16k: source sample rate must be positive');
  if (inputLength === 0) return 0;
  return Math.ceil((inputLength / sourceRate) * TARGET_SAMPLE_RATE);
}

/**
 * Resample a mono `Float32Array` to {@link TARGET_SAMPLE_RATE} via linear
 * interpolation. A pure CPU fallback for environments without an
 * `OfflineAudioContext` (Node tests) and a deterministic reference for the
 * browser's offline-render path. Already-16 kHz input is returned unchanged.
 *
 * Linear interpolation is intentionally simple: speech recognition is robust to
 * the mild aliasing it introduces, and the model's own front-end is the quality
 * bottleneck — a higher-order resampler would add code for no measurable WER win.
 */
export function resampleTo16k(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate <= 0) throw new Error('resampleTo16k: source sample rate must be positive');
  if (sourceRate === TARGET_SAMPLE_RATE) return input;
  const outLength = resampledLength(input.length, sourceRate);
  const out = new Float32Array(outLength);
  if (outLength === 0 || input.length === 0) return out;
  const ratio = input.length / outLength;
  const lastIndex = input.length - 1;
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const lower = Math.floor(srcPos);
    const upper = Math.min(lower + 1, lastIndex);
    const frac = srcPos - lower;
    const lo = input[lower] ?? 0;
    const hi = input[upper] ?? 0;
    out[i] = lo * (1 - frac) + hi * frac;
  }
  return out;
}

/**
 * Full pure pipeline: multi-channel decoded PCM at `sourceRate` → mono 16 kHz
 * `Float32Array`. Composes {@link downmixToMono} + {@link resampleTo16k}. The
 * browser path may instead use an `OfflineAudioContext` for the resample step
 * (so playback-engine quality applies); this function is the Node-testable
 * reference and the no-OfflineAudioContext fallback.
 */
export function toModelPcm(channels: Float32Array[], sourceRate: number): Float32Array {
  return resampleTo16k(downmixToMono(channels), sourceRate);
}
