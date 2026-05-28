import { describe, it, expect } from 'vitest';
import { formatSseFrame, parseSseFrames, type StreamEvent } from '../../src/gui/ai/sse.js';

describe('SSE protocol', () => {
  it('formats an event as a data frame terminated by a blank line', () => {
    const frame = formatSseFrame({ type: 'text_delta', delta: 'hi' });
    expect(frame).toBe('data: {"type":"text_delta","delta":"hi"}\n\n');
  });

  it('round-trips a single event through format + parse', () => {
    const event: StreamEvent = { type: 'tool_use', id: 'tu_1', name: 'create_row' };
    const { events, rest } = parseSseFrames(formatSseFrame(event));
    expect(events).toEqual([event]);
    expect(rest).toBe('');
  });

  it('parses multiple frames from one buffer', () => {
    const buffer =
      formatSseFrame({ type: 'assistant_message_start', id: 'm1' }) +
      formatSseFrame({ type: 'text_delta', delta: 'a' }) +
      formatSseFrame({ type: 'done' });
    const { events } = parseSseFrames(buffer);
    expect(events.map((e) => e.type)).toEqual(['assistant_message_start', 'text_delta', 'done']);
  });

  it('returns a trailing partial frame as rest, then completes it on the next chunk', () => {
    const full = formatSseFrame({ type: 'text_delta', delta: 'hello' });
    const split = Math.floor(full.length / 2);
    const first = parseSseFrames(full.slice(0, split));
    expect(first.events).toEqual([]);
    expect(first.rest).toBe(full.slice(0, split));
    const second = parseSseFrames(first.rest + full.slice(split));
    expect(second.events).toEqual([{ type: 'text_delta', delta: 'hello' }]);
    expect(second.rest).toBe('');
  });

  it('drops a malformed frame without aborting the stream', () => {
    const buffer = 'data: {not json}\n\n' + formatSseFrame({ type: 'done' });
    const { events } = parseSseFrames(buffer);
    expect(events).toEqual([{ type: 'done' }]);
  });

  it('ignores frames without a data line', () => {
    const buffer = ': keep-alive comment\n\n' + formatSseFrame({ type: 'done' });
    const { events } = parseSseFrames(buffer);
    expect(events).toEqual([{ type: 'done' }]);
  });

  it('carries a feed event over the same channel', () => {
    const event: StreamEvent = {
      type: 'feed',
      event: { seq: 1, table: 'people', op: 'insert', rowId: '1', source: 'gui', ts: '2026-01-01T00:00:00.000Z' },
    };
    const { events } = parseSseFrames(formatSseFrame(event));
    expect(events[0]).toEqual(event);
  });
});
