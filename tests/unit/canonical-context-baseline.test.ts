import { describe, it, expect } from 'vitest';
import { deriveCanonicalContexts } from '../../src/framework/canonical-context.js';
import type { TableDefinition } from '../../src/types.js';

/**
 * 3.3.4 regression: a cloud MEMBER joins with `entities: {}` (the render layout
 * lives only in the owner's config, which the cloud model never ships), so the
 * member rendered 0 files. The fix synthesizes a default context tree from the
 * tables the member introspects from the DB — using the SAME deriveCanonicalContexts
 * the owner uses. Those introspected tables have NO relations (relations are
 * config-only), so this pins that a relation-less table still yields a renderable
 * self-context (the per-row `<ENTITY>.md`), i.e. render produces files, not zero.
 */
describe('deriveCanonicalContexts — relation-less (introspected member) tables', () => {
  it('produces a self-context file for a table with no relations', () => {
    const def: TableDefinition = {
      columns: { id: 'TEXT', name: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'id',
      render: () => '',
      outputFile: 'projects/.lattice/projects.md',
    };
    const out = deriveCanonicalContexts([{ name: 'projects', definition: def }]);
    expect(out).toHaveLength(1);
    const ctx = out[0]!;
    expect(ctx.table).toBe('projects');
    // The per-row self context: PROJECT.md (singular-upper). This is what makes a
    // member's render write a file per row instead of nothing.
    expect(Object.keys(ctx.definition.files)).toContain('PROJECT.md');
    expect(ctx.definition.files['PROJECT.md']!.source.type).toBe('self');
    // A directory root is set so rows land under Context/Projects/<slug>/.
    expect(ctx.definition.directoryRoot).toBeTruthy();
  });

  it('still renders self-context for several relation-less tables', () => {
    const mk = (name: string): { name: string; definition: TableDefinition } => ({
      name,
      definition: {
        columns: { id: 'TEXT', title: 'TEXT' },
        primaryKey: 'id',
        render: () => '',
        outputFile: `${name}/.lattice/${name}.md`,
      },
    });
    const out = deriveCanonicalContexts([mk('meetings'), mk('messages')]);
    expect(out.map((o) => o.table).sort()).toEqual(['meetings', 'messages']);
    for (const ctx of out) {
      const selfFile = Object.values(ctx.definition.files).find((f) => f.source.type === 'self');
      expect(selfFile).toBeTruthy();
    }
  });
});
