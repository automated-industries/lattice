/**
 * Pure message protocol for the on-device speech-to-text Web Worker.
 *
 * The host page (non-module ES5 `appJs`) and the module worker exchange typed
 * `postMessage` envelopes. The framing + parsing logic is extracted here as pure
 * functions so it can be unit-tested in Node — neither the host glue nor the
 * worker needs a browser to verify id-correlation and error handling.
 *
 * Wire direction:
 *   host → worker:  InitRequest | TranscribeRequest
 *   worker → host:  ReadyMessage | ProgressMessage | ResultMessage | ErrorMessage
 */

/** The model is referenced by its public id only (no internal hosting detail). */
export type WorkerDevice = 'webgpu' | 'wasm';

export interface InitRequest {
  type: 'init';
  /** Public model id, e.g. an "automatic-speech-recognition" Whisper variant. */
  model: string;
  /** Preferred backend; the worker falls back to wasm when webgpu is absent. */
  device: WorkerDevice;
}

export interface TranscribeRequest {
  type: 'transcribe';
  /** Caller-assigned correlation id, echoed on the matching result/error. */
  id: string;
  /** Mono 16 kHz PCM. Transferred (not copied) via the `ArrayBuffer`. */
  pcm: Float32Array;
}

export type HostToWorker = InitRequest | TranscribeRequest;

export interface ReadyMessage {
  type: 'ready';
}

export interface ProgressMessage {
  type: 'progress';
  /** File being downloaded (model weights / tokenizer), for a status line. */
  file: string;
  /** 0–100, monotonic per file. */
  progress: number;
}

export interface ResultMessage {
  type: 'result';
  /** Correlates with the originating {@link TranscribeRequest}. */
  id: string;
  text: string;
}

export interface ErrorMessage {
  type: 'error';
  /** Present when the failure belongs to a specific transcribe request. */
  id?: string;
  message: string;
}

export type WorkerToHost = ReadyMessage | ProgressMessage | ResultMessage | ErrorMessage;

/**
 * Build the `{type:'init'}` envelope. `webgpu` is requested when available; the
 * worker downgrades to `wasm` itself if the runtime lacks it, so the caller can
 * pass the optimistic value.
 */
export function makeInitRequest(model: string, device: WorkerDevice): InitRequest {
  return { type: 'init', model, device };
}

/**
 * Build a `{type:'transcribe'}` envelope with a fresh correlation id. The PCM is
 * carried by reference; the caller transfers `pcm.buffer` so the bytes aren't
 * copied across the worker boundary.
 */
export function makeTranscribeRequest(id: string, pcm: Float32Array): TranscribeRequest {
  return { type: 'transcribe', id, pcm };
}

/**
 * Parse an unknown `MessageEvent.data` from the worker into a typed
 * {@link WorkerToHost}, or return null when it isn't a recognized envelope. Pure
 * + defensive: a malformed message never throws (so a stray post can't crash the
 * host), it's simply ignored by the caller.
 */
export function parseWorkerMessage(data: unknown): WorkerToHost | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'progress':
      if (typeof m.file === 'string' && typeof m.progress === 'number') {
        return { type: 'progress', file: m.file, progress: m.progress };
      }
      return null;
    case 'result':
      if (typeof m.id === 'string' && typeof m.text === 'string') {
        return { type: 'result', id: m.id, text: m.text };
      }
      return null;
    case 'error':
      if (typeof m.message === 'string') {
        return typeof m.id === 'string'
          ? { type: 'error', id: m.id, message: m.message }
          : { type: 'error', message: m.message };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Parse an unknown `MessageEvent.data` from the host into a typed
 * {@link HostToWorker}, or null when unrecognized. The worker uses this to reject
 * malformed control messages without throwing.
 */
export function parseHostMessage(data: unknown): HostToWorker | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type === 'init') {
    if (typeof m.model === 'string' && (m.device === 'webgpu' || m.device === 'wasm')) {
      return { type: 'init', model: m.model, device: m.device };
    }
    return null;
  }
  if (m.type === 'transcribe') {
    if (typeof m.id === 'string' && m.pcm instanceof Float32Array) {
      return { type: 'transcribe', id: m.id, pcm: m.pcm };
    }
    return null;
  }
  return null;
}

/**
 * Whether `text` is a usable transcript. The model can return an empty or
 * whitespace-only string for silence/noise — the caller treats that as a loud
 * "didn't catch anything", never inserting blank text into the composer.
 */
export function isUsableTranscript(text: string): boolean {
  return text.trim().length > 0;
}
