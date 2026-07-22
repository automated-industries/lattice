/**
 * The introspective MCP connector — the always-works path.
 *
 * Point it at ANY reachable MCP server (a URL you supply, or a local stdio
 * command) and it pulls that server's readable items in as context without a
 * hand-authored schema: it introspects the server's tools (`tools/list`), calls
 * each no-argument read tool, and ALSO lists the server's advertised resources
 * (`resources/list` — its "available files"). Everything lands in one connected
 * `*_items` table (typed columns for kind/tool/server/title/summary + a JSON
 * `data` blob, FTS on title/summary, per-member `private` visibility — the same
 * connector-table conventions the sync engine expects).
 *
 * Two uses:
 *  - {@link genericConnector} — the built-in bring-your-own-URL connector; every
 *    added server is its own connection (one registry row per server).
 *  - {@link introspectiveConnector} — the same engine pre-pointed at a fixed
 *    endpoint with its own table name, for library consumers that embed a
 *    specific provider.
 *
 * Only read-shaped tools are called: tools that require arguments are skipped in
 * introspective mode, and obvious write tools are never called.
 */

import { createHash } from 'node:crypto';
import {
  McpConnectorBase,
  type McpModelBinding,
  type McpConnectorDeps,
} from '../mcp/connector-base.js';
import { mcpModel, str, jsonCol } from '../mcp/connected-model.js';
import { letterIcon } from '../mcp/icon.js';
import { getMcpServerUrl } from '../mcp/oauth.js';
import {
  getMcpSchemaDescriptor,
  setMcpSchemaDescriptor,
  getMcpConnectionContext,
  buildMcpModelDefs,
  kindFromTool,
  inferKind,
  connectionIdFromToolkit,
  lowerKeys,
  mcpTableName,
  type McpArgBinding,
  type McpKindDesc,
  type McpSchemaDescriptor,
} from '../mcp/schema-cache.js';
import { compileOutputSchema } from '../mcp/schema-compile.js';
import { requiredArgs, resolveArgBindings, MAX_ENUM_FANOUT } from '../mcp/arg-resolver.js';
import { reconcileMcpSchema } from '../mcp/schema-drift.js';
import type { McpToolInfo, McpTransport } from '../mcp/transport.js';
import type { Lattice } from '../../lattice.js';
import { slugify } from '../db-source/schema-cache.js';
import type {
  ConnectedModelDef,
  ExternalRecord,
  ListChangesContext,
  McpServerSpec,
  ToolkitPresentation,
} from '../types.js';

/** Field names a tool result may wrap its record array under. */
const WRAP_KEYS = ['items', 'results', 'data', 'records', 'value', 'entries'];

/**
 * The record array under one of {@link WRAP_KEYS} (or the result itself if it IS an array),
 * or `null` when NO recognized list field is present. Distinguishing "list field present but
 * empty" (→ `[]`) from "no list field" (→ `null`) matters: an empty wrapped result like
 * `{ items: [] }` (an empty account — a common state) must yield an empty list, NOT be treated
 * as a single envelope item, or introspection invents a phantom kind and every sync injects one
 * garbage envelope row.
 */
