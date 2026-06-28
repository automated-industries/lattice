import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/modules/index.js';
import { css } from '../../src/gui/app/styles/index.js';
import { provenanceJs } from '../../src/gui/app/modules/provenance.js';
import { provenanceCss } from '../../src/gui/app/styles/provenance.js';

/**
 * Client provenance module: present in the composed bundle, free of any imported
 * domain vocabulary, and with correctly-behaving pure helpers.
 */

function escapeHtmlStub(s: unknown): string {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

// Eval the (string) provenance module and surface its pure helpers. The other
// functions reference IIFE globals but are never called, so defining them is safe.
function loadPureHelpers(): {
  buildProvenanceModel: (p: unknown) => { nodes: unknown[]; edges: unknown[] };
  provenanceTableHtml: (p: unknown) => string;
} {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'escapeHtml',
    provenanceJs +
      '\nreturn { buildProvenanceModel: buildProvenanceModel, provenanceTableHtml: provenanceTableHtml };',
  );
  return factory(escapeHtmlStub) as {
    buildProvenanceModel: (p: unknown) => { nodes: unknown[]; edges: unknown[] };
    provenanceTableHtml: (p: unknown) => string;
  };
}

describe('client provenance module', () => {
  it('is composed into appJs / css', () => {
    expect(appJs).toContain('function renderProvenance(');
    expect(appJs).toContain('function renderProvenancePanel(');
    expect(appJs).toContain('function buildProvenanceModel(');
    expect(appJs).toContain('function provenanceTableHtml(');
    expect(appJs).toContain('/api/provenance');
    expect(appJs).toContain('createForceGraph');
    expect(css).toContain('.pvnode-object');
    expect(css).toContain('details.prov-panel');
    expect(css).toContain('.pv-table');
  });

  it('removed the old create tile from the object-type view', () => {
    expect(appJs).not.toContain('fs-tile-create');
  });

  it('uses only the generic provenance tier vocabulary (no domain coupling)', () => {
    // The tier node classes must be exactly the four generic tiers. Any other
    // pvnode-* class would mean a source dataset's vocabulary had leaked into the
    // GUI — this guards the "technique, not data" port from a private source.
    const cssTiers = new Set([...provenanceCss.matchAll(/pvnode-([a-z]+)/g)].map((m) => m[1]));
    expect([...cssTiers].sort()).toEqual(['computed', 'object', 'observation', 'raw']);
    // The JS tier metadata declares exactly the same four tiers, nothing else.
    for (const tier of ['object', 'raw', 'computed', 'observation']) {
      expect(provenanceJs).toContain(tier + ':');
    }
  });

  it('buildProvenanceModel maps tiers to radius/class and drops dangling edges', () => {
    const { buildProvenanceModel } = loadPureHelpers();
    const model = buildProvenanceModel({
      nodes: [
        { id: 'table:t', label: 't', type: 'object', kind: 'table' },
        { id: 'r1', label: 'File', type: 'raw', kind: 'file', count: 3 },
        { id: 'o1', label: 'AI', type: 'observation', kind: 'observation', count: 1 },
      ],
      edges: [
        { source: 'r1', target: 'table:t', relation: 'extracted_from' },
        { source: 'o1', target: 'table:t', relation: 'observed_by' },
        { source: 'ghost', target: 'table:t', relation: 'x' }, // dangling → dropped
      ],
    });
    expect(model.nodes).toHaveLength(3);
    const obj = model.nodes.find((n) => (n as { id: string }).id === 'table:t') as {
      radius: number;
      cls: string;
    };
    expect(obj.cls).toBe('pvnode-object');
    expect(obj.radius).toBe(26);
    const raw = model.nodes.find((n) => (n as { id: string }).id === 'r1') as { cls: string };
    expect(raw.cls).toBe('pvnode-raw');
    expect(model.edges).toHaveLength(2); // the ghost edge is pruned
  });

  it('provenanceTableHtml groups sources by tier and renders chips + counts', () => {
    const { provenanceTableHtml } = loadPureHelpers();
    const html = provenanceTableHtml({
      nodes: [
        { id: 'table:t', label: 't', type: 'object', kind: 'table' },
        { id: 'r1', label: 'Acme', type: 'raw', kind: 'connector', count: 4 },
      ],
      edges: [{ source: 'r1', target: 'table:t', relation: 'synced_from' }],
    });
    expect(html).toContain('Raw sources');
    expect(html).toContain('pvchip-raw');
    expect(html).toContain('Acme');
    expect(html).toContain('synced from'); // underscores humanized
    expect(html).toContain('4');
  });

  it('provenanceTableHtml shows an empty state when there are no sources', () => {
    const { provenanceTableHtml } = loadPureHelpers();
    const html = provenanceTableHtml({ nodes: [{ id: 'table:t', type: 'object' }], edges: [] });
    expect(html).toContain('No sources recorded yet');
  });
});
