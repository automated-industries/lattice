import WebSocket from 'ws';

/**
 * Test helper for the multiplexed GUI event stream (`/api/stream` WebSocket,
 * which replaced the three `/api/{realtime,feed,render}` SSE endpoints). Opens a
 * WebSocket, then resolves with the `data` of the FIRST `{ type, data }` message
 * whose `type` matches and whose `data` satisfies `match`. Rejects after
 * `timeoutMs`.
 *
 * Server-pushed events (feed/realtime-change) have no backfill, so a caller that
 * wants to observe an event triggered by its own mutation must `await openStream`
 * (or this helper, after a short attach delay) BEFORE triggering the mutation.
 */
export async function waitForStreamMessage(
  url: string,
  type: string,
  match: (data: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  const ws = new WebSocket(toStreamUrl(url));
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no "${type}" message within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    ws.on('message', (buf: WebSocket.RawData) => {
      let msg: { type?: string; data?: Record<string, unknown> } | null = null;
      try {
        msg = JSON.parse(buf.toString()) as { type?: string; data?: Record<string, unknown> };
      } catch {
        return; // ignore malformed
      }
      if (msg?.type === type && match(msg.data ?? {})) {
        clearTimeout(timer);
        ws.close();
        resolve(msg.data ?? {});
      }
    });
    ws.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Drive one async chat turn end-to-end over the new transport. POST /api/chat no longer
 * streams its response — it ACKs `202 { threadId, messageId }` and the turn runs as a
 * background job whose events arrive over the `/api/stream` WebSocket as
 * `chat-progress` frames `{ threadId, messageId, event }`.
 *
 * This opens the socket FIRST (so no early frame is missed), attaches the message listener
 * BEFORE posting, then POSTs the chat, filters frames to the acked `messageId`, and resolves
 * with the ordered {@link ChatStreamEvent}s once the turn's terminal `done` frame arrives.
 * The final `events` array is exactly what the old held-open SSE response used to yield, so
 * a caller can assert on `text_delta` / `tool_use` / `done` as before.
 */
export async function runChatTurnOverStream(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 45000,
): Promise<{ threadId: string; messageId: string; events: Record<string, unknown>[] }> {
  const ws = await openStream(url);
  // Buffer every chat-progress frame (regardless of messageId) from the instant the socket
  // is live; once the ack pins the messageId we filter + decide completion. A very fast turn
  // can deliver `done` before the POST promise resolves, so buffering avoids the race.
  const raw: { messageId?: string; event?: Record<string, unknown> }[] = [];
  let ackId: string | null = null;
  let threadId = '';
  let settled = false;
  let resolveFn!: (v: {
    threadId: string;
    messageId: string;
    events: Record<string, unknown>[];
  }) => void;
  let rejectFn!: (e: Error) => void;
  const result = new Promise<{
    threadId: string;
    messageId: string;
    events: Record<string, unknown>[];
  }>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const finish = (): void => {
    if (settled || ackId == null) return;
    const events = raw
      .filter((m) => m.messageId === ackId)
      .map((m) => m.event)
      .filter((e): e is Record<string, unknown> => Boolean(e));
    if (events.some((e) => e.type === 'done')) {
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolveFn({ threadId, messageId: ackId, events });
    }
  };
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    ws.close();
    rejectFn(new Error(`chat turn did not finish within ${String(timeoutMs)}ms`));
  }, timeoutMs);
  ws.on('message', (buf: WebSocket.RawData) => {
    let msg: { type?: string; data?: { messageId?: string; event?: Record<string, unknown> } };
    try {
      msg = JSON.parse(buf.toString()) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'chat-progress' && msg.data) {
      raw.push(msg.data);
      finish();
    }
  });
  ws.on('error', (e: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectFn(e);
  });
  // Listener is attached — now trigger the turn.
  const r = await fetch(url + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status !== 202) {
    settled = true;
    clearTimeout(timer);
    ws.close();
    throw new Error(`chat POST returned ${String(r.status)} (expected 202): ${await r.text()}`);
  }
  const ack = (await r.json()) as { threadId?: string; messageId?: string };
  ackId = ack.messageId ?? null;
  threadId = ack.threadId ?? '';
  if (ackId == null) {
    settled = true;
    clearTimeout(timer);
    ws.close();
    throw new Error('chat ack missing messageId');
  }
  finish(); // a fast turn may have already delivered `done` before this ack resolved
  return result;
}

/** Open the event-stream WebSocket and resolve once it is OPEN (subscriptions live). */
export function openStream(url: string): Promise<WebSocket> {
  const ws = new WebSocket(toStreamUrl(url));
  return new Promise<WebSocket>((resolve, reject) => {
    ws.on('open', () => {
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

function toStreamUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws') + '/api/stream';
}
