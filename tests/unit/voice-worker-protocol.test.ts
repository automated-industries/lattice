import { describe, it, expect } from 'vitest';
import {
  makeInitRequest,
  makeTranscribeRequest,
  parseWorkerMessage,
  parseHostMessage,
  isUsableTranscript,
} from '../../src/gui/app/worker/protocol.js';

describe('voice worker protocol', () => {
  describe('makeInitRequest / makeTranscribeRequest', () => {
    it('frames an init envelope with the model + device hint', () => {
      expect(makeInitRequest('Xenova/whisper-tiny.en', 'webgpu')).toEqual({
        type: 'init',
        model: 'Xenova/whisper-tiny.en',
        device: 'webgpu',
      });
    });

    it('frames a transcribe envelope carrying a correlation id + PCM', () => {
      const pcm = new Float32Array([0.1, 0.2]);
      const req = makeTranscribeRequest('v1', pcm);
      expect(req.type).toBe('transcribe');
      expect(req.id).toBe('v1');
      expect(req.pcm).toBe(pcm); // carried by reference (transferred, not copied)
    });
  });

  describe('parseWorkerMessage', () => {
    it('parses each worker→host message type', () => {
      expect(parseWorkerMessage({ type: 'ready' })).toEqual({ type: 'ready' });
      expect(parseWorkerMessage({ type: 'progress', file: 'model.onnx', progress: 42 })).toEqual({
        type: 'progress',
        file: 'model.onnx',
        progress: 42,
      });
      expect(parseWorkerMessage({ type: 'result', id: 'v1', text: 'hello' })).toEqual({
        type: 'result',
        id: 'v1',
        text: 'hello',
      });
    });

    it('correlates a result by id and an error with or without an id', () => {
      const result = parseWorkerMessage({ type: 'result', id: 'v7', text: 'hi' });
      expect(result).toEqual({ type: 'result', id: 'v7', text: 'hi' });

      // Per-request error carries the id; a load error omits it.
      expect(parseWorkerMessage({ type: 'error', id: 'v7', message: 'decode failed' })).toEqual({
        type: 'error',
        id: 'v7',
        message: 'decode failed',
      });
      expect(parseWorkerMessage({ type: 'error', message: 'WASM load failed' })).toEqual({
        type: 'error',
        message: 'WASM load failed',
      });
      // An error envelope without an id must NOT invent one.
      const noId = parseWorkerMessage({ type: 'error', message: 'x' });
      expect(noId && 'id' in noId).toBe(false);
    });

    it('returns null for malformed / unknown envelopes (never throws on a stray post)', () => {
      expect(parseWorkerMessage(null)).toBeNull();
      expect(parseWorkerMessage(42)).toBeNull();
      expect(parseWorkerMessage({ type: 'nope' })).toBeNull();
      expect(parseWorkerMessage({ type: 'result', id: 'v1' })).toBeNull(); // missing text
      expect(parseWorkerMessage({ type: 'progress', file: 'x' })).toBeNull(); // missing progress
      expect(parseWorkerMessage({ type: 'error' })).toBeNull(); // missing message
    });
  });

  describe('parseHostMessage', () => {
    it('parses init + transcribe control messages', () => {
      expect(parseHostMessage({ type: 'init', model: 'm', device: 'wasm' })).toEqual({
        type: 'init',
        model: 'm',
        device: 'wasm',
      });
      const pcm = new Float32Array([1, 2, 3]);
      const t = parseHostMessage({ type: 'transcribe', id: 'v1', pcm });
      expect(t).toEqual({ type: 'transcribe', id: 'v1', pcm });
    });

    it('rejects malformed control messages', () => {
      expect(parseHostMessage({ type: 'init', model: 'm', device: 'cuda' })).toBeNull();
      expect(parseHostMessage({ type: 'transcribe', id: 'v1', pcm: [1, 2] })).toBeNull(); // not a Float32Array
      expect(parseHostMessage({ type: 'transcribe', pcm: new Float32Array() })).toBeNull(); // no id
      expect(parseHostMessage(undefined)).toBeNull();
    });
  });

  describe('isUsableTranscript', () => {
    it('is false for empty / whitespace, true for real text', () => {
      expect(isUsableTranscript('')).toBe(false);
      expect(isUsableTranscript('   \n\t ')).toBe(false);
      expect(isUsableTranscript('hello')).toBe(true);
      expect(isUsableTranscript('  trimmed  ')).toBe(true);
    });
  });
});
