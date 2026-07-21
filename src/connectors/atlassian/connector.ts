/**
 * Atlassian (Jira + Confluence) MCP connector — the first hand-authored,
 * parameterized-tool connector.
 *
 * The introspective connector only calls NO-ARGUMENT tools, so an Atlassian server
 * (whose useful read tools all require a `cloudId`) yields no Jira/Confluence tables.
 * This connector models those parameterized tools explicitly: it first lists the
 * accessible Atlassian sites (`getAccessibleAtlassianResources`, no args), and every
 * other model is a PER-SITE child whose `cloudId` is supplied as the sync's
 * `parentKey` — so `searchJiraIssuesUsingJql({ cloudId, jql })` etc. run once per site.
 * This is the mechanism the other six built-in connectors will reuse.
 *
 * ⚠️ SPIKE-VERIFY THE MAPPERS. The tool NAMES below are the documented Atlassian
 * Remote MCP tools, and the field paths follow Atlassian's documented result shapes,
 * but they have NOT been confirmed against a live server (that needs an interactive
 * OAuth). Before shipping to real users, run the plan's Phase-0 spike (connect →
 * tools/list → a sample tools/call per tool) and correct any `pick()` paths, the
 * item-array wrapper keys in `items()`, and the `nextCursor()` page-token field. The
 * transport + parameterized-binding wiring is verified by the fake-transport test.
 */

import {
  SimpleMcpConnector,
  type McpConnectorDeps,
  type McpModelBinding,
} from '../mcp/connector-base.js';
import { mcpModel, str, jsonCol, pick, arrayField } from '../mcp/connected-model.js';
import { letterIcon } from '../mcp/icon.js';
import type { ConnectedModelDef, ExternalRecord } from '../types.js';

const CONNECTOR = 'atlassian';
const TOOLKIT = 'atlassian';

// The Streamable-HTTP endpoint (NOT the legacy `/v1/sse`). A `/v1/mcp` URL is
// inferred as `transport: 'http'` by McpServerSpec.
const ATLASSIAN_MCP_URL = 'https://mcp.atlassian.com/v1/mcp';

/** Compose a site-unique natural key so two sites' identical ids (e.g. PROJ-1) don't
 *  collide within one connector. parentKey is the site cloudId. */
function siteKey(parentKey: string | undefined, raw: unknown): string | undefined {
  const id = str(raw);
  if (id === undefined) return undefined;
  return parentKey ? `${parentKey}/${id}` : id;
}

// ── Models (tables) ──────────────────────────────────────────────────────────
// The site model has no parent; every other model is per-site (its cloudId arrives
// as the sync parentKey), and `childColumn` is stamped with that cloudId by the sync.

const sites: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'atlassian_sites',
  model: 'sites',
  naturalKey: 'cloud_id',
  columns: { name: 'TEXT', url: 'TEXT', scopes: 'TEXT' },
  def: {},
});

const jiraProjects: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'jira_projects',
  model: 'jira_projects',
  naturalKey: 'project_id',
  columns: { site_cloud_id: 'TEXT', project_key: 'TEXT', name: 'TEXT', project_type: 'TEXT' },
  def: {},
  parent: { table: 'atlassian_sites', keyColumn: 'cloud_id', childColumn: 'site_cloud_id' },
});

const jiraIssues: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'jira_issues',
  model: 'jira_issues',
  naturalKey: 'issue_key',
  columns: {
    site_cloud_id: 'TEXT',
    project_key: 'TEXT',
    summary: 'TEXT',
    status: 'TEXT',
    assignee: 'TEXT',
    priority: 'TEXT',
    issue_type: 'TEXT',
    created: 'TEXT',
    updated: 'TEXT',
    description: 'TEXT',
  },
  def: { fts: { fields: ['summary', 'description'] } },
  parent: { table: 'atlassian_sites', keyColumn: 'cloud_id', childColumn: 'site_cloud_id' },
});

const confluenceSpaces: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'confluence_spaces',
  model: 'confluence_spaces',
  naturalKey: 'space_id',
  columns: { site_cloud_id: 'TEXT', space_key: 'TEXT', name: 'TEXT', type: 'TEXT' },
  def: {},
  parent: { table: 'atlassian_sites', keyColumn: 'cloud_id', childColumn: 'site_cloud_id' },
});

const confluencePages: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'confluence_pages',
  model: 'confluence_pages',
  naturalKey: 'page_id',
  columns: {
    site_cloud_id: 'TEXT',
    space_key: 'TEXT',
    title: 'TEXT',
    status: 'TEXT',
    url: 'TEXT',
    updated: 'TEXT',
  },
  def: { fts: { fields: ['title'] } },
  parent: { table: 'atlassian_sites', keyColumn: 'cloud_id', childColumn: 'site_cloud_id' },
});

// Model order matters: the site model syncs first so the children can iterate its
// cloudIds as their parentKey.
const MODELS: ConnectedModelDef[] = [
  sites,
  jiraProjects,
  jiraIssues,
  confluenceSpaces,
  confluencePages,
];

// ── Bindings (tool + mapper per model) ───────────────────────────────────────
// ⚠️ Mapper field paths + tool result wrapper keys are documented-but-unverified —
// spike-confirm before shipping (see the file header).

