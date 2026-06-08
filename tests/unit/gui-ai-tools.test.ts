import { describe, it, expect } from 'vitest';
import { buildAnthropicTools, toAnthropicTool, resolveTool } from '../../src/gui/ai/tools.js';
import { REGISTRY, getFunction, functionNames } from '../../src/gui/ai/registry.js';

describe('Anthropic tool transform', () => {
  it('maps a registry function to the Anthropic tool shape', () => {
    const fn = getFunction('create_row')!;
    const tool = toAnthropicTool(fn);
    expect(tool.name).toBe('create_row');
    expect(tool.description).toBe(fn.description);
    expect(tool.input_schema).toBe(fn.args);
    expect(tool.input_schema.type).toBe('object');
  });

  it('builds one tool per registry function by default', () => {
    const tools = buildAnthropicTools();
    expect(tools.length).toBe(REGISTRY.length);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it('every tool carries a valid input_schema', () => {
    for (const tool of buildAnthropicTools()) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('omits mutating functions in a read-only tool set', () => {
    const readOnly = buildAnthropicTools({ includeMutations: false });
    const names = new Set(readOnly.map((t) => t.name));
    expect(names.has('list_entities')).toBe(true);
    expect(names.has('create_row')).toBe(false);
    expect(names.has('delete_row')).toBe(false);
    expect(readOnly.length).toBeLessThan(REGISTRY.length);
  });

  it('resolves a known tool name and rejects an unknown one', () => {
    expect(resolveTool('update_row')?.name).toBe('update_row');
    expect(resolveTool('rm_rf_everything')).toBeUndefined();
  });

  it('every built tool name resolves back to the registry', () => {
    const names = new Set(functionNames());
    for (const tool of buildAnthropicTools()) {
      expect(names.has(tool.name)).toBe(true);
    }
  });
});
