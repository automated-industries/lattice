import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readJson } from './http.js';
import type { GuiRequestContext } from './request-context.js';
import type { ActiveDb } from './active-db.js';
import { canManageRoles } from '../framework/cloud-connect.js';
import { denyIfNotCloudOwner } from './schema-routes.js';
import { applyPlanOp } from './planner/apply.js';
import { ensurePlan, applyDepsFor, invalidatePlanCache } from './planner/run.js';
import type { AppliedOp } from './planner/types.js';

/**
 * Data-model planner HTTP surface (`/api/data-model/*`) — the review + on-open
 * seam over the deterministic planner. A flat boolean-handled leaf in the
 * ordered dispatch registry (registered in server.ts next to the schema routes).
 * Synchronous: no LLM in the path, so no model-provider gate — the planner works
 * with no provider connected.
 *
 *  - GET  /plan     → run (or return the watermark-cached) plan: auto-applied
 *                     reversible fixes + pending proposals.
 *  - POST /apply    → apply one proposal `{ id }` or `{ all: true }` via the
 *                     audited primitives. Owner-gated; failures surface (Rule 16).
 *  - POST /dismiss  → hide a proposal `{ id }` so it is not re-surfaced.
 *
 * The AUTO tier only runs for a caller that can manage the schema (local, or a
 * cloud OWNER) — a scoped member reads the plan but does not auto-apply (its
 * writes are owner-gated). Mutating verbs 403 for a member via denyIfNotCloudOwner.
 */
export interface DataModelRoutesDeps {
  host: string;
}

/** Per-workspace dismissed proposal fingerprints. Process-local; a persisted
 *  `_lattice_plan_state` table (surviving restart) is a tracked follow-up. */
const dismissedByConfig = new Map<string, Set<string>>();
function dismissedFor(configPath: string): Set<string> {
  let s = dismissedByConfig.get(configPath);
  if (!s) {
    s = new Set();
    dismissedByConfig.set(configPath, s);
  }
  return s;
}

/** Whether this connection may apply schema/config changes (local or cloud owner). */
async function canApply(active: ActiveDb): Promise<boolean> {
  return active.db.getDialect() !== 'postgres' || (await canManageRoles(active.db));
}

export async function handleDataModelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GuiRequestContext,
  deps: DataModelRoutesDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${deps.host}`);
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/data-model')) return false;
  const method = req.method ?? 'GET';
  const active = ctx.active();
  const sessionId = ctx.sessionId;
  const dismissed = dismissedFor(active.configPath);

  if (method === 'GET' && pathname === '/api/data-model/plan') {
    const applyAuto = await canApply(active);
    const plan = await ensurePlan(active, { sessionId, dismissed, applyAuto });
    sendJson(res, plan);
    return true;
  }

  if (method === 'POST' && pathname === '/api/data-model/apply') {
    if (await denyIfNotCloudOwner(active.db, res, 'apply data-model changes')) return true;
    const body = await readJson<{ id?: unknown; all?: unknown }>(req);
    // Force a fresh plan so we apply against current state; detection only (the
    // AUTO tier already ran on the last GET).
    const plan = await ensurePlan(active, { sessionId, dismissed, force: true, applyAuto: false });
    const targets =
      body.all === true ? plan.proposals : plan.proposals.filter((p) => p.id === body.id);
    if (targets.length === 0) {
      sendJson(res, { error: 'no matching proposal' }, 404);
      return true;
    }
    const applyDeps = applyDepsFor(active, sessionId);
    const applied: AppliedOp[] = [];
    for (const op of targets) {
      try {
        applied.push(await applyPlanOp(op, applyDeps));
      } catch (e) {
        // Interactive action → surface the failure in the response (Rule 16),
        // never swallow it silently.
        applied.push({
          id: op.id,
          kind: op.kind,
          summary: op.rationale,
          ok: false,
          error: (e as Error).message,
        });
      }
    }
    invalidatePlanCache(active.configPath);
    sendJson(res, { applied });
    return true;
  }

  if (method === 'POST' && pathname === '/api/data-model/dismiss') {
    if (await denyIfNotCloudOwner(active.db, res, 'dismiss data-model proposals')) return true;
    const body = await readJson<{ id?: unknown }>(req);
    if (typeof body.id !== 'string') {
      sendJson(res, { error: 'id is required' }, 400);
      return true;
    }
    dismissed.add(body.id);
    invalidatePlanCache(active.configPath);
    sendJson(res, { ok: true });
    return true;
  }

  return false;
}
