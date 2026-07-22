/**
 * Salesforce MCP connector — a FLAT-list connector over the Salesforce Remote MCP
 * server.
 *
 * Unlike the per-site Atlassian connector, every Salesforce model is a top-level
 * list tool (`list_accounts`, `list_contacts`, `list_opportunities`) that takes no
 * parent key: `account_id` is a plain foreign-key COLUMN on contacts and
 * opportunities, not a sync parent. Salesforce SObject `Id`s are globally unique
 * across the org, so the natural keys are NOT namespaced (contrast Atlassian's
 * per-site `siteKey`).
 *
 * ⚠️ SPIKE-VERIFY THE MAPPERS. The tool NAMES below and the field paths follow
 * Salesforce's documented SObject shapes (`Id`/`Name`/`AccountId`/`StageName`/…),
 * but they have NOT been confirmed against a live server (that needs an interactive
 * OAuth). Before shipping to real users, run the plan's Phase-0 spike (connect →
 * tools/list → a sample tools/call per tool) and correct any `pick()` paths, the
 * item-array wrapper keys in `items()`, and the `nextCursor()` page-token field. The
 * transport + list-binding wiring is verified by the fake-transport test.
 */

import {
  SimpleMcpConnector,
  type McpConnectorDeps,
  type McpModelBinding,
} from '../mcp/connector-base.js';
import { mcpModel, str, pick, arrayField } from '../mcp/connected-model.js';
import { letterIcon } from '../mcp/icon.js';
import type { ConnectedModelDef, ExternalRecord } from '../types.js';

const CONNECTOR = 'salesforce';
const TOOLKIT = 'salesforce';

// ⚠️ NEEDS-SPIKE: the Streamable-HTTP endpoint (NOT the legacy `/v1/sse`). A
// `/v1/mcp` URL is inferred as `transport: 'http'` by McpServerSpec. Confirm the
// exact host + path against the live Salesforce Remote MCP server.
const SALESFORCE_MCP_URL = 'https://mcp.salesforce.com/v1/mcp';

// ── Models (tables) ──────────────────────────────────────────────────────────
// Flat lists — no parent. `account_id` on contacts/opportunities is a plain FK
// column, populated straight from the record's `AccountId`, not a sync parentKey.

const accounts: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'salesforce_accounts',
  model: 'accounts',
  naturalKey: 'account_id',
  columns: {
    name: 'TEXT',
    industry: 'TEXT',
    type: 'TEXT',
    website: 'TEXT',
    owner: 'TEXT',
  },
  def: { fts: { fields: ['name'] } },
});

const contacts: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'salesforce_contacts',
  model: 'contacts',
  naturalKey: 'contact_id',
  columns: {
    account_id: 'TEXT',
    name: 'TEXT',
    email: 'TEXT',
    title: 'TEXT',
    phone: 'TEXT',
  },
  def: { fts: { fields: ['name'] } },
});

const opportunities: ConnectedModelDef = mcpModel({
  connector: CONNECTOR,
  toolkit: TOOLKIT,
  table: 'salesforce_opportunities',
  model: 'opportunities',
  naturalKey: 'opportunity_id',
  columns: {
    account_id: 'TEXT',
    name: 'TEXT',
    stage: 'TEXT',
    amount: 'TEXT',
    close_date: 'TEXT',
  },
  def: { fts: { fields: ['name'] } },
});

const MODELS: ConnectedModelDef[] = [accounts, contacts, opportunities];

// ── Bindings (tool + mapper per model) ───────────────────────────────────────
// ⚠️ Mapper field paths + tool result wrapper keys are documented-but-unverified —
// spike-confirm before shipping (see the file header).

/** Every list tool takes the same `pageSize` + optional `cursor` page arg. */
function pageArgs({ cursor }: { cursor?: string | null }): Record<string, unknown> {
  return { pageSize: 100, ...(cursor ? { cursor } : {}) };
}

/** The next-page cursor: Salesforce returns `nextRecordsUrl` (or a bare
 *  `next_cursor`); null when the last page was reached. Spike-verify the field. */
function nextCursor(result: unknown): string | null {
  return str(pick(result, 'nextRecordsUrl')) ?? str(pick(result, 'next_cursor')) ?? null;
}

const BINDINGS: McpModelBinding[] = [
  {
    model: 'accounts',
    tool: 'list_accounts',
    buildArgs: pageArgs,
    items: (r) => arrayField(r, ['records', 'accounts', 'values']),
    map: (item): ExternalRecord | null => {
      const id = str(pick(item, 'Id')) ?? str(pick(item, 'id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          name: str(pick(item, 'Name')),
          industry: str(pick(item, 'Industry')),
          type: str(pick(item, 'Type')),
          website: str(pick(item, 'Website')),
          owner: str(pick(item, 'Owner.Name')),
        },
      };
    },
    nextCursor,
  },
  {
    model: 'contacts',
    tool: 'list_contacts',
    buildArgs: pageArgs,
    items: (r) => arrayField(r, ['records', 'contacts', 'values']),
    map: (item): ExternalRecord | null => {
      const id = str(pick(item, 'Id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          account_id: str(pick(item, 'AccountId')),
          name: str(pick(item, 'Name')),
          email: str(pick(item, 'Email')),
          title: str(pick(item, 'Title')),
          phone: str(pick(item, 'Phone')),
        },
      };
    },
    nextCursor,
  },
  {
    model: 'opportunities',
    tool: 'list_opportunities',
    buildArgs: pageArgs,
    items: (r) => arrayField(r, ['records', 'opportunities', 'values']),
    map: (item): ExternalRecord | null => {
      const id = str(pick(item, 'Id'));
      if (id === undefined) return null;
      return {
        id,
        row: {
          account_id: str(pick(item, 'AccountId')),
          name: str(pick(item, 'Name')),
          stage: str(pick(item, 'StageName')),
          amount: str(pick(item, 'Amount')),
          close_date: str(pick(item, 'CloseDate')),
        },
      };
    },
    nextCursor,
  },
];

/** The Salesforce connector. One OAuth connect to the Salesforce Remote MCP server
 *  populates the accounts, contacts, and opportunities tables. */
export function salesforceConnector(deps: McpConnectorDeps = {}): SimpleMcpConnector {
  return new SimpleMcpConnector(
    {
      connector: CONNECTOR,
      toolkit: TOOLKIT,
      presentation: { label: 'Salesforce', icon: letterIcon('S', '#00a1e0') },
      servers: [{ name: 'salesforce', url: SALESFORCE_MCP_URL, transport: 'http', oauth: true }],
      models: MODELS,
      bindings: BINDINGS,
      // ⚠️ NEEDS-SPIKE: the exact scope string the Salesforce authorization server
      // expects. `api` grants REST/SObject access; `refresh_token` keeps the sync
      // alive past the access-token TTL.
      scope: 'api refresh_token',
    },
    deps,
  );
}