const BINDINGS: McpModelBinding[] = [
  {
    model: 'sites',
    tool: 'getAccessibleAtlassianResources',
    buildArgs: () => ({}),
    items: (r) => arrayField(r, ['resources', 'sites', 'values']),
    map: (item): ExternalRecord | null => {
      const cloudId = str(pick(item, 'id'));
      if (cloudId === undefined) return null;
      return {
        id: cloudId,
        row: {
          name: str(pick(item, 'name')),
          url: str(pick(item, 'url')),
          scopes: jsonCol(pick(item, 'scopes')),
        },
      };
    },
  },
  {
    model: 'jira_projects',
    tool: 'getVisibleJiraProjects',
    buildArgs: ({ parentKey, cursor }) => ({
      cloudId: parentKey,
      ...(cursor ? { startAt: Number(cursor) } : {}),
    }),
    items: (r) => arrayField(r, ['values', 'projects']),
    map: (item, ctx): ExternalRecord | null => {
      const id = siteKey(ctx.parentKey, pick(item, 'id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          project_key: str(pick(item, 'key')),
          name: str(pick(item, 'name')),
          project_type: str(pick(item, 'projectTypeKey')),
        },
      };
    },
    nextCursor: (r) => nextStartAt(r),
  },
  {
    model: 'jira_issues',
    tool: 'searchJiraIssuesUsingJql',
    buildArgs: ({ parentKey, cursor }) => ({
      cloudId: parentKey,
      jql: 'ORDER BY updated DESC',
      maxResults: 50,
      ...(cursor ? { nextPageToken: cursor } : {}),
    }),
    items: (r) => arrayField(r, ['issues', 'values']),
    map: (item, ctx): ExternalRecord | null => {
      const id = siteKey(ctx.parentKey, pick(item, 'key'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          project_key: str(pick(item, 'fields.project.key')),
          summary: str(pick(item, 'fields.summary')),
          status: str(pick(item, 'fields.status.name')),
          assignee: str(pick(item, 'fields.assignee.displayName')),
          priority: str(pick(item, 'fields.priority.name')),
          issue_type: str(pick(item, 'fields.issuetype.name')),
          created: str(pick(item, 'fields.created')),
          updated: str(pick(item, 'fields.updated')),
          description: str(pick(item, 'fields.description')),
        },
      };
    },
    nextCursor: (r) => str(pick(r, 'nextPageToken')) ?? null,
  },
  {
    model: 'confluence_spaces',
    tool: 'getConfluenceSpaces',
    buildArgs: ({ parentKey, cursor }) => ({
      cloudId: parentKey,
      ...(cursor ? { cursor } : {}),
    }),
    items: (r) => arrayField(r, ['results', 'values', 'spaces']),
    map: (item, ctx): ExternalRecord | null => {
      const id = siteKey(ctx.parentKey, pick(item, 'id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          space_key: str(pick(item, 'key')),
          name: str(pick(item, 'name')),
          type: str(pick(item, 'type')),
        },
      };
    },
    nextCursor: (r) => nextCloudCursor(r),
  },
  {
    model: 'confluence_pages',
    tool: 'getConfluencePages',
    buildArgs: ({ parentKey, cursor }) => ({
      cloudId: parentKey,
      ...(cursor ? { cursor } : {}),
    }),
    items: (r) => arrayField(r, ['results', 'values', 'pages']),
    map: (item, ctx): ExternalRecord | null => {
      const id = siteKey(ctx.parentKey, pick(item, 'id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          space_key: str(pick(item, 'spaceId')) ?? str(pick(item, 'space.key')),
          title: str(pick(item, 'title')),
          status: str(pick(item, 'status')),
          url: str(pick(item, '_links.webui')) ?? str(pick(item, 'url')),
          updated: str(pick(item, 'version.createdAt')) ?? str(pick(item, 'updated')),
        },
      };
    },
    nextCursor: (r) => nextCloudCursor(r),
  },
];

/** Jira `startAt` pagination: advance while the returned page is full. Returns the
 *  next `startAt` as a string cursor, or null at the end. Spike-verify the field names. */
function nextStartAt(result: unknown): string | null {
  const startAt = Number(pick(result, 'startAt') ?? 0);
  const maxResults = Number(pick(result, 'maxResults') ?? 0);
  const total = Number(pick(result, 'total') ?? 0);
  const next = startAt + maxResults;
  return maxResults > 0 && next < total ? String(next) : null;
}

/** Confluence Cloud cursor pagination: the next-page cursor lives in `_links.next`
 *  (a URL with a `cursor` query param) or a bare `cursor` field. Spike-verify. */
function nextCloudCursor(result: unknown): string | null {
  const bare = str(pick(result, 'cursor'));
  if (bare) return bare;
  const nextLink = str(pick(result, '_links.next'));
  if (nextLink) {
    const m = /[?&]cursor=([^&]+)/.exec(nextLink);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

/** The Atlassian (Jira + Confluence) connector. One OAuth connect to the Atlassian
 *  Remote MCP server populates both products' tables. */
export function atlassianConnector(deps: McpConnectorDeps = {}): SimpleMcpConnector {
  return new SimpleMcpConnector(
    {
      connector: CONNECTOR,
      toolkit: TOOLKIT,
      presentation: { label: 'Jira & Confluence', icon: letterIcon('A', '#0052cc') },
      servers: [{ name: 'atlassian', url: ATLASSIAN_MCP_URL, transport: 'http', oauth: true }],
      models: MODELS,
      bindings: BINDINGS,
      // Read scopes for Jira + Confluence + the resource list. Spike-verify the exact
      // scope strings the Atlassian authorization server expects.
      scope:
        'read:jira-work read:jira-user read:confluence-space.summary read:confluence-content.summary offline_access',
    },
    deps,
  );
}
