/**
 * Dashboard auto-repair: when the data model changes in a way that can break
 * an authored dashboard page (a table/column rename, a delete, a merge), every
 * dashboard that READS the affected tables is re-authored against the current
 * schema — automatically, in the background. The user sees the repair (each
 * rewrite lands as an ordinary "Updated <dashboard>" activity card, and an
 * open dashboard live-reloads through the same soft-refresh path as any data
 * change) but never has to do anything.
 *
 * Like meta-gen, this module resolves the model client itself and is imported
 * only by the ActiveDb-building site (lifecycle) — never by `ai/dispatch` —
 * so the dispatcher's module graph stays acyclic. It registers through the
 * mutation layer's schema-change listener (a WeakMap, not an import), which
 * fires for BOTH assistant tool calls and GUI schema edits: they share the
 * same audit chokepoint.
 *
 * Failure posture: a repair that cannot run (no model configured, author
 * error, write conflict) is warned loudly and SKIPPED — the dashboard keeps
 * its previous page, whose reads degrade gracefully in the sandboxed frame.
 * Never fatal, never silent, never destructive.
 */
import type { Lattice } from '../lattice.js';
import type { FeedBus } from './feed.js';
import { updateRow, setSchemaChangeListener, type SchemaChangeEvent } from './mutations.js';
import { extractSourceTables } from './dashboard-row.js';
import { resolveClaudeAuth } from './assistant-routes.js';
import { createAnthropicClient, buildSchemaContext } from './ai/chat.js';
import type { DispatchCtx } from './ai/dispatch.js';
import { generateHtmlFile, htmlAuthorModelForAuth } from './ai/html-author.js';

/** Re-authors one page against the current model; injectable for tests. */
export type DashboardAuthor = (instruction: string, currentHtml: string) => Promise<string>;

export interface DashboardRepairDeps {
  db: Lattice;
  feed: FeedBus;
  /** Live user-facing table names (feeds the author's schema context). */
  validTables: () => ReadonlySet<string>;
  /** Test seam — production resolves the real model client per flush. */
  author?: DashboardAuthor;
  /** Debounce window; a merge emits several ops that repair as ONE pass. */
  debounceMs?: number;
}

export interface DashboardRepairHandle {
  /** The listener registered with the mutation layer (exposed for tests). */
  onSchemaChange: (ev: SchemaChangeEvent) => void;
  /** Await the in-flight/pending repair pass (tests; idle = resolved). */
  settled: () => Promise<void>;
  /** Unregister + drop pending work (workspace dispose). */
  dispose: () => void;
}

/** A table name that may appear in a change event's before/after payloads. */
function namesFrom(ev: SchemaChangeEvent): string[] {
  const out = new Set<string>([ev.table]);
  for (const side of [ev.before, ev.after]) {
    if (side && typeof side === 'object') {
      const o = side as Record<string, unknown>;
      for (const k of ['table', 'name', 'from', 'to', 'renamed_from', 'renamed_to']) {
        if (typeof o[k] === 'string' && o[k]) out.add(o[k] as string);
      }
    }
  }
  return [...out];
}

export function createDashboardRepair(deps: DashboardRepairDeps): DashboardRepairHandle {
  const debounceMs = deps.debounceMs ?? 2500;
  let pending: SchemaChangeEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let disposed = false;

  async function resolveAuthor(): Promise<DashboardAuthor | null> {
    if (deps.author) return deps.author;
    try {
      const auth = await resolveClaudeAuth(deps.db);
      if (!auth) return null;
      const client = createAnthropicClient(auth);
      const model = htmlAuthorModelForAuth(auth);
      const ctx = { db: deps.db, validTables: deps.validTables() } as unknown as DispatchCtx;
      return async (instruction, currentHtml) => {
        const schema = await buildSchemaContext(ctx);
        return generateHtmlFile({ client, schema, spec: instruction, model, currentHtml });
      };
    } catch {
      return null;
    }
  }

  async function flush(): Promise<void> {
    const batch = pending;
    pending = [];
    if (batch.length === 0 || disposed) return;

    const changed = new Set(batch.flatMap(namesFrom));
    const rows = (await deps.db.query('dashboards', {
      filters: [{ col: 'deleted_at', op: 'isNull' }],
    })) as {
      id: string;
      title?: string;
      html?: string;
      source_tables?: string | null;
    }[];
    const affected = rows.filter((r) => {
      if (typeof r.html !== 'string' || r.html.length === 0) return false;
      if (typeof r.source_tables !== 'string' || !r.source_tables) return false;
      try {
        const sources = JSON.parse(r.source_tables) as unknown;
        return Array.isArray(sources) && sources.some((t) => changed.has(String(t)));
      } catch {
        return false;
      }
    });
    if (affected.length === 0) return;

    const author = await resolveAuthor();
    if (!author) {
      console.warn(
        `[lattice] the data model changed but ${affected.length} dashboard(s) could not be auto-updated (no assistant model configured) — they may need a manual edit`,
      );
      return;
    }

    const changeSummary = batch.map((ev) => ev.summary).join('; ');
    const instruction =
      `The workspace's data model just changed: ${changeSummary}. ` +
      'Update this page so every data read works against the CURRENT schema — fix any renamed or removed ' +
      'object/field references (the schema below is authoritative), drop reads of things that no longer ' +
      'exist, and keep the layout, charts, and intent of the page unchanged. Continue to read all data live.';

    for (const dash of affected) {
      if (disposed) return;
      try {
        const html = await author(instruction, String(dash.html));
        const sources = extractSourceTables(html);
        await updateRow(
          {
            db: deps.db,
            feed: deps.feed,
            source: 'ai',
            softDeletable: new Set(['dashboards']),
            allowReservedFileCols: true,
          },
          'dashboards',
          dash.id,
          { html, source_tables: sources ? JSON.stringify(sources) : null },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[lattice] dashboard "${dash.title ?? dash.id}" could not be auto-updated after a model change (kept its previous page): ${msg}`,
        );
      }
    }
  }

  function onSchemaChange(ev: SchemaChangeEvent): void {
    if (disposed) return;
    pending.push(ev);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      inFlight = inFlight.then(() => flush());
    }, debounceMs);
  }

  return {
    onSchemaChange,
    settled: async () => {
      // Two rounds: a timer may arm a flush while the first in-flight settles.
      await inFlight;
      await inFlight;
    },
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      pending = [];
      setSchemaChangeListener(deps.db, null);
    },
  };
}

/** Wire the repair service to a just-opened workspace (owner/local opens). */
export function installDashboardRepair(deps: DashboardRepairDeps): DashboardRepairHandle {
  const handle = createDashboardRepair(deps);
  setSchemaChangeListener(deps.db, handle.onSchemaChange);
  return handle;
}
