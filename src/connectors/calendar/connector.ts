/**
 * Google Calendar MCP connector — pulls calendars and their events in as context
 * via a Calendar MCP server's READ tools (`list_calendars`, `list_events`). Only
 * read tools are called.
 *
 * Like Gmail/Drive, Google Calendar is OAuth-locked to claude.ai's own client, so
 * point this at a self-hosted / third-party Google-Workspace MCP server (HTTP
 * `url` or a local `stdio` command). Tool + field names target the common
 * Google-Workspace MCP shape; adjust the bindings if your server differs.
 */

import type { McpModelBinding } from '../mcp/connector-base.js';
import { SimpleMcpConnector, type McpConnectorDeps } from '../mcp/connector-base.js';
import { mcpModel, str, jsonCol, pick, arrayField } from '../mcp/connected-model.js';
import { letterIcon } from '../mcp/icon.js';
import type { ConnectedModelDef, ExternalRecord } from '../types.js';

const CONNECTOR = 'calendar';

const calendars = mcpModel({
  connector: CONNECTOR,
  toolkit: CONNECTOR,
  table: 'calendar_calendars',
  model: 'calendar',
  naturalKey: 'calendar_id',
  columns: {
    summary: 'TEXT',
    description: 'TEXT',
    time_zone: 'TEXT',
    primary: 'INTEGER',
    access_role: 'TEXT',
  },
  def: {
    description: 'Google calendars',
    render: 'default-list',
    fts: { fields: ['summary', 'description'] },
  },
});

const events = mcpModel({
  connector: CONNECTOR,
  toolkit: CONNECTOR,
  table: 'calendar_events',
  model: 'event',
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
  def: {
    description: 'Google calendar events',
    render: 'default-detail',
    fts: { fields: ['summary', 'description', 'location'] },
    relations: {
      calendar: {
        type: 'belongsTo',
        table: 'calendar_calendars',
        foreignKey: 'calendar_id',
        references: 'calendar_id',
      },
    },
  },
  graphEdges: [{ fkColumn: 'calendar_id', dstTable: 'calendar_calendars', type: 'in_calendar' }],
  parent: {
    table: 'calendar_calendars',
    keyColumn: 'calendar_id',
    childColumn: 'calendar_id',
    incrementalColumn: 'updated',
  },
});

/** Calendar connected models, parents before children. */
export const CALENDAR_MODELS: ConnectedModelDef[] = [calendars, events];

/** Google event start/end can be a date-time or an all-day date; take whichever is present. */
function eventTime(v: unknown): string | undefined {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return str(o.dateTime) ?? str(o.date);
  }
  return str(v);
}

export const CALENDAR_BINDINGS: McpModelBinding[] = [
  {
    model: 'calendar',
    tool: 'list_calendars',
    buildArgs: () => ({}),
    items: (r) => arrayField(r, ['calendars', 'items']),
    map: (raw): ExternalRecord | null => {
      const c = raw as Record<string, unknown>;
      const id = str(c.id) ?? str(c.calendar_id);
      if (!id) return null;
      const row: Record<string, unknown> = {};
      const summary = str(c.summary ?? c.name);
      if (summary !== undefined) row.summary = summary;
      const description = str(c.description);
      if (description !== undefined) row.description = description;
      const tz = str(c.time_zone ?? c.timeZone);
      if (tz !== undefined) row.time_zone = tz;
      if (c.primary !== undefined) row.primary = c.primary ? 1 : 0;
      const accessRole = str(c.access_role ?? c.accessRole);
      if (accessRole !== undefined) row.access_role = accessRole;
      return { id, row };
    },
  },
  {
    model: 'event',
    tool: 'list_events',
    buildArgs: ({ parentKey, cursor }) => ({
      calendar_id: parentKey,
      calendarId: parentKey,
      max_results: 250,
      single_events: true,
      ...(cursor ? { page_token: cursor } : {}),
    }),
    items: (r) => arrayField(r, ['events', 'items']),
    nextCursor: (r) => str(pick(r, 'next_page_token')) ?? str(pick(r, 'nextPageToken')) ?? null,
    map: (raw, ctx): ExternalRecord | null => {
      const e = raw as Record<string, unknown>;
      const id = str(e.id) ?? str(e.event_id);
      if (!id) return null;
      const row: Record<string, unknown> = {};
      if (ctx.parentKey !== undefined) row.calendar_id = ctx.parentKey;
      const summary = str(e.summary ?? e.title);
      if (summary !== undefined) row.summary = summary;
      const description = str(e.description);
      if (description !== undefined) row.description = description;
      const location = str(e.location);
      if (location !== undefined) row.location = location;
      const startAt = eventTime(e.start ?? e.start_at ?? e.startAt);
      if (startAt !== undefined) row.start_at = startAt;
      const endAt = eventTime(e.end ?? e.end_at ?? e.endAt);
      if (endAt !== undefined) row.end_at = endAt;
      const organizer = str(pick(e, 'organizer.email') ?? e.organizer);
      if (organizer !== undefined) row.organizer = organizer;
      const attendees = jsonCol(e.attendees);
      if (attendees !== undefined) row.attendees = attendees;
      const status = str(e.status);
      if (status !== undefined) row.status = status;
      const updated = str(e.updated ?? e.updated_at);
      if (updated !== undefined) row.updated = updated;
      return { id, row };
    },
  },
];

/** The Google Calendar MCP connector. Point it at a Google-Workspace MCP server. */
export function calendarConnector(deps: McpConnectorDeps = {}): SimpleMcpConnector {
  return new SimpleMcpConnector(
    {
      connector: CONNECTOR,
      presentation: { label: 'Google Calendar', icon: letterIcon('C', '#4285F4') },
      servers: [{ name: 'calendar', transport: 'http', oauth: true }],
      models: CALENDAR_MODELS,
      bindings: CALENDAR_BINDINGS,
    },
    deps,
  );
}
