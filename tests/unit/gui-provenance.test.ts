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

// Eval the (string) provenance module and surface its pure helper. The other
// functions reference IIFE globals but are never called, so defining them is safe.
function loadPureHelpers(): {
  provenanceTableHtml: (p: unknown) => string;
} {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'escapeHtml',
    provenanceJs + '\nreturn { provenanceTableHtml: provenanceTableHtml };',
  );
  return factory(escapeHtmlStub) as {
    provenanceTableHtml: (p: unknown) => string;
  };
}

describe('client provenance module', () => {
  it('is composed into appJs / css (table-only object view)', () => {
    expect(appJs).toContain('function renderProvenance(');
    expect(appJs).toContain('function renderProvenancePanel(');
    expect(appJs).toContain('function provenanceTableHtml(');
    expect(appJs).toContain('/api/provenance');
    expect(css).toContain('details.prov-panel');
    expect(css).toContain('.pv-table');
    // The object page is a single table view now — the graph mode + its helpers
    // are gone.
    expect(appJs).not.toContain('function buildProvenanceModel(');
    expect(appJs).not.toContain('function renderProvenanceGraph(');
    expect(css).not.toContain('.pvnode-object');
  });

  it('removed the old create tile from the object-type view', () => {
    expect(appJs).not.toContain('fs-tile-create');
  });

  it('uses only the generic provenance tier vocabulary (no domain coupling)', () => {
    // The source-table tiers must be exactly the three generic tiers. Any other
    // pvchip-* class would mean a source dataset's vocabulary had leaked into the
    // GUI — this guards the "technique, not data" port from a private source.
    const cssTiers = new Set([...provenanceCss.matchAll(/pvchip-([a-z]+)/g)].map((m) => m[1]));
    expect([...cssTiers].sort()).toEqual(['computed', 'observation', 'raw']);
    for (const tier of ['raw', 'computed', 'observation']) {
      expect(provenanceJs).toContain("type: '" + tier + "'");
    }
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
