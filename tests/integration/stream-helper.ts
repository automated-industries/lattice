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
