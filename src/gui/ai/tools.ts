import { REGISTRY, getFunction, type LatticeFunctionDef, type ArgsSchema } from './registry.js';

/**
 * Transform the Lattice function registry into Anthropic tool definitions.
 *
 * The shape returned here is structurally compatible with the `tools` array
 * the Anthropic Messages API expects (`@anthropic-ai/sdk`'s `Tool`), so the
 * stage-2 chat loop can pass these straight through. Keeping the transform
 * dependency-free (a local interface, not an SDK import) means it stays pure
 * and unit-testable without pulling the SDK into this module's graph.
 */

/** Minimal mirror of the Anthropic Messages API tool shape. */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: ArgsSchema;
}

/** Convert one registry function into an Anthropic tool definition. */
export function toAnthropicTool(fn: LatticeFunctionDef): AnthropicTool {
  return {
    name: fn.name,
    description: fn.description,
    input_schema: fn.args,
  };
}

export interface ToolFilter {
  /** When false, omit mutating functions (read-only tool set). Default true. */
  includeMutations?: boolean;
}

/**
 * Build the Anthropic tool array from the registry. By default every function
 * is exposed; pass `{ includeMutations: false }` for a read-only session.
 */
export function buildAnthropicTools(filter: ToolFilter = {}): AnthropicTool[] {
  const includeMutations = filter.includeMutations ?? true;
  return REGISTRY.filter((fn) => includeMutations || !fn.mutates).map(toAnthropicTool);
}

/**
 * Resolve a tool name the model emitted back to its registry definition.
 * Returns undefined for names not in the registry (the caller should reject
 * the tool call rather than execute an unknown operation).
 */
export function resolveTool(name: string): LatticeFunctionDef | undefined {
  return getFunction(name);
}
