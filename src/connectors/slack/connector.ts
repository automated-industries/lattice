/**
 * Slack MCP connector — a hand-authored, parameterized-tool connector over the
 * Slack workspace.
 *
 * The introspective connector only calls NO-ARGUMENT tools, so a Slack server
 * whose message-history tool requires a `channel` yields no per-channel messages.
 * This connector models that explicitly: it first lists the workspace channels
 * (`list_channels`, no channel arg) and users (`list_users`), then models messages
 * as a PER-CHANNEL child whose `channel` is supplied as the sync's `parentKey` — so
 * `conversations_history({ channel })` runs once per channel. This reuses the same
 * per-parent mechanism the Atlassian connector introduced.
 *
 * ⚠️ SPIKE-VERIFY THE MAPPERS. The tool NAMES below and the field paths follow the
 * documented Slack Web API result shapes, but they have NOT been confirmed against a
 * live server (that needs an interactive OAuth). Before shipping to real users, run
 * the plan's Phase-0 spike (connect → tools/list → a sample tools/call per tool) and
 * correct any `pick()` paths, the item-array wrapper keys in `items()`, and the
 * `nextCursor()` page-token field. The transport + parameterized-binding wiring is
 * verified by the fake-transport test.
 */

import {
  SimpleMcpConnector,
  type McpConnectorDeps,
  type McpModelBinding,
} from '../mcp/connector-base.js';
import { mcpModel, str, pick, arrayField } from '../mcp/connected-model.js';
import { letterIcon } from '../mcp/icon.js';
import type { ConnectedModelDef, ExternalRecord } from '../types.js';

const CONNECTOR = 'slack';
const TOOLKIT = 'slack';

// ⚠️ NEEDS-SPIKE: the Streamable-HTTP endpoint (NOT the legacy `/sse`). A `/v1/mcp`
// URL is inferred as `transport: 'http'` by McpServerSpec.
const SLACK_MCP_URL = 'https://mcp.slack.com/v1/mcp';

/** Compose a channel-unique natural key so two channels' identical message ts (which
 *  is only unique per channel) don't collide within one connector. parentKey is the
 *  channel id. */
function channelKey(parentKey: string | undefined, raw: unknown): string | undefined {
  const id = str(raw);
  if (id === undefined) return undefined;
  return parentKey ? `${parentKey}/${id}` : id;
}

// ── Models (tables) ──────────────────────────────────────────────────────────
// The channel model has no parent; messages are per-channel (their channel id
// arrives as the sync parentKey), and `childColumn` is stamped with that channel id
// by the sync.

const channels: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'slack_channels',
  model: 'slack_channels',
  naturalKey: 'channel_id',
  columns: {
    name: 'TEXT',
    is_private: 'TEXT',
    topic: 'TEXT',
    purpose: 'TEXT',
    num_members: 'TEXT',
  },
  def: {},
});

const users: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'slack_users',
  model: 'slack_users',
  naturalKey: 'user_id',
  columns: {
    name: 'TEXT',
    real_name: 'TEXT',
    email: 'TEXT',
    is_bot: 'TEXT',
  },
  def: {},
});

const messages: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'slack_messages',
  model: 'slack_messages',
  naturalKey: 'message_ts',
  columns: {
    channel_id: 'TEXT',
    user_id: 'TEXT',
    text: 'TEXT',
    ts: 'TEXT',
    thread_ts: 'TEXT',
  },
  def: { fts: { fields: ['text'] } },
  parent: { table: 'slack_channels', keyColumn: 'channel_id', childColumn: 'channel_id' },
});

// Model order matters: the channel model syncs first so messages can iterate its
// channel ids as their parentKey.
const MODELS: ConnectedModelDef[] = [channels, users, messages];

// ── Bindings (tool + mapper per model) ───────────────────────────────────────
// ⚠️ Mapper field paths + tool result wrapper keys are documented-but-unverified —
// spike-confirm before shipping (see the file header).

const BINDINGS: McpModelBinding[] = [
  {
    model: 'slack_channels',
    tool: 'list_channels',
    buildArgs: ({ cursor }) => ({ limit: 200, ...(cursor ? { cursor } : {}) }),
    items: (r) => arrayField(r, ['channels', 'values']),
    map: (item): ExternalRecord | null => {
      const id = str(pick(item, 'id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          name: str(pick(item, 'name')),
          is_private: str(pick(item, 'is_private')),
          topic: str(pick(item, 'topic.value')),
          purpose: str(pick(item, 'purpose.value')),
          num_members: str(pick(item, 'num_members')),
        },
      };
    },
    nextCursor: (r) => nextSlackCursor(r),
  },
  {
    model: 'slack_users',
    tool: 'list_users',
    buildArgs: ({ cursor }) => ({ limit: 200, ...(cursor ? { cursor } : {}) }),
    items: (r) => arrayField(r, ['members', 'users', 'values']),
    map: (item): ExternalRecord | null => {
      const id = str(pick(item, 'id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          name: str(pick(item, 'name')),
          real_name: str(pick(item, 'profile.real_name')) ?? str(pick(item, 'real_name')),
          email: str(pick(item, 'profile.email')),
          is_bot: str(pick(item, 'is_bot')),
        },
      };
    },
    nextCursor: (r) => nextSlackCursor(r),
  },
  {
    model: 'slack_messages',
    tool: 'conversations_history',
    buildArgs: ({ parentKey, cursor }) => ({
      channel: parentKey,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    }),
    items: (r) => arrayField(r, ['messages', 'values']),
    map: (item, ctx): ExternalRecord | null => {
      // ts is only unique per channel, so namespace it with the channel parentKey.
      const id = channelKey(ctx.parentKey, pick(item, 'ts'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          channel_id: ctx.parentKey,
          user_id: str(pick(item, 'user')),
          text: str(pick(item, 'text')),
          ts: str(pick(item, 'ts')),
          thread_ts: str(pick(item, 'thread_ts')),
        },
      };
    },
    nextCursor: (r) => nextSlackCursor(r),
  },
];

/** Slack cursor pagination: the next-page cursor lives in `response_metadata.next_cursor`
 *  (or a bare `next_cursor` field). Slack returns an EMPTY STRING on the last page, so
 *  treat empty as end-of-pages. Spike-verify the field names. */
function nextSlackCursor(result: unknown): string | null {
  const cursor =
    str(pick(result, 'response_metadata.next_cursor')) ?? str(pick(result, 'next_cursor'));
  // Slack sends an empty string (not a missing field) on the last page.
  if (cursor === undefined || cursor === '') return null;
  return cursor;
}

/** The Slack connector. One OAuth connect to the Slack Remote MCP server populates
 *  the channel, user, and per-channel message tables. */
export function slackConnector(deps: McpConnectorDeps = {}): SimpleMcpConnector {
  return new SimpleMcpConnector(
    {
      connector: CONNECTOR,
      toolkit: TOOLKIT,
      presentation: { label: 'Slack', icon: letterIcon('S', '#4a154b') },
      servers: [{ name: 'slack', url: SLACK_MCP_URL, transport: 'http', oauth: true }],
      models: MODELS,
      bindings: BINDINGS,
      // ⚠️ NEEDS-SPIKE: read scopes for channels, groups, users, and history. Spike-verify
      // the exact scope strings the Slack authorization server expects.
      scope: 'channels:read groups:read users:read channels:history',
    },
    deps,
  );
}
