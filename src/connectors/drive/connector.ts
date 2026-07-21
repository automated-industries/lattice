/**
 * Google Drive MCP connector — a hand-authored, single-model connector over the
 * Google Drive Remote MCP server.
 *
 * Drive files form a FLAT list (no per-parent model): one paged `search_files`
 * pass populates the `drive_files` table. Each Drive file id is globally unique
 * across the account, so the natural key is the raw id — no parent-namespacing
 * (contrast Atlassian, whose per-site issue keys must be site-namespaced).
 *
 * ⚠️ SPIKE-VERIFY THE MAPPERS + THE URL/SCOPE. The tool name and field paths below
 * follow Google Drive's documented `files.list` result shape, but they have NOT
 * been confirmed against a live server (that needs an interactive OAuth). The
 * server URL and OAuth scope are likewise documented-but-unverified — marked
 * NEEDS-SPIKE inline. Before shipping to real users, run the plan's Phase-0 spike
 * (connect → tools/list → a sample tools/call) and correct any `pick()` paths, the
 * item-array wrapper keys in `items()`, and the `nextCursor()` page-token field.
 * The transport + binding wiring is verified by the fake-transport test.
 */

import {
  SimpleMcpConnector,
  type McpConnectorDeps,
  type McpModelBinding,
} from '../mcp/connector-base.js';
import { mcpModel, str, jsonCol, pick, arrayField } from '../mcp/connected-model.js';
import { letterIcon } from '../mcp/icon.js';
import type { ConnectedModelDef, ExternalRecord } from '../types.js';

const CONNECTOR = 'drive';
const TOOLKIT = 'drive';

// The Streamable-HTTP endpoint (NOT the legacy `/sse`). A `/v1/mcp` URL is
// inferred as `transport: 'http'` by McpServerSpec.
// ⚠️ NEEDS-SPIKE: confirm the exact Drive Remote MCP URL against a live server.
const DRIVE_MCP_URL = 'https://mcp.google.com/drive/v1/mcp';

// ── Models (tables) ──────────────────────────────────────────────────────────
// A single flat model: one paged `search_files` pass. No parent, so no parentKey.

const driveFiles: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'drive_files',
  model: 'drive_files',
  naturalKey: 'file_id',
  columns: {
    name: 'TEXT',
    mime_type: 'TEXT',
    owner: 'TEXT',
    modified_at: 'TEXT',
    web_view_link: 'TEXT',
    parents: 'TEXT',
  },
  def: { fts: { fields: ['name'] } },
});

const MODELS: ConnectedModelDef[] = [driveFiles];

// ── Bindings (tool + mapper per model) ───────────────────────────────────────
// ⚠️ Mapper field paths + tool result wrapper keys are documented-but-unverified —
// spike-confirm before shipping (see the file header).

const BINDINGS: McpModelBinding[] = [
  {
    model: 'drive_files',
    tool: 'search_files',
    buildArgs: ({ cursor }) => ({
      pageSize: 100,
      ...(cursor ? { pageToken: cursor } : {}),
    }),
    items: (r) => arrayField(r, ['files', 'values']),
    map: (item): ExternalRecord | null => {
      // Drive file ids are globally unique across the account — no namespacing.
      const id = str(pick(item, 'id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          name: str(pick(item, 'name')),
          mime_type: str(pick(item, 'mimeType')),
          owner: str(pick(item, 'owners.0.emailAddress')) ?? str(pick(item, 'owner')),
          modified_at: str(pick(item, 'modifiedTime')),
          web_view_link: str(pick(item, 'webViewLink')),
          parents: jsonCol(pick(item, 'parents')),
        },
      };
    },
    nextCursor: (r) => str(pick(r, 'nextPageToken')) ?? null,
  },
];

/** The Google Drive connector. One OAuth connect to the Drive Remote MCP server
 *  populates the `drive_files` table. */
export function driveConnector(deps: McpConnectorDeps = {}): SimpleMcpConnector {
  return new SimpleMcpConnector(
    {
      connector: CONNECTOR,
      toolkit: TOOLKIT,
      presentation: { label: 'Google Drive', icon: letterIcon('D', '#0f9d58') },
      servers: [{ name: 'drive', url: DRIVE_MCP_URL, transport: 'http', oauth: true }],
      models: MODELS,
      bindings: BINDINGS,
      // Read-only file metadata scope.
      // ⚠️ NEEDS-SPIKE: confirm the exact scope string Google's authorization server expects.
      scope: 'https://www.googleapis.com/auth/drive.metadata.readonly',
    },
    deps,
  );
}
