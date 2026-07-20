import { statSync } from 'node:fs';
import { Semaphore } from '../../ai/fetch-policy.js';

/**
 * Heavy-extraction lane: document extraction serialized by declared input size.
 *
 * Extraction transients are input-side and can dwarf the file on disk — a zip
 * archive inflates fully into memory before parsing, a PDF parse graph holds
 * page objects and content streams, and a scanned-PDF fallback materializes a
 * base64 copy of the whole file inside the model-request body. The per-file
 * caps bound each of those individually, but the ingest pool runs several
 * files at once, and concurrency × peak-transient is what actually has to fit
 * the heap. Files at or above {@link HEAVY_EXTRACT_BYTES} therefore extract
 * one at a time through a process-wide lane; smaller files — the long tail of
 * ordinary documents — keep the pool's full concurrency.
 *
 * Lock ordering: the lane is acquired before (never inside) the native image
 * lock in `src/ai/vision.ts`, and nothing that holds that lock ever takes the
 * lane, so the two cannot deadlock. Release happens in `finally`, so a
 * throwing extraction never poisons the lane for the next waiter.
 */
export const HEAVY_EXTRACT_BYTES = 8 * 1024 * 1024;

let heavyLane: Semaphore | null = null;

/** Serialize work at/above {@link HEAVY_EXTRACT_BYTES}; smaller work runs unimpeded. */
export async function withHeavyExtractionGate<T>(
  sizeBytes: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (sizeBytes < HEAVY_EXTRACT_BYTES) return fn();
  heavyLane ??= new Semaphore(1);
  const release = await heavyLane.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Path convenience: sizes the file here. A missing/unreadable path runs
 * ungated — the read inside `fn` surfaces the real error to the caller.
 */
export function gateExtractionByPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // Unsizable input takes the small lane; fn's own read reports the failure.
  }
  return withHeavyExtractionGate(size, fn);
}
