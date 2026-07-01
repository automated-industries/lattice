/**
 * Google Drive MCP connector — pulls file metadata in as context via a Drive MCP
 * server's READ tools (`search_files` / `list_recent_files`). Only file *metadata*
 * is pulled (name, type, owner, links) — file *contents* are never bulk-downloaded
 * (a bounded read: Rule of never scanning unbounded blobs).
 *
 * Google Drive is OAuth-locked to claude.ai's own client, so point this at a
 * self-hosted / third-party Google-Workspace MCP server. Tool + field names target
 * the common Google-Workspace MCP shape; adjust the bindings if your server differs.
 */

import type { McpModelBinding } from '../mcp/connector-base.js';
import { SimpleMcpConnector, type McpConnectorDeps } from '../mcp/connector-base.js';
import { mcpModel, str, jsonCol, pick, arrayField } from '../mcp/connected-model.js';
import { letterIcon } from '../mcp/icon.js';
import type { ConnectedModelDef, ExternalRecord } from '../types.js';

const CONNECTOR = 'drive';

const files = mcpModel({
  connector: CONNECTOR,
  toolkit: CONNECTOR,
  table: 'drive_files',
  model: 'file',
  naturalKey: 'file_id',
  columns: {
    name: 'TEXT',
    mime_type: 'TEXT',
    owner: 'TEXT',
    modified_at: 'TEXT',
    web_view_link: 'TEXT',
    size: 'TEXT',
    parents: 'TEXT',
  },
  def: {
    description: 'Google Drive files',
    render: 'default-list',
    fts: { fields: ['name'] },
  },
});

/** Drive connected models. */
export const DRIVE_MODELS: ConnectedModelDef[] = [files];

export const DRIVE_BINDINGS: McpModelBinding[] = [
  {
    model: 'file',
    tool: 'search_files',
    buildArgs: ({ cursor }) => ({
      // A broad, bounded query — recent files first. Servers ignore unknown args.
      query: '',
      page_size: 100,
      order_by: 'modifiedTime desc',
      ...(cursor ? { page_token: cursor } : {}),
    }),
    items: (r) => arrayField(r, ['files', 'items', 'results']),
    nextCursor: (r) => str(pick(r, 'next_page_token')) ?? str(pick(r, 'nextPageToken')) ?? null,
    map: (raw): ExternalRecord | null => {
      const f = raw as Record<string, unknown>;
      const id = str(f.id) ?? str(f.file_id) ?? str(f.fileId);
      if (!id) return null;
      const row: Record<string, unknown> = {};
      const name = str(f.name ?? f.title);
      if (name !== undefined) row.name = name;
      const mime = str(f.mime_type ?? f.mimeType);
      if (mime !== undefined) row.mime_type = mime;
      const owner = str(pick(f, 'owner.email') ?? pick(f, 'owners.0.emailAddress') ?? f.owner);
      if (owner !== undefined) row.owner = owner;
      const modified = str(f.modified_at ?? f.modifiedTime ?? f.modifiedAt);
      if (modified !== undefined) row.modified_at = modified;
      const link = str(f.web_view_link ?? f.webViewLink ?? f.url);
      if (link !== undefined) row.web_view_link = link;
      const size = str(f.size ?? f.sizeBytes);
      if (size !== undefined) row.size = size;
      const parents = jsonCol(f.parents);
      if (parents !== undefined) row.parents = parents;
      return { id, row };
    },
  },
];

/** The Google Drive MCP connector. Point it at a Google-Workspace MCP server. */
export function driveConnector(deps: McpConnectorDeps = {}): SimpleMcpConnector {
  return new SimpleMcpConnector(
    {
      connector: CONNECTOR,
      presentation: { label: 'Google Drive', icon: letterIcon('D', '#0F9D58') },
      servers: [{ name: 'drive', transport: 'http', oauth: true }],
      models: DRIVE_MODELS,
      bindings: DRIVE_BINDINGS,
    },
    deps,
  );
}