function listField(result: unknown): unknown[] | null {
  if (Array.isArray(result)) return result as unknown[];
  if (result && typeof result === 'object') {
    for (const k of WRAP_KEYS) {
      const v = (result as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as unknown[]; // present (even if empty) → an intentional list
    }
  }
  return null;
}

/** Pull the array of records out of a tool result (the array itself, wrapped, or — for a bare
 *  single object with no list field — a one-item envelope). */
function itemsOf(result: unknown): unknown[] {
  const list = listField(result);
  if (list) return list; // a list field was present (possibly empty) → use it as-is
  return result != null ? [result] : []; // a bare object → single-item envelope
}

/** A stable natural key for an item lacking an id field — a content hash namespaced by tool,
 *  so re-syncs upsert on unchanged content (and a changed item prunes + re-adds). */
function contentKey(tool: string, item: unknown): string {
  return (
    tool +
    ':' +
    createHash('sha1')
      .update(JSON.stringify(item ?? null))
      .digest('hex')
      .slice(0, 20)
  );
}

/** Map one raw item onto a typed row for its kind: scalar modeled columns + a `data` JSON
 *  overflow. Returns the ExternalRecord (id = the natural-key value or a content hash). For a
 *  per-parent kind, `parentKey` namespaces the id (`<parentKey>/<id>`) so two parents' identical
 *  ids don't collide within the one child table. */
function typedRecord(kind: McpKindDesc, item: unknown, parentKey?: string): ExternalRecord {
  const obj =
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : { value: item };
  // Read values through a case-folded view — modeled columns are lowercase (see lowerKeys).
  const lower = lowerKeys(obj);
  const row: Record<string, unknown> = {};
  for (const c of kind.columns) {
    const v = lower[c.name];
    if (v === null || v === undefined || typeof v === 'object') continue; // → `data` overflow
    // Write ONLY a value that matches the column's DECLARED spec. The spec is inferred from a
    // bounded sample at introspect time; an out-of-sample value of a different type (a float
    // in an INTEGER column, a string in a numeric column) would round/throw on Postgres and
    // diverge from SQLite affinity. A non-conforming value is dropped from the typed cell — it
    // is never lost, because the whole raw item is preserved in the `data` JSON overflow below.
    if (c.sqlSpec === 'TEXT') {
      if (typeof v === 'string') row[c.name] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') row[c.name] = String(v);
    } else if (c.sqlSpec === 'REAL') {
      if (typeof v === 'number') row[c.name] = v;
    } else if (typeof v === 'number' && Number.isInteger(v)) {
      row[c.name] = v; // INTEGER: only a true integer
    }
  }
  const dj = jsonCol(item);
  if (dj !== undefined) row.data = dj;
  const idVal = kind.naturalKey !== '_pk' ? str(lower[kind.naturalKey]) : undefined;
  const rawId = idVal ?? contentKey(kind.tool, item);
  return { id: parentKey !== undefined ? `${parentKey}/${rawId}` : rawId, row };
}

/**
 * Build the probe arguments to sample a parameterized tool's columns at introspect time: a
 * discovery-bound arg gets the FIRST sampled parent row's key; default/enum args get a static
 * value. Returns null when a required arg can't be filled without a live sync (a contractual
 * parent with no in-hand sample, or an operator-context arg) — the kind then starts minimal and
 * drift widens its columns after the first real sync.
 */
function buildProbeArgs(
  argBindings: McpArgBinding[],
  discoveryKinds: McpKindDesc[],
  sampleByKind: Map<string, unknown[]>,
): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  for (const b of argBindings) {
    if (b.via === 'discovery') {
      const sample = sampleByKind.get(b.sourceKind ?? '');
      const pd = discoveryKinds.find((d) => d.kind === b.sourceKind);
      if (!sample || sample.length === 0 || !pd) return null;
      const first = sample[0];
      const key =
        first && typeof first === 'object'
          ? str(lowerKeys(first as Record<string, unknown>)[pd.naturalKey])
          : undefined;
      if (key === undefined) return null;
      args[b.arg] = key;
    } else if (b.via === 'default' && b.value !== undefined) {
      args[b.arg] = b.value;
    } else if (b.via === 'enum' && b.values && b.values.length > 0) {
      args[b.arg] = b.values[0];
    } else if (b.via === 'context') {
      return null; // no live operator context at introspect time
    }
  }
  return args;
}

/**
 * The argument combinations to call a kind's tool with during sync. A discovery arg is filled from
 * the sync's `parentKey`; default/context args are static; each enum arg fans out (bounded cross
 * product, capped at {@link MAX_ENUM_FANOUT}). A plain no-arg kind yields a single empty call.
 */
function buildToolArgCombos(
  kind: McpKindDesc,
  parentKey: string | undefined,
  context: Record<string, string>,
): Record<string, unknown>[] {
  const base: Record<string, unknown> = {};
  const enumArgs: { arg: string; values: string[] }[] = [];
  for (const b of kind.argBindings ?? []) {
    if (b.via === 'discovery') {
      if (parentKey !== undefined) base[b.arg] = parentKey;
    } else if (b.via === 'default' && b.value !== undefined) {
      base[b.arg] = b.value;
    } else if (b.via === 'context' && b.contextKey) {
      const v = context[b.contextKey];
      if (v !== undefined) base[b.arg] = v;
    } else if (b.via === 'enum' && b.values && b.values.length > 0) {
      enumArgs.push({ arg: b.arg, values: b.values });
    }
  }
  if (enumArgs.length === 0) return [base];
  let combos: Record<string, unknown>[] = [base];
  for (const ea of enumArgs) {
    const next: Record<string, unknown>[] = [];
    for (const c of combos) {
      for (const v of ea.values) {
        if (next.length >= MAX_ENUM_FANOUT) break;
        next.push({ ...c, [ea.arg]: v });
      }
    }
    combos = next;
  }
  return combos.slice(0, MAX_ENUM_FANOUT);
}

