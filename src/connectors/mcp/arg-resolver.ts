/**
 * Two-phase argument resolution — the generic-engine answer to arg-requiring read tools.
 *
 * The introspective connector only samples NO-ARGUMENT tools, so a server whose useful reads need
 * an argument (Atlassian `searchJiraIssuesUsingJql({ cloudId, jql })`, a Slack history tool needing
 * a `channel`) yields nothing. The MCP spec offers no way to enumerate an open-domain required arg's
 * valid values (the completion API covers only prompt/resource refs, not tool args). The robust
 * pattern is TWO-PHASE: call the arg-free DISCOVERY tools first, harvest their returned ids, then
 * parameterize each dependent tool once per discovered id — a data-driven dependency over tools.
 *
 * This module resolves, per required arg, HOW its value is supplied (enum / default / a discovery
 * kind's rows / operator-supplied context / unresolved) and whether the tool becomes a single-level
 * per-parent kind. It is pure + deterministic; `buildMcpModelDefs` turns a `parentKind` into the
 * existing `ConnectedModelDef.parent` fan-out so the sync engine needs no change.
 */

import type { JsonSchemaLike } from './schema-compile.js';
import type { McpArgBinding, McpKindDesc } from './schema-cache.js';

/** Cap on how many values an `enum`-bound arg may fan out over (a bounded static loop). */
export const MAX_ENUM_FANOUT = 25;

/** Entity-token aliases: a parent-id arg (`cloudId`) matches a discovery kind whose slug or natural
 *  key carries the token or one of its aliases. Kept small + explicit to avoid loose false binds. */
const ENTITY_ALIASES: Record<string, string[]> = {
  cloud: ['cloud', 'site', 'resource', 'tenant'],
  workspace: ['workspace', 'team', 'org', 'organization'],
  channel: ['channel', 'conversation'],
  space: ['space'],
  project: ['project'],
  board: ['board'],
  repo: ['repo', 'repository'],
  account: ['account'],
  user: ['user', 'member'],
};

/** The required arguments of a tool (name + schema), from `inputSchema.required[]`. */
export function requiredArgs(
  input: JsonSchemaLike | undefined,
): { name: string; schema: JsonSchemaLike }[] {
  if (!input || typeof input !== 'object' || !Array.isArray(input.required)) return [];
  const props = input.properties ?? {};
  return input.required.map((name) => ({ name, schema: props[name] ?? {} }));
}

/**
 * Canonical entity token for a parent-id arg name: strip a trailing `id`/`_id`, lowercase, and
 * expand to its alias set. `cloudId` → `{ token: 'cloud', aliases: ['cloud','site','resource',…] }`.
 * Returns null for a name that isn't id-shaped (no `id` suffix) or normalizes to empty.
 */
export function argEntityToken(argName: string): { token: string; aliases: string[] } | null {
  const lower = argName.toLowerCase();
  if (!lower.endsWith('id')) return null;
  const token = lower.replace(/_?id$/, '');
  if (!token) return null;
  return { token, aliases: ENTITY_ALIASES[token] ?? [token] };
}

/** Bounded enum values of a schema (string-coerced), or null when there is no usable enum. */
function enumValues(s: JsonSchemaLike): string[] | null {
  if (!Array.isArray(s.enum) || s.enum.length === 0) return null;
  const vals = s.enum.filter((v) => v !== null && v !== undefined).map(String);
  return vals.length ? vals : null;
}

/** A scalar default coercible to a static arg value, or null. */
function defaultValue(s: JsonSchemaLike): string | null {
  const d = s.default;
  if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') return String(d);
  return null;
}

/** Find a discovery kind whose slug or natural key matches the arg's entity token/aliases. */
function matchDiscovery(
  argName: string,
  discoveryKinds: McpKindDesc[],
): { kind: string; field: string } | null {
  const tok = argEntityToken(argName);
  if (!tok) return null;
  const wanted = new Set([tok.token, ...tok.aliases]);
  for (const d of discoveryKinds) {
    const kindWords = d.kind
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const nkNorm = d.naturalKey.toLowerCase().replace(/_?id$/, '');
    const wordHit = kindWords.some(
      (w) => wanted.has(w) || [...wanted].some((a) => a.length >= 4 && w.includes(a)),
    );
    const keyHit = nkNorm.length > 0 && wanted.has(nkNorm);
    if (wordHit || keyHit) return { kind: d.kind, field: d.naturalKey };
  }
  return null;
}

/**
 * Resolve the required args of a parameterized read tool against the arg-free discovery kinds.
 * Per arg, resolution order: `enum` (≤ {@link MAX_ENUM_FANOUT}) → `default` → discovery match →
 * operator `context` → `unresolved`. Returns the bindings and, when EXACTLY ONE arg binds to a
 * discovery kind, that `parentKind` (single-level fan-out). Two-or-more discovery args are demoted
 * to `unresolved` (`multi-parent`) so no combinatorial cross-product crawl is ever emitted.
 */
export function resolveArgBindings(
  parameterized: { kind: string; tool: string; input: JsonSchemaLike | undefined },
  discoveryKinds: McpKindDesc[],
  context?: ReadonlySet<string>,
): { argBindings: McpArgBinding[]; parentKind?: string } {
  const bindings: McpArgBinding[] = [];
  const discoveryParents: string[] = [];

  for (const { name, schema } of requiredArgs(parameterized.input)) {
    const en = enumValues(schema);
    if (en && en.length <= MAX_ENUM_FANOUT) {
      bindings.push({ arg: name, via: 'enum', values: en });
      continue;
    }
    const def = defaultValue(schema);
    if (def !== null) {
      bindings.push({ arg: name, via: 'default', value: def });
      continue;
    }
    const match = matchDiscovery(name, discoveryKinds);
    if (match) {
      bindings.push({
        arg: name,
        via: 'discovery',
        sourceKind: match.kind,
        sourceField: match.field,
      });
      discoveryParents.push(match.kind);
      continue;
    }
    if (context?.has(name)) {
      bindings.push({ arg: name, via: 'context', contextKey: name });
      continue;
    }
    bindings.push({
      arg: name,
      via: 'unresolved',
      reason: `no discovery kind supplies "${name}" and no operator context is set`,
    });
  }

  const uniqueParents = [...new Set(discoveryParents)];
  if (uniqueParents.length > 1) {
    // A cross-product of two discovered id sets would crawl unboundedly — refuse to fan out.
    for (const b of bindings) {
      if (b.via === 'discovery') {
        b.via = 'unresolved';
        b.reason = 'multi-parent (2+ discovery args) — cross-product fan-out avoided';
        delete b.sourceKind;
        delete b.sourceField;
      }
    }
    return { argBindings: bindings };
  }
  const parent = uniqueParents[0];
  return parent !== undefined
    ? { argBindings: bindings, parentKind: parent }
    : { argBindings: bindings };
}
