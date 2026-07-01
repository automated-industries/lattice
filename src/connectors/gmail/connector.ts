/**
 * Gmail MCP connector — pulls labels, threads, and messages in as context via a
 * Gmail MCP server's READ tools (`list_labels`, `search_threads`, `get_thread`).
 * Only read tools are ever called; nothing is sent or modified.
 *
 * Gmail/Calendar/Drive are OAuth-locked to claude.ai's own client, so there is no
 * public first-party endpoint a third party can reach — point this connector at a
 * self-hosted / third-party Google-Workspace MCP server (HTTP `url` or a local
 * `stdio` command). Tool + field names below target the common Google-Workspace
 * MCP shape; adjust the bindings if your server differs.
 */

import type { McpModelBinding } from '../mcp/connector-base.js';
import { SimpleMcpConnector, type McpConnectorDeps } from '../mcp/connector-base.js';
import { mcpModel, str, jsonCol, pick, arrayField } from '../mcp/connected-model.js';
import { letterIcon } from '../mcp/icon.js';
import type { ConnectedModelDef, ExternalRecord } from '../types.js';

const CONNECTOR = 'gmail';

// --- Connected models --------------------------------------------------------

const labels = mcpModel({
  connector: CONNECTOR,
  toolkit: CONNECTOR,
  table: 'gmail_labels',
  model: 'label',
  naturalKey: 'label_id',
  columns: { name: 'TEXT', type: 'TEXT' },
  def: { description: 'Gmail labels', render: 'default-list' },
});

const threads = mcpModel({
  connector: CONNECTOR,
  toolkit: CONNECTOR,
  table: 'gmail_threads',
  model: 'thread',
  naturalKey: 'thread_id',
  columns: {
    subject: 'TEXT',
    snippet: 'TEXT',
    last_message_at: 'TEXT',
    label_ids: 'TEXT',
    history_id: 'TEXT',
  },
  def: {
    description: 'Gmail threads',
    render: 'default-detail',
    fts: { fields: ['subject', 'snippet'] },
  },
});

const messages = mcpModel({
  connector: CONNECTOR,
  toolkit: CONNECTOR,
  table: 'gmail_messages',
  model: 'message',
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
  def: {
    description: 'Gmail messages',
    render: 'default-list',
    fts: { fields: ['subject', 'body_text'] },
    relations: {
      thread: {
        type: 'belongsTo',
        table: 'gmail_threads',
        foreignKey: 'thread_id',
        references: 'thread_id',
      },
    },
  },
  graphEdges: [{ fkColumn: 'thread_id', dstTable: 'gmail_threads', type: 'in_thread' }],
  // Messages are fetched per thread: the sync engine iterates already-synced
  // thread ids and passes each as parentKey, stamped onto the message thread_id.
  parent: {
    table: 'gmail_threads',
    keyColumn: 'thread_id',
    childColumn: 'thread_id',
    incrementalColumn: 'last_message_at',
  },
});

/** Gmail connected models, parents before children. */
export const GMAIL_MODELS: ConnectedModelDef[] = [labels, threads, messages];

// --- Mappers -----------------------------------------------------------------

/** Read an RFC-822 header value from a raw Gmail message payload, case-insensitively. */
function header(msg: Record<string, unknown>, name: string): string | undefined {
  const hs = pick(msg, 'payload.headers');
  if (Array.isArray(hs)) {
    for (const h of hs) {
      if (!h || typeof h !== 'object') continue;
      const rec = h as Record<string, unknown>;
      const hn = str(rec.name);
      if (typeof hn === 'string' && hn.toLowerCase() === name.toLowerCase()) {
        return str(rec.value);
      }
    }
  }
  return undefined;
}

/** Epoch-ms `internalDate` → ISO, tolerating already-ISO strings. */
function gmailDate(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return new Date(n).toISOString();
  }
  return s;
}

// --- Bindings (which read tool feeds each model + how to map its JSON) --------