/** Per-tool item cap, so a chatty server can't flood the local DB (bounded reads). */
const MAX_ITEMS_PER_TOOL = 500;

/** Drift gate: re-discover a server's schema at most this often (matches the connector staleness),
 *  so a reconcile runs on the stale/refresh cadence — not on every sync of a fresh connection. */
const RE_INTROSPECT_MS = 60 * 60 * 1000;

/** Tool-name fragments that mark a mutation — never called introspectively. */
const WRITE_HINTS = [
  'create',
  'update',
  'delete',
  'remove',
  'send',
  'add',
  'set',
  'edit',
  'write',
  'move',
  'archive',
  'label',
  'draft',
  'reply',
  'post',
];

function looksLikeWrite(tool: string): boolean {
  const t = tool.toLowerCase();
  return WRITE_HINTS.some((h) => t.includes(h));
}

/** Configuration for an introspective connector instance. */
export interface IntrospectiveSpec {
  /** Connector + toolkit id. */
  connector: string;
  /** Display label. */
  label: string;
  /** Badge letter + colour for the fallback icon. */
  iconLetter: string;
  iconColor: string;
  /** The connected table name (e.g. `'mcp_items'`, `'jira_items'`). */
  table: string;
  /** The MCP server(s). A branded connector sets a default url; generic leaves it blank. */
  servers: McpServerSpec[];
}

export class IntrospectiveMcpConnector extends McpConnectorBase {
  readonly connector: string;
  private readonly model: ConnectedModelDef;

  constructor(
    private readonly spec: IntrospectiveSpec,
    deps: McpConnectorDeps = {},
  ) {
    super(deps.transportFactory, deps.oauth);
    this.connector = spec.connector;
    this.model = mcpModel({
      connector: spec.connector,
      toolkit: spec.connector,
      table: spec.table,
      model: 'item',
      naturalKey: 'item_id',
      columns: {
        kind: 'TEXT',
        tool: 'TEXT',
        server: 'TEXT',
        title: 'TEXT',
        summary: 'TEXT',
        data: 'TEXT',
      },
      def: {
        description: `Items pulled from the ${spec.label} MCP server`,
        render: 'default-list',
        fts: { fields: ['title', 'summary'] },
      },
    });
  }

  toolkits(): string[] {
    return [this.spec.connector];
  }
  presentation(_toolkit: string): ToolkitPresentation {
    return { label: this.spec.label, icon: letterIcon(this.spec.iconLetter, this.spec.iconColor) };
  }
  models(toolkit: string): ConnectedModelDef[] {
    // A per-connection toolkit (`mcp:<id>`) with a persisted descriptor → the TYPED tables,
    // one per record kind. Without a descriptor (legacy / not-yet-introspected) → the single
    // flat `mcp_items` model, so existing connections keep working until migrated.
    const id = connectionIdFromToolkit(toolkit);
    if (id) {
      const descriptor = getMcpSchemaDescriptor(id);
      if (descriptor && descriptor.kinds.length > 0) return buildMcpModelDefs(id, descriptor);
    }
    return [this.model];
  }
  mcpServers(_toolkit: string): McpServerSpec[] {
    return this.spec.servers;
  }
  protected bindings(_toolkit: string): McpModelBinding[] {
    return []; // unused — listChanges is introspective / descriptor-routed
  }

