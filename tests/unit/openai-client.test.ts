import { describe, it, expect, vi } from 'vitest';
import {
  createOpenAiCompatibleClient,
  toOpenAiMessages,
  toOpenAiTools,
  mapFinishReason,
  accumulateStream,
} from '../../src/gui/ai/openai-client.js';
import type { LlmMessage } from '../../src/gui/ai/chat.js';

type LlmTool = { name: string; description?: string; input_schema: unknown };

/**
 * The OpenAI-compatible adapter is the seam that lets a user connect any
 * OpenAI-compatible endpoint (OpenAI / Azure / OpenRouter / a local server / their own
 * gateway) as the assistant backend, without adding a second code path anywhere else:
 * the whole app speaks Anthropic-shaped TurnParams/TurnResult and this translates.
 */

describe('toOpenAiMessages', () => {
  it('prepends the system prompt and passes through plain string turns', () => {
    const msgs: LlmMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(toOpenAiMessages('be nice', msgs)).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('omits the system message when empty', () => {
    expect(toOpenAiMessages('  ', [{ role: 'user', content: 'x' }])).toEqual([
      { role: 'user', content: 'x' },
    ]);
  });

  it('translates an assistant tool_use turn into tool_calls', () => {
    const msgs: LlmMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking that up.' },
          { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'acme' } },
        ],
      },
    ];
    expect(toOpenAiMessages('', msgs)).toEqual([
      {
        role: 'assistant',
        content: 'Looking that up.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"acme"}' },
          },
        ],
      },
    ]);
  });

  it('translates user tool_result blocks into `tool` messages (text becomes a trailing user msg)', () => {
    const msgs: LlmMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"rows":2}' },
          { type: 'text', text: 'thanks' },
        ],
      },
    ];
    expect(toOpenAiMessages('', msgs)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: '{"rows":2}' },
      { role: 'user', content: 'thanks' },
    ]);
  });
});

describe('toOpenAiTools', () => {
  it('wraps each tool as an OpenAI function tool with its json schema', () => {
    const tools: LlmTool[] = [
      { name: 'search', description: 'find rows', input_schema: { type: 'object' } },
    ];
    expect(toOpenAiTools(tools)).toEqual([
      {
        type: 'function',
        function: { name: 'search', description: 'find rows', parameters: { type: 'object' } },
      },
    ]);
  });
});

describe('mapFinishReason', () => {
  it('maps OpenAI finish reasons to the app’s Anthropic-shaped stop reasons', () => {
    expect(mapFinishReason('tool_calls', false)).toBe('tool_use');
    expect(mapFinishReason('stop', false)).toBe('end_turn');
    expect(mapFinishReason('length', false)).toBe('max_tokens');
    expect(mapFinishReason('content_filter', false)).toBe('refusal');
    // Missing finish_reason: continue the loop iff tool calls were produced.
    expect(mapFinishReason(null, true)).toBe('tool_use');
    expect(mapFinishReason(undefined, false)).toBe('end_turn');
    // 'length' WITH tool calls → still execute them (a truncated final call must not
    // strand the valid siblings).
    expect(mapFinishReason('length', true)).toBe('tool_use');
  });
});

describe('accumulateStream', () => {
  it('concatenates content deltas (streaming each) and reassembles fragmented tool calls', () => {
    const seen: string[] = [];
    const result = accumulateStream(
      [
        { content: 'Hel' },
        { content: 'lo' },
        { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'add', arguments: '{"a"' } }] },
        { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] },
      ],
      'tool_calls',
      (d) => seen.push(d),
    );
    expect(seen).toEqual(['Hel', 'lo']);
    expect(result.text).toBe('Hello');
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolUses).toEqual([{ id: 'call_9', name: 'add', input: { a: 1 } }]);
  });

  it('drops a malformed tool call but keeps valid sibling calls + streamed text', () => {
    // The LAST of several parallel tool calls is truncated by the token cap
    // (finish_reason 'length', arguments cut mid-JSON). The valid call + the streamed
    // text must survive — losing the whole batch is the bug this guards against.
    const seen: string[] = [];
    const result = accumulateStream(
      [
        { content: 'Working…' },
        { tool_calls: [{ index: 0, id: 'c1', function: { name: 'good', arguments: '{"a":1}' } }] },
        { tool_calls: [{ index: 1, id: 'c2', function: { name: 'bad', arguments: '{trunc' } }] },
      ],
      'length',
      (d) => seen.push(d),
    );
    expect(result.toolUses).toEqual([{ id: 'c1', name: 'good', input: { a: 1 } }]);
    expect(result.text).toBe('Working…');
    expect(result.stopReason).toBe('tool_use'); // execute the valid call, don't stop
  });
});

/** Build a streaming Response from SSE lines, for the injected fetch. */
function sseResponse(lines: string[], status = 200): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

describe('createOpenAiCompatibleClient.runTurn', () => {
  it('POSTs the configured model + translated body and returns a parsed TurnResult', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: 'Answer.' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        ]),
      );
    }) as unknown as typeof fetch;

    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://gw.example/v1/',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      fetchImpl,
    });
    const seen: string[] = [];
    const result = await client.runTurn({
      model: 'claude-haiku-4-5', // an Anthropic id the caller passed — MUST be ignored
      system: 'sys',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 't', description: 'a tool', input_schema: { type: 'object' } }],
      onText: (d) => seen.push(d),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://gw.example/v1/chat/completions'); // trailing slash normalized
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o'); // configured model wins over the caller's Anthropic id
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
    ]);
    expect(Array.isArray(body.tools)).toBe(true);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');

    expect(seen).toEqual(['Answer.']);
    expect(result).toEqual({ stopReason: 'end_turn', text: 'Answer.', toolUses: [] });
  });

  it('surfaces a non-2xx response as a thrown error (never a silent empty turn)', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('nope', { status: 401 })),
    ) as unknown as typeof fetch;
    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://gw.example/v1',
      apiKey: 'bad',
      model: 'gpt-4o',
      fetchImpl,
    });
    await expect(
      client.runTurn({ model: 'm', system: '', messages: [], tools: [], onText: () => undefined }),
    ).rejects.toThrow(/failed \(401\)/);
  });

  it('adapts to a reasoning model: retries with max_completion_tokens on the max_tokens 400', async () => {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call++;
      if (call === 1) {
        return Promise.resolve(
          new Response(
            "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            { status: 400 },
          ),
        );
      }
      return Promise.resolve(
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
        ]),
      );
    }) as unknown as typeof fetch;
    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      model: 'o3-mini',
      fetchImpl,
    });
    const r = await client.runTurn({
      model: 'm',
      system: '',
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
      onText: () => undefined,
    });
    expect(call).toBe(2); // one 400, one success
    expect(bodies[0]).toHaveProperty('max_tokens');
    expect(bodies[1]).not.toHaveProperty('max_tokens');
    expect(bodies[1]).toHaveProperty('max_completion_tokens');
    expect(r.text).toBe('ok');
  });
});