export const GMAIL_BINDINGS: McpModelBinding[] = [
  {
    model: 'label',
    tool: 'list_labels',
    buildArgs: () => ({}),
    items: (r) => arrayField(r, ['labels', 'items']),
    map: (raw): ExternalRecord | null => {
      const l = raw as Record<string, unknown>;
      const id = str(l.id) ?? str(l.label_id);
      if (!id) return null;
      const row: Record<string, unknown> = {};
      const name = str(l.name);
      if (name !== undefined) row.name = name;
      const type = str(l.type);
      if (type !== undefined) row.type = type;
      return { id, row };
    },
  },
  {
    model: 'thread',
    tool: 'search_threads',
    buildArgs: ({ cursor }) => ({
      query: 'newer_than:1y',
      max_results: 100,
      ...(cursor ? { page_token: cursor } : {}),
    }),
    items: (r) => arrayField(r, ['threads', 'items']),
    nextCursor: (r) => str(pick(r, 'next_page_token')) ?? str(pick(r, 'nextPageToken')) ?? null,
    map: (raw): ExternalRecord | null => {
      const t = raw as Record<string, unknown>;
      const id = str(t.id) ?? str(t.thread_id) ?? str(t.threadId);
      if (!id) return null;
      const row: Record<string, unknown> = {};
      const subject = str(t.subject);
      if (subject !== undefined) row.subject = subject;
      const snippet = str(t.snippet);
      if (snippet !== undefined) row.snippet = snippet;
      const lastAt = gmailDate(t.last_message_at ?? t.lastMessageAt ?? t.internalDate);
      if (lastAt !== undefined) row.last_message_at = lastAt;
      const labelIds = jsonCol(t.label_ids ?? t.labelIds);
      if (labelIds !== undefined) row.label_ids = labelIds;
      const historyId = str(t.history_id ?? t.historyId);
      if (historyId !== undefined) row.history_id = historyId;
      return { id, row };
    },
  },
  {
    model: 'message',
    tool: 'get_thread',
    buildArgs: ({ parentKey }) => ({ thread_id: parentKey, id: parentKey }),
    items: (r) => arrayField(r, ['messages']),
    map: (raw, ctx): ExternalRecord | null => {
      const m = raw as Record<string, unknown>;
      const id = str(m.id) ?? str(m.message_id) ?? str(m.messageId);
      if (!id) return null;
      const row: Record<string, unknown> = {};
      const threadId = str(m.thread_id ?? m.threadId) ?? ctx.parentKey;
      if (threadId !== undefined) row.thread_id = threadId;
      const from = str(m.from ?? m.from_addr) ?? header(m, 'From');
      if (from !== undefined) row.from_addr = from;
      const to = m.to ?? m.to_addrs ?? header(m, 'To');
      const toJson = jsonCol(Array.isArray(to) ? to : to !== undefined ? [to] : undefined);
      if (toJson !== undefined) row.to_addrs = toJson;
      const subject = str(m.subject) ?? header(m, 'Subject');
      if (subject !== undefined) row.subject = subject;
      const body = str(m.body_text ?? m.bodyText ?? m.body ?? m.text ?? m.snippet);
      if (body !== undefined) row.body_text = body;
      const sentAt = gmailDate(m.sent_at ?? m.sentAt ?? m.internalDate) ?? header(m, 'Date');
      if (sentAt !== undefined) row.sent_at = sentAt;
      const labelIds = jsonCol(m.label_ids ?? m.labelIds);
      if (labelIds !== undefined) row.label_ids = labelIds;
      return { id, row };
    },
  },
];

// --- Connector ---------------------------------------------------------------

/** The Gmail MCP connector. Point it at a Google-Workspace MCP server. */
export function gmailConnector(deps: McpConnectorDeps = {}): SimpleMcpConnector {
  return new SimpleMcpConnector(
    {
      connector: CONNECTOR,
      presentation: { label: 'Gmail', icon: letterIcon('M', '#EA4335') },
      // No default URL — Gmail requires a user-supplied (self-hosted) MCP server.
      servers: [{ name: 'gmail', transport: 'http', oauth: true }],
      models: GMAIL_MODELS,
      bindings: GMAIL_BINDINGS,
    },
    deps,
  );
}
