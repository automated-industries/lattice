/**
 * On-device speech-to-text Web Worker (module worker, ESM).
 *
 * Runs an in-browser WASM/WebGPU Whisper pipeline so dictation works with NO API
 * key and NO server round-trip — audio never leaves the machine. This file is
 * bundled SEPARATELY from the main server build (see `scripts/build-gui-assets.mjs`)
 * into `dist/gui-assets/transcriber.worker.mjs`, with the speech library inlined,
 * so the byte-locked non-module host script (`appJs`) stays tiny and ES5: the host
 * only constructs `new Worker(url, { type: 'module' })` and exchanges postMessage.
 *
 * The model weights are NOT bundled — they download once on first use from the
 * public model host and cache in the browser, then run fully offline thereafter.
 *
 * `@huggingface/transformers` is a build-time devDependency; the import is
 * resolved + inlined by the asset bundler. When that bundle is absent (fail-soft
 * build), this file is simply never served and the GUI hides the mic / falls back.
 */

// Resolved + inlined by the gui-assets esbuild step at build time (a build-time
// devDependency). Not part of the main library/CLI bundle.
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

import {
  parseHostMessage,
  isUsableTranscript,
  type WorkerToHost,
  type WorkerDevice,
} from './protocol.js';

// The ONNX-Runtime WASM binaries are vendored next to this worker so nothing is
// fetched from a CDN — the "fully offline / no config" promise. They're served by
// the GUI at `/gui-assets/ort/` (same-origin localhost). Set before any pipeline
// build so the runtime looks there for its `.wasm`.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = '/gui-assets/ort/';
}
// Models are fetched from the public remote host on first use, then cached by the
// browser. Local-only model serving is an opt-in air-gap mode, not the default.
env.allowRemoteModels = true;

// Worker globals are not in the default lib for a Node-targeted tsconfig; declare
// the minimal surface we use. The asset bundle targets the browser worker scope.
declare const self: {
  postMessage: (message: WorkerToHost, transfer?: Transferable[]) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

interface ProgressEvent {
  status?: string;
  file?: string;
  progress?: number;
}

let pipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

/** Build (once) + cache the ASR pipeline for the session. */
function getPipeline(
  model: string,
  device: WorkerDevice,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = pipeline('automatic-speech-recognition', model, {
    device,
    // dtype q8 keeps the tiny model small (~40-80 MB) and CPU-friendly.
    dtype: 'q8',
    progress_callback: (p: ProgressEvent) => {
      if (p.status === 'progress' && typeof p.file === 'string') {
        self.postMessage({
          type: 'progress',
          file: p.file,
          progress: typeof p.progress === 'number' ? p.progress : 0,
        });
      }
    },
  });
  return pipelinePromise;
}

// Serialize transcribe calls: the pipeline is single-threaded and a second
// concurrent call would contend for the same WASM heap. Each request chains off
// the previous so they run strictly in order.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: { data: unknown }): void => {
  const msg = parseHostMessage(event.data);
  if (!msg) return; // ignore malformed control messages (never throw on a stray post)

  if (msg.type === 'init') {
    // Eagerly start building the pipeline so the first transcribe is faster, and
    // signal readiness / surface a load failure loudly.
    getPipeline(msg.model, msg.device)
      .then(() => {
        self.postMessage({ type: 'ready' });
      })
      .catch((e: unknown) => {
        self.postMessage({ type: 'error', message: describeError(e) });
      });
    return;
  }

  // transcribe
  const { id, pcm } = msg;
  queue = queue.then(async () => {
    try {
      // The pipeline must already be requested via init; if not, build with
      // defaults so a transcribe is never silently dropped.
      const asr = await (pipelinePromise ?? getPipeline('Xenova/whisper-tiny.en', 'wasm'));
      const output = (await asr(pcm)) as { text?: unknown };
      const text = typeof output.text === 'string' ? output.text : '';
      // Empty/whitespace is surfaced as an error so the host shows "didn't catch
      // anything" and never inserts blank text — fail loud, never silent.
      if (!isUsableTranscript(text)) {
        self.postMessage({ type: 'error', id, message: 'empty transcript' });
        return;
      }
      self.postMessage({ type: 'result', id, text });
    } catch (e: unknown) {
      self.postMessage({ type: 'error', id, message: describeError(e) });
    }
  });
};

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'unknown worker error';
}