  /**
   * Discover the server's record shapes and persist a typed schema descriptor: call each
   * non-write read tool once, infer a kind + typed columns from a sample, and store it under
   * the connection. `models()` then emits one typed table per kind. Best-effort — returns null
   * when the server exposes nothing modelable (the caller keeps the flat `mcp_items` fallback).
   * `prefix` namespaces the tables (the server brand, e.g. `justworks`).
   */
  async introspect(
    connectionId: string,
    toolkit: string,
    prefix: string,
  ): Promise<McpSchemaDescriptor | null> {
    const { transport, release } = await this.acquireTransport(toolkit, connectionId);
    try {
      const descriptor = await this.discoverWithTransport(transport, connectionId, prefix);
      if (descriptor) setMcpSchemaDescriptor(connectionId, descriptor);
      return descriptor;
    } finally {
      await release();
    }
  }

  /**
   * Discover a server's record shapes into a descriptor WITHOUT persisting — the shared core of
   * connect-time {@link introspect} and drift {@link reconcileModels}. Prefers a tool's declared
   * outputSchema (no call), samples arg-free tools otherwise, reaches arg-requiring tools two-phase,
   * and models the server's resources. Returns null when nothing is modelable.
   */
  private async discoverWithTransport(
    transport: McpTransport,
    connectionId: string,
    prefix: string,
  ): Promise<McpSchemaDescriptor | null> {
    const prefixSlug = slugify(prefix);
    const seenTables = new Set<string>();
    // Reserve a collision-free physical table name for a kept kind. De-collide on the FINAL
    // physical table name (mcpTableName re-slugifies + truncates), NOT the kind string — two
    // distinct long kinds can truncate to the same table, silently dropping the second's schema.
    const reserveName = (toolName: string): string => {
      let kindName = kindFromTool(toolName);
      if (seenTables.has(mcpTableName(prefixSlug, kindName))) {
        const h = createHash('sha1').update(toolName).digest('hex').slice(0, 6);
        kindName = slugify(kindName).slice(0, 33) + '_' + h;
      }
      seenTables.add(mcpTableName(prefixSlug, kindName));
      return kindName;
    };

    const readTools = (await transport.listTools()).filter((t) => !looksLikeWrite(t.name));
    const discoveryKinds: McpKindDesc[] = [];
    const parameterized: McpToolInfo[] = [];
    const sampleByKind = new Map<string, unknown[]>();

    // Pass 1 — arg-free DISCOVERY tools. Prefer a declared outputSchema (authoritative, no call,
    // correct for an empty account); else sample a bare call. A tool that requires args is
    // deferred to pass 2 rather than skipped (the old behavior lost every parameterized tool).
    for (const tool of readTools) {
      if (requiredArgs(tool.inputSchema).length > 0) {
        parameterized.push(tool);
        continue;
      }
      const contractual = compileOutputSchema('', tool.name, tool.outputSchema);
      if (contractual) {
        discoveryKinds.push({ ...contractual, kind: reserveName(tool.name) });
        continue;
      }
      let result: unknown;
      try {
        result = await transport.callTool({ tool: tool.name, args: {} });
      } catch {
        continue; // arg-free per schema but still rejected bare — nothing to model
      }
      const items = itemsOf(result).slice(0, MAX_ITEMS_PER_TOOL);
      if (items.length === 0) continue;
      const kindName = reserveName(tool.name);
      discoveryKinds.push(inferKind(kindName, tool.name, items));
      sampleByKind.set(kindName, items);
    }

    // Pass 2 — PARAMETERIZED read tools. Bind each required arg two-phase (against the discovery
    // kinds + operator context); columns come from an outputSchema or a single bounded probe
    // against a discovered parent key, else a minimal kind that drift widens after first sync.
    const parameterizedKinds: McpKindDesc[] = [];
    const unresolved: { tool: string; reason: string }[] = [];
    const contextKeys = new Set(Object.keys(getMcpConnectionContext(connectionId)));
    for (const tool of parameterized) {
      const { argBindings, parentKind } = resolveArgBindings(
        { kind: kindFromTool(tool.name), tool: tool.name, input: tool.inputSchema },
        discoveryKinds,
        contextKeys,
      );
      const bad = argBindings.filter((b) => b.via === 'unresolved');
      if (bad.length > 0) {
        for (const b of bad) {
          unresolved.push({ tool: tool.name, reason: b.reason ?? `unresolved arg "${b.arg}"` });
        }
        continue; // can't call it — recorded (surfaced), not silently dropped
      }
      const kindName = reserveName(tool.name);
      let kind = compileOutputSchema(kindName, tool.name, tool.outputSchema);
      if (!kind) {
        const probeArgs = buildProbeArgs(argBindings, discoveryKinds, sampleByKind);
        if (probeArgs) {
          try {
            const r = await transport.callTool({ tool: tool.name, args: probeArgs });
            const items = itemsOf(r).slice(0, MAX_ITEMS_PER_TOOL);
            if (items.length > 0) kind = inferKind(kindName, tool.name, items);
          } catch {
            /* probe failed — fall through to a minimal kind (drift widens later) */
          }
        }
      }
      kind ??= { kind: kindName, tool: tool.name, naturalKey: '_pk', columns: [] };
      kind.argBindings = argBindings;
      if (parentKind) kind.parentKind = parentKind;
      kind.origin = 'tool';
      kind.provenance ??= 'provisional';
      parameterizedKinds.push(kind);
    }

    // Resources — the server's advertised "available files" (`resources/list`) as a typed table
    // keyed by uri. Metadata-only for now (body sampling via `readResource` is a later increment).
    let resourcesKind: McpKindDesc | undefined;
    const resources = await transport.listResources();
    if (resources.length > 0) {
      const sampled = inferKind('resources', '', resources as unknown[]);
      resourcesKind = {
        kind: reserveName('resources'),
        tool: '',
        origin: 'resources',
        provenance: 'provisional',
        naturalKey: 'uri',
        columns: sampled.columns.filter((c) => c.name !== 'uri'),
      };
    }

    // Order matters: discovery (parent) kinds first, then their parameterized children, then
    // resources — the sync engine defines + syncs in array order, and a parent must populate
    // before its children iterate its keys.
    const kinds = [
      ...discoveryKinds,
      ...parameterizedKinds,
      ...(resourcesKind ? [resourcesKind] : []),
    ];
    if (kinds.length === 0) return null;
    const descriptor: McpSchemaDescriptor = {
      version: 2,
      prefix: prefixSlug,
      kinds,
      ...(unresolved.length ? { unresolved } : {}),
      introspectedAt: new Date().toISOString(),
    };
    return descriptor;
  }

