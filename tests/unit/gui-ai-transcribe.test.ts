import { describe, it, expect, vi, afterEach } from 'vitest';
import { transcribe } from '../../src/gui/ai/transcribe.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(impl: (url: string, init: RequestInit) => Response): RequestInit[] {
  const calls: RequestInit[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    return impl(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return calls;
}

const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });

describe('transcribe', () => {
  it('posts to OpenAI Whisper with a bearer token and returns the text', async () => {
    let calledUrl = '';
    const calls = mockFetch((url) => {
      calledUrl = url;
      return new Response(JSON.stringify({ text: 'hello world' }), { status: 200 });
    });
    const text = await transcribe({ provider: 'openai', apiKey: 'sk-openai', audio });
    expect(text).toBe('hello world');
    expect(calledUrl).toContain('api.openai.com');
    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-openai');
    expect(calls[0]?.body).toBeInstanceOf(FormData);
  });

  it('posts to ElevenLabs with the xi-api-key header', async () => {
    let calledUrl = '';
    const calls = mockFetch((url) => {
      calledUrl = url;
      return new Response(JSON.stringify({ text: 'scribe text' }), { status: 200 });
    });
    const text = await transcribe({ provider: 'elevenlabs', apiKey: 'el-key', audio });
    expect(text).toBe('scribe text');
    expect(calledUrl).toContain('elevenlabs.io');
    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe('el-key');
  });

  it('throws (loudly) on a non-OK response', async () => {
    mockFetch(() => new Response('bad key', { status: 401 }));
    await expect(transcribe({ provider: 'openai', apiKey: 'x', audio })).rejects.toThrow(/401/);
  });

  it('throws when the response has no text field', async () => {
    mockFetch(() => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await expect(transcribe({ provider: 'openai', apiKey: 'x', audio })).rejects.toThrow(/no text/i);
  });
});
