/**
 * The Composio connector — a {@link Connector} implementation that fetches and
 * authorizes via Composio, generic over per-toolkit {@link ToolkitSpec}s.
 *
 * A toolkit (e.g. `jira`) registers a spec describing its connected models and,
 * per model, the Composio action to call, how to page it, and how to map the raw
 * result into normalized {@link ExternalRecord}s. The connector itself contains
 * no per-product knowledge — it just drives the spec, so adding Gmail/Slack/Zoom
 * later is a new spec, not new connector code.
 */

import type {
  Connector,
  ConnectedModelDef,
  ExternalRecord,
  AuthorizeResult,
  ConnectionResult,
  ListChangesContext,
} from '../types.js';
import { loadComposioClient } from './client.js';
import type { ComposioClient } from './client.js';

/** How to fetch + map one model's records via a Composio action. */
export interface ModelFetchSpec {
  /** The Composio action/tool slug, e.g. `'JIRA_SEARCH_FOR_ISSUES_USING_JQL'`. */
  action: string;
  /**
   * Build the action arguments for a page given the prior cursor (null = first)
   * and, for a per-parent model, the current parent row key.
   */
  args(cursor: string | null, parentKey?: string): Record<string, unknown>;
  /** Map the action's raw `data` into records + the next cursor (null = last page). */
  map(data: unknown): { records: ExternalRecord[]; nextCursor: string | null };
}

/** A toolkit's connected models plus their per-model fetch specs. */
export interface ToolkitSpec {
  /** Toolkit id, e.g. `'jira'`. */
  toolkit: string;
  /** The connected-data-type models this toolkit exposes. */
  models: ConnectedModelDef[];
  /** Fetch spec per model key. */
  fetch: Record<string, ModelFetchSpec>;
}

const REGISTRY = new Map<string, ToolkitSpec>();

/** Register a toolkit spec so the Composio connector can serve it. */
export function registerToolkit(spec: ToolkitSpec): void {
  REGISTRY.set(spec.toolkit, spec);
}

/** All registered toolkit ids. */
export function registeredToolkits(): string[] {
  return [...REGISTRY.keys()];
}

/** Look up a registered toolkit spec. */
export function getToolkitSpec(toolkit: string): ToolkitSpec | undefined {
  return REGISTRY.get(toolkit);
}

/** Hard cap on pages per model sync — a backstop against an unbounded fetch loop. */
const MAX_PAGES = 1000;

export class ComposioConnector implements Connector {
  readonly connector = 'composio';

  /**
   * @param clientFactory builds the {@link ComposioClient}. Defaults to the lazy
   * loader (optional dep + machine-local API key); tests inject a fake.
   */
  constructor(private readonly clientFactory: () => Promise<ComposioClient> = loadComposioClient) {}

  toolkits(): string[] {
    return registeredToolkits();
  }

  models(toolkit: string): ConnectedModelDef[] {
    const spec = REGISTRY.get(toolkit);
    if (!spec) throw new Error(`Unknown toolkit "${toolkit}" — no connector spec registered.`);
    return spec.models;
  }

  async authorize(userId: string, toolkit: string): Promise<AuthorizeResult> {
    const client = await this.clientFactory();
    return client.authorize(userId, toolkit);
  }

  async completeAuth(userId: string, toolkit: string): Promise<ConnectionResult> {
    const client = await this.clientFactory();
    const { connectionId } = await client.finalize(userId, toolkit);
    return { connectionId };
  }

  async *listChanges(
    toolkit: string,
    model: string,
    ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    const spec = REGISTRY.get(toolkit);
    if (!spec) throw new Error(`Unknown toolkit "${toolkit}" — no connector spec registered.`);
    const fetchSpec = spec.fetch[model];
    if (!fetchSpec) throw new Error(`Toolkit "${toolkit}" has no fetch spec for model "${model}".`);

    const client = await this.clientFactory();
    let cursor = ctx.cursor ?? null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.execute(fetchSpec.action, {
        userId: ctx.userId,
        connectionId: ctx.connectionId,
        arguments: fetchSpec.args(cursor, ctx.parentKey),
      });
      // Fail loudly — a connector fetch is an external operation; never swallow it.
      if (!res.successful) {
        throw new Error(
          `Composio action "${fetchSpec.action}" failed for ${toolkit}/${model}: ${res.error ?? 'unknown error'}`,
        );
      }
      const { records, nextCursor } = fetchSpec.map(res.data);
      for (const record of records) yield record;
      if (!nextCursor) return;
      cursor = nextCursor;
    }
    throw new Error(
      `Composio fetch for ${toolkit}/${model} exceeded ${MAX_PAGES} pages — aborting to avoid an unbounded loop.`,
    );
  }

  async disconnect(connectionId: string): Promise<void> {
    const client = await this.clientFactory();
    await client.revoke(connectionId);
  }
}