  /**
   * Drift adaptation: re-discover the live server and additively migrate this connection's tables
   * (new kinds/columns added, a vanished kind frozen — never dropped). Called by the sync engine
   * before each sync; self-gated to the stale/refresh cadence so a just-connected connection isn't
   * re-introspected on its first sync. Reuses the sync session's transport.
   */
  async reconcileModels(db: Lattice, connectionId: string, toolkit: string): Promise<void> {
    const prev = getMcpSchemaDescriptor(connectionId);
    if (!prev || prev.kinds.length === 0) return; // nothing persisted — connect-time introspect owns it
    const last = prev.introspectedAt ? Date.parse(prev.introspectedAt) : 0;
    if (Number.isFinite(last) && Date.now() - last < RE_INTROSPECT_MS) return; // recently discovered
    const { transport, release } = await this.acquireTransport(toolkit, connectionId);
    let next: McpSchemaDescriptor | null;
    try {
      next = await this.discoverWithTransport(transport, connectionId, prev.prefix);
    } finally {
      await release();
    }
    if (!next) return; // the server temporarily exposes nothing modelable — never destroy on drift
    await reconcileMcpSchema(db, this, connectionId, toolkit, prev, next);
  }

  override async *listChanges(
    toolkit: string,
    model: string,
    ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    const id = connectionIdFromToolkit(toolkit);
    const descriptor = id ? getMcpSchemaDescriptor(id) : null;
    if (descriptor && descriptor.kinds.length > 0) {
      // Typed routing: this model IS a record kind — call ITS tool and map to typed rows.
      const kind = descriptor.kinds.find((k) => k.kind === model);
      // A retired kind (vanished from the live server) is frozen: yield nothing so the never-prune-
      // to-zero guard keeps its existing rows instead of soft-deleting them.
      if (!kind || kind.retired) return;
      const t = await this.openServerTransport(toolkit, ctx.connectionId);
      try {
        if (kind.origin === 'resources') {
          // The server's advertised resources as typed rows (keyed by uri; no parent).
          let n = 0;
          for (const r of await t.listResources()) {
            if (n >= MAX_ITEMS_PER_TOOL) break;
            n++;
            yield typedRecord(kind, r as unknown);
          }
          return;
        }
        // A parameterized kind fans out per parent (sync calls this once per `parentKey`); enum
        // args fan out within the call. A plain kind yields a single empty-arg call as before.
        const context = getMcpConnectionContext(ctx.connectionId);
        const combos = buildToolArgCombos(kind, ctx.parentKey, context);
        let n = 0;
        for (const args of combos) {
          if (n >= MAX_ITEMS_PER_TOOL) break;
          const result = await t.callTool({ tool: kind.tool, args });
          for (const item of itemsOf(result)) {
            if (n >= MAX_ITEMS_PER_TOOL) break;
            n++;
            yield typedRecord(kind, item, ctx.parentKey);
          }
        }
      } finally {
        await t.close();
      }
      return;
    }

    // Legacy flat path: everything into one `mcp_items` table (model === 'item').
    if (model !== 'item') return;
    const transport = await this.openServerTransport(toolkit, ctx.connectionId);
    // The server hostname rides every row so items from different connected
    // servers stay tellable-apart in the shared table.
    let serverHost: string | undefined;
    try {
      serverHost = new URL(getMcpServerUrl(ctx.connectionId) ?? '').hostname || undefined;
    } catch {
      /* stdio / no stored URL — leave unset */
    }
    try {
      const tools = await transport.listTools();
      for (const tool of tools) {
        if (looksLikeWrite(tool.name)) continue;
        let result: unknown;
        try {
          result = await transport.callTool({ tool: tool.name, args: {} });
        } catch {
          continue; // needs arguments / not callable bare — skip in introspective mode
        }
        const list = itemsOf(result);
        let i = 0;
        for (const it of list) {
          if (i >= MAX_ITEMS_PER_TOOL) break;
          i++;
          const obj =
            it && typeof it === 'object' ? (it as Record<string, unknown>) : { value: it };
          const idPart = str(obj.id) ?? str(obj.key) ?? str(obj.uid) ?? str(obj.name) ?? String(i);
          const row: Record<string, unknown> = {
            kind: 'item',
            tool: tool.name,
            // idPart is always a string (falls back to the index), so title is too.
            title:
              str(obj.title) ?? str(obj.name) ?? str(obj.subject) ?? str(obj.summary) ?? idPart,
          };
          if (serverHost !== undefined) row.server = serverHost;
          const summary = str(obj.description) ?? str(obj.snippet) ?? str(obj.summary);
          if (summary !== undefined) row.summary = summary;
          const data = jsonCol(it);
          if (data !== undefined) row.data = data;
          yield { id: `${tool.name}:${idPart}`, row };
        }
      }
      // The server's advertised resources — its "available files" — via the
      // standard resources/list. Servers without the capability yield [].
      for (const r of await transport.listResources()) {
        const row: Record<string, unknown> = {
          kind: 'resource',
          title: r.name,
        };
        if (serverHost !== undefined) row.server = serverHost;
        if (r.description !== undefined) row.summary = r.description;
        const data = jsonCol({ uri: r.uri, ...(r.mimeType ? { mimeType: r.mimeType } : {}) });
        if (data !== undefined) row.data = data;
        yield { id: `resource:${r.uri}`, row };
      }
    } finally {
      await transport.close();
    }
  }
}

/** Build an introspective connector for a specific provider (branded, pre-pointed). */
export function introspectiveConnector(
  spec: IntrospectiveSpec,
  deps: McpConnectorDeps = {},
): IntrospectiveMcpConnector {
  return new IntrospectiveMcpConnector(spec, deps);
}

/** The generic MCP connector — point it at any reachable MCP server (no default url). */
export function genericConnector(deps: McpConnectorDeps = {}): IntrospectiveMcpConnector {
  return introspectiveConnector(
    {
      connector: 'mcp',
      label: 'MCP server',
      iconLetter: '+',
      iconColor: '#6b7280',
      table: 'mcp_items',
      // No pinned transport: the kind is inferred from the user-supplied URL
      // (an `/sse` suffix selects the legacy SSE transport).
      servers: [{ name: 'generic', oauth: true }],
    },
    deps,
  );
}
