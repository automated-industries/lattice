/**
 * Gmail MCP connector — a hand-authored, parameterized-tool connector over the
 * Google Gmail Remote MCP server.
 *
 * The introspective connector only calls NO-ARGUMENT tools, so a Gmail server
 * (whose message read tool requires a `thread_id`) yields only the flat lists.
 * This connector models the parameterized tool explicitly: it first lists the
 * account's labels (`list_labels`, no args) and threads (`search_threads`, no
 * parent), and the message model is a PER-THREAD child whose `thread_id` is
 * supplied as the sync's `parentKey` — so `get_thread({ thread_id })` runs once
 * per thread. This is the same mechanism the Atlassian connector established.
 *
 * ⚠️ SPIKE-VERIFY THE MAPPERS. The tool NAMES below are the documented Gmail
 * Remote MCP tools, and the field paths follow Gmail's documented API result
 * shapes, but they have NOT been confirmed against a live server (that needs an
 * interactive OAuth). Before shipping to real users, run the plan's Phase-0 spike
 * (connect → tools/list → a sample tools/call per tool) and correct any `pick()`
 * paths, the item-array wrapper keys in `items()`, and the `nextCursor()`
 * page-token field. The transport + parameterized-binding wiring is verified by
 * the fake-transport test.
 */

import {
  SimpleMcpConnector,
  type McpConnectorDeps,
  type McpModelBinding,
} from '../mcp/connector-base.js';
import { mcpModel, str, jsonCol, pick, arrayField } from '../mcp/connected-model.js';
import { letterIcon } from '../mcp/icon.js';
import type { ConnectedModelDef, ExternalRecord } from '../types.js';

const CONNECTOR = 'gmail';
const TOOLKIT = 'gmail';

// ⚠️ NEEDS-SPIKE: the Streamable-HTTP endpoint (NOT the legacy `/sse`). A `/v1/mcp`
// URL is inferred as `transport: 'http'` by McpServerSpec. Confirm the exact host +
// path against the live Gmail Remote MCP server before shipping.
const GMAIL_MCP_URL = 'https://mcp.google.com/gmail/v1/mcp';

// ── Models (tables) ──────────────────────────────────────────────────────────
// Labels + threads have no parent; messages are per-thread (their thread_id arrives
// as the sync parentKey), and `childColumn` is stamped with that thread_id by the sync.

const labels: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'gmail_labels',
  model: 'gmail_labels',
  naturalKey: 'label_id',
  columns: { name: 'TEXT', type: 'TEXT' },
  def: {},
});

const threads: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'gmail_threads',
  model: 'gmail_threads',
  naturalKey: 'thread_id',
  columns: {
    subject: 'TEXT',
    snippet: 'TEXT',
    last_message_at: 'TEXT',
    label_ids: 'TEXT',
    history_id: 'TEXT',
  },
  def: { fts: { fields: ['subject', 'snippet'] } },
});

const messages: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'gmail_messages',
  model: 'gmail_messages',
  naturalKey: 'message_id',
  columns: {
    thread_id: 'TEXT',
    from_addr: 'TEXT',
    to_addrs: 'TEXT',
    subject: 'TEXT',
    body_text: 'TEXT',
    sent_at: 'TEXT',
    label_ids: 'TEXT',
  },
  def: { fts: { fields: ['subject', 'body_text'] } },
  parent: { table: 'gmail_threads', keyColumn: 'thread_id', childColumn: 'thread_id' },
});

// Model order matters: the thread model syncs first so the message child can iterate
// its thread_ids as their parentKey.
const MODELS: ConnectedModelDef[] = [labels, threads, messages];

// ── Bindings (tool + mapper per model) ───────────────────────────────────────
// ⚠️ Mapper field paths + tool result wrapper keys are documented-but-unverified —
// spike-confirm before shipping (see the file header).

const BINDINGS: McpModelBinding[] = [
  {
    model: 'gmail_labels',
    tool: 'list_labels',
    buildArgs: () => ({}),
    items: (r) => arrayField(r, ['labels', 'values']),
    map: (item): ExternalRecord | null => {
      const id = str(pick(item, 'id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          name: str(pick(item, 'name')),
          type: str(pick(item, 'type')),
        },
      };
    },
  },
  {
    model: 'gmail_threads',
    tool: 'search_threads',
    buildArgs: ({ cursor }) => ({
      maxResults: 50,
      ...(cursor ? { pageToken: cursor } : {}),
    }),
    items: (r) => arrayField(r, ['threads', 'values']),
    map: (item): ExternalRecord | null => {
      const id = str(pick(item, 'id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          subject: str(pick(item, 'subject')),
          snippet: str(pick(item, 'snippet')),
          last_message_at: str(pick(item, 'lastMessageAt')) ?? str(pick(item, 'last_message_at')),
          label_ids: jsonCol(pick(item, 'labelIds')),
          history_id: str(pick(item, 'historyId')),
        },
      };
    },
    nextCursor: (r) => str(pick(r, 'nextPageToken')) ?? null,
  },
  {
    model: 'gmail_messages',
    tool: 'get_thread',
    buildArgs: ({ parentKey }) => ({ thread_id: parentKey }),
    items: (r) => arrayField(r, ['messages', 'values']),
    map: (item, ctx): ExternalRecord | null => {
      // Gmail message ids are globally unique across threads — do NOT namespace
      // the natural key with parentKey (unlike Atlassian's per-site issue keys).
      const id = str(pick(item, 'id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          thread_id: ctx.parentKey ?? str(pick(item, 'threadId')),
          from_addr: str(pick(item, 'from')),
          to_addrs: jsonCol(pick(item, 'to')),
          subject: str(pick(item, 'subject')),
          body_text: str(pick(item, 'body')) ?? str(pick(item, 'bodyText')),
          sent_at: str(pick(item, 'sentAt')) ?? str(pick(item, 'internalDate')),
          label_ids: jsonCol(pick(item, 'labelIds')),
        },
      };
    },
  },
];

/** The Gmail connector. One OAuth connect to the Gmail Remote MCP server populates
 *  the labels, threads, and per-thread message tables. */
export function gmailConnector(deps: McpConnectorDeps = {}): SimpleMcpConnector {
  return new SimpleMcpConnector(
    {
      connector: CONNECTOR,
      toolkit: TOOLKIT,
      presentation: { label: 'Gmail', icon: letterIcon('M', '#ea4335') },
      servers: [{ name: 'gmail', url: GMAIL_MCP_URL, transport: 'http', oauth: true }],
      models: MODELS,
      bindings: BINDINGS,
      // ⚠️ NEEDS-SPIKE: read-only Gmail scope. Confirm the exact scope string the
      // Google authorization server expects for the Remote MCP server.
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    },
    deps,
  );
}
