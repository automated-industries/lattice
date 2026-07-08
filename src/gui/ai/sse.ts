import type { FeedEvent } from '../feed.js';

/**
 * Server-Sent Events protocol shared by the assistant chat stream and the
 * activity feed. The server writes `data: <json>\n\n` frames; the browser
 * reads them with a `fetch` ReadableStream reader. Both ends agree on the
 * event shapes defined here so neither side has to guess.
 */

/** Events emitted while streaming one assistant turn (with tool calls). */
export type ChatStreamEvent =
  | { type: 'assistant_message_start'; id: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_use'; id: string; name: string }
  | { type: 'tool_result'; toolUseId: string; isError: boolean }
  // A tool asked the GUI to open a row it just created (e.g. create_artifact) in
  // the main viewer. The client navigates to it once the turn finishes streaming.
  | { type: 'open'; table: string; id: string }
  // The model called ask_user: show this multiple-choice question inline in the
  // chat and end the turn — the user's pick (or free-form reply) arrives as the
  // next chat message. Never persisted to the question store; in-turn only.
  | { type: 'question'; question: string; options: string[]; allowOther: boolean }
  // Ends one round. `hadTools` is true when this round called tools — its streamed
  // text was pre-tool preamble ("Let me search…"), NOT the answer, so the client
  // reaps that round's bubble and the route drops it from the persisted message.
  // (Text now streams LIVE as it arrives, before tool use is known, so this flag is
  // how a preamble round is distinguished from the final answer after the fact.)
  | { type: 'assistant_message_end'; hadTools?: boolean }
  | { type: 'done' }
  // Non-fatal notice (e.g. the tool-step cap was reached with work outstanding).
  | { type: 'warn'; message: string }
  // Claude usage limit reached — the standard "you've hit your Claude limit"
  // notice; resetAt (ISO) when known. Distinct from a plain error.
  | { type: 'limit'; message: string; resetAt?: string }
  | { type: 'error'; message: string };

/** A feed event delivered over the same SSE channel as chat events. */
export interface FeedStreamEvent {
  type: 'feed';
  event: FeedEvent;
}

/** Anything that can travel down the GUI SSE stream. */
export type StreamEvent = ChatStreamEvent | FeedStreamEvent;

/** Serialize one event as an SSE frame (`data: <json>\n\n`). */
export function formatSseFrame(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export interface ParseResult {
  /** Fully-parsed events from complete frames in this chunk. */
  events: StreamEvent[];
  /** Leftover bytes that did not yet form a complete frame; feed back next call. */
  rest: string;
}

/**
 * Incrementally parse SSE frames out of a (possibly partial) text buffer.
 *
 * Splits on the `\n\n` frame boundary, extracts the `data:` line from each
 * complete frame, and `JSON.parse`s it. Malformed frames are dropped rather
 * than aborting the stream. Any trailing partial frame is returned in `rest`
 * so the caller can prepend it to the next chunk.
 */
export function parseSseFrames(buffer: string): ParseResult {
  const events: StreamEvent[] = [];
  let rest = buffer;
  let sep: number;
  while ((sep = rest.indexOf('\n\n')) >= 0) {
    const frame = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) continue;
    const json = dataLine.slice('data:'.length).trim();
    if (!json) continue;
    try {
      events.push(JSON.parse(json) as StreamEvent);
    } catch {
      // Drop malformed frame; keep the stream alive.
    }
  }
  return { events, rest };
}
