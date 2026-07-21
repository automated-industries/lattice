import { describe, it, expect } from 'vitest';
import { calendarConnector } from '../../src/connectors/calendar/connector.js';
import type {
  McpTransport,
  McpToolCall,
  McpToolInfo,
  McpResourceInfo,
} from '../../src/connectors/mcp/transport.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * The Google Calendar connector is a HAND-AUTHORED, parameterized-tool connector:
 * its event listing requires a `calendar_id`, which the introspective connector
 * would skip. This proves the mechanism — the calendar_id flows in as the sync
 * parentKey, the parameterized `list_events` tool runs with it, and rows are mapped
 * calendar-uniquely. (Mapper field paths are documented-but-spike-unverified; this
 * test pins the WIRING, using a fake transport, not the live server's exact JSON.)
 */

const CALENDAR_ID = 'primary@example.com';

class FakeTransport implements McpTransport {
  calls: McpToolCall[] = [];
  constructor(private readonly results: Record<string, unknown>) {}
  listTools(): Promise<McpToolInfo[]> {
    return Promise.resolve(Object.keys(this.results).map((name) => ({ name })));
  }
  callTool(call: McpToolCall): Promise<unknown> {
    this.calls.push(call);
    return Promise.resolve(this.results[call.tool] ?? {});
  }
  listResources(): Promise<McpResourceInfo[]> {
    return Promise.resolve([]);
  }
  serverInfo(): { name?: string } | undefined {
    return { name: 'calendar' };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function collect(it: AsyncIterable<ExternalRecord>): Promise<ExternalRecord[]> {
  const out: ExternalRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe('Google Calendar connector', () => {
  const TK = 'calendar';
  function conn(results: Record<string, unknown>): {
    c: ReturnType<typeof calendarConnector>;
    t: FakeTransport;
  } {
    const t = new FakeTransport(results);
    return { c: calendarConnector({ transportFactory: () => Promise.resolve(t) }), t };
  }

  it('models calendars + per-calendar events, the events child parented on the calendar', () => {
    const { c } = conn({});
    expect(c.models(TK).map((m) => m.table)).toEqual(['calendar_calendars', 'calendar_events']);
    // The parameterized events child declares calendar_calendars as its parent (the calendar_id source).
    const evt = c.models(TK).find((x) => x.table === 'calendar_events')!;
    expect(evt.parent?.table).toBe('calendar_calendars');
    expect(evt.parent?.keyColumn).toBe('calendar_id');
  });

  it('serves the Calendar MCP over the /v1/mcp Streamable-HTTP endpoint (not /sse)', () => {
    const { c } = conn({});
    const server = c.mcpServers(TK)[0];
    expect(server.url).toMatch(/\/v1\/mcp$/);
    expect(server.url).not.toMatch(/\/sse$/);
  });

  it('lists calendars from the no-arg tool (the calendar_id source)', async () => {
    const { c } = conn({
      list_calendars: {
        calendars: [
          { id: CALENDAR_ID, summary: 'Work', timeZone: 'America/New_York', primary: true },
        ],
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u' };
    const calendars = await collect(c.listChanges(TK, 'calendar_calendars', ctx));
    expect(calendars.map((s) => s.id)).toEqual([CALENDAR_ID]);
    expect(calendars[0]?.row.summary).toBe('Work');
    expect(calendars[0]?.row.timezone).toBe('America/New_York');
  });

  it('runs the PARAMETERIZED list_events with the calendar_id parentKey and maps calendar-unique rows', async () => {
    const { c, t } = conn({
      list_events: {
        events: [
          {
            id: 'evt-1',
            summary: 'Standup',
            location: 'Room 4',
            start: { dateTime: '2026-07-21T09:00:00Z' },
            end: { dateTime: '2026-07-21T09:15:00Z' },
            organizer: { email: 'boss@example.com' },
            status: 'confirmed',
          },
        ],
      },
    });
    const ctx: ListChangesContext = { connectionId: 'x', userId: 'u', parentKey: CALENDAR_ID };
    const events = await collect(c.listChanges(TK, 'calendar_events', ctx));
    // The parameterized tool ran WITH the calendar_id — the whole point of the connector.
    expect(t.calls[0]?.tool).toBe('list_events');
    expect((t.calls[0]?.args as { calendar_id?: string }).calendar_id).toBe(CALENDAR_ID);
    // Row mapped; its natural key is calendar-namespaced so two calendars' evt-1 never collide.
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(`${CALENDAR_ID}/evt-1`);
    expect(events[0]?.row.calendar_id).toBe(CALENDAR_ID);
    expect(events[0]?.row.summary).toBe('Standup');
    expect(events[0]?.row.start_at).toBe('2026-07-21T09:00:00Z');
    expect(events[0]?.row.organizer).toBe('boss@example.com');
  });
});
