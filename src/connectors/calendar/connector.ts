/**
 * Google Calendar MCP connector — a parameterized-tool connector following the
 * Atlassian template.
 *
 * The introspective connector only calls NO-ARGUMENT tools, so a Google Calendar
 * server (whose event listing requires a `calendar_id`) yields no per-calendar
 * events. This connector models that parameterized tool explicitly: it first lists
 * the accessible calendars (`list_calendars`, no args), and the events model is a
 * PER-CALENDAR child whose `calendar_id` is supplied as the sync's `parentKey` — so
 * `list_events({ calendar_id })` runs once per calendar.
 *
 * ⚠️ SPIKE-VERIFY THE MAPPERS. The tool NAMES below are the documented Google
 * Calendar tools, and the field paths follow Google's documented Calendar API
 * result shapes, but they have NOT been confirmed against a live server (that needs
 * an interactive OAuth). Before shipping to real users, run the plan's Phase-0 spike
 * (connect → tools/list → a sample tools/call per tool) and correct any `pick()`
 * paths, the item-array wrapper keys in `items()`, and the `nextCursor()` page-token
 * field. The transport + parameterized-binding wiring is verified by the
 * fake-transport test.
 */

import {
  SimpleMcpConnector,
  type McpConnectorDeps,
  type McpModelBinding,
} from '../mcp/connector-base.js';
import { mcpModel, str, jsonCol, pick, arrayField } from '../mcp/connected-model.js';
import { letterIcon } from '../mcp/icon.js';
import type { ConnectedModelDef, ExternalRecord } from '../types.js';

const CONNECTOR = 'calendar';
const TOOLKIT = 'calendar';

// ⚠️ NEEDS-SPIKE: the Streamable-HTTP endpoint (NOT a legacy `/sse` URL). A
// `/v1/mcp` URL is inferred as `transport: 'http'` by McpServerSpec. Confirm the
// exact host + path against the live Google Calendar MCP server.
const CALENDAR_MCP_URL = 'https://mcp.google.com/calendar/v1/mcp';

// ⚠️ NEEDS-SPIKE: the OAuth scope the Google authorization server expects.
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/** Compose a calendar-unique natural key so two calendars' identical event ids don't
 *  collide within one connector. parentKey is the calendar_id. */
function calendarKey(parentKey: string | undefined, raw: unknown): string | undefined {
  const id = str(raw);
  if (id === undefined) return undefined;
  return parentKey ? `${parentKey}/${id}` : id;
}

// ── Models (tables) ──────────────────────────────────────────────────────────
// The calendar model has no parent; the events model is per-calendar (its
// calendar_id arrives as the sync parentKey), and `childColumn` is stamped with
// that calendar_id by the sync.

const calendars: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'calendar_calendars',
  model: 'calendar_calendars',
  naturalKey: 'calendar_id',
  columns: { summary: 'TEXT', timezone: 'TEXT', is_primary: 'TEXT' },
  def: {},
});

const events: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'calendar_events',
  model: 'calendar_events',
  naturalKey: 'event_id',
  columns: {
    calendar_id: 'TEXT',
    summary: 'TEXT',
    description: 'TEXT',
    location: 'TEXT',
    start_at: 'TEXT',
    end_at: 'TEXT',
    organizer: 'TEXT',
    attendees: 'TEXT',
    status: 'TEXT',
    updated: 'TEXT',
  },
  def: { fts: { fields: ['summary', 'description', 'location'] } },
  parent: { table: 'calendar_calendars', keyColumn: 'calendar_id', childColumn: 'calendar_id' },
});

// Model order matters: the calendar model syncs first so the events child can
// iterate its calendar_ids as its parentKey.
const MODELS: ConnectedModelDef[] = [calendars, events];

// ── Bindings (tool + mapper per model) ───────────────────────────────────────
// ⚠️ Mapper field paths + tool result wrapper keys are documented-but-unverified —
// spike-confirm before shipping (see the file header).

const BINDINGS: McpModelBinding[] = [
  {
    model: 'calendar_calendars',
    tool: 'list_calendars',
    buildArgs: () => ({}),
    items: (r) => arrayField(r, ['calendars', 'items', 'values']),
    map: (item): ExternalRecord | null => {
      const calendarId = str(pick(item, 'id'));
      if (calendarId === undefined) return null;
      return {
        id: calendarId,
        row: {
          summary: str(pick(item, 'summary')),
          timezone: str(pick(item, 'timeZone')),
          is_primary: str(pick(item, 'primary')),
        },
      };
    },
  },
  {
    model: 'calendar_events',
    tool: 'list_events',
    buildArgs: ({ parentKey, cursor }) => ({
      calendar_id: parentKey,
      ...(cursor ? { pageToken: cursor } : {}),
    }),
    items: (r) => arrayField(r, ['events', 'items', 'values']),
    map: (item, ctx): ExternalRecord | null => {
      const id = calendarKey(ctx.parentKey, pick(item, 'id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          calendar_id: ctx.parentKey,
          summary: str(pick(item, 'summary')),
          description: str(pick(item, 'description')),
          location: str(pick(item, 'location')),
          start_at: str(pick(item, 'start.dateTime')) ?? str(pick(item, 'start.date')),
          end_at: str(pick(item, 'end.dateTime')) ?? str(pick(item, 'end.date')),
          organizer: str(pick(item, 'organizer.email')),
          attendees: jsonCol(pick(item, 'attendees')),
          status: str(pick(item, 'status')),
          updated: str(pick(item, 'updated')),
        },
      };
    },
    nextCursor: (r) => str(pick(r, 'nextPageToken')) ?? null,
  },
];

/** The Google Calendar connector. One OAuth connect to the Google Calendar Remote
 *  MCP server populates the calendars + per-calendar events tables. */
export function calendarConnector(deps: McpConnectorDeps = {}): SimpleMcpConnector {
  return new SimpleMcpConnector(
    {
      connector: CONNECTOR,
      toolkit: TOOLKIT,
      presentation: { label: 'Google Calendar', icon: letterIcon('C', '#4285f4') },
      servers: [{ name: 'calendar', url: CALENDAR_MCP_URL, transport: 'http', oauth: true }],
      models: MODELS,
      bindings: BINDINGS,
      // Read-only calendar scope. Spike-verify the exact scope string the Google
      // authorization server expects.
      scope: CALENDAR_SCOPE,
    },
    deps,
  );
}
