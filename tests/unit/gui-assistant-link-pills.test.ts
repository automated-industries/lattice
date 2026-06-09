import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * The assistant can link to a specific object inline by emitting
 * `[label](lattice://<table>/<id>)`, which the rail renders as a clickable
 * `lattice-ref` pill (wired to the mode-aware navigator). This test pulls the
 * SHIPPED client function out of the inlined GUI script and runs it, so it
 * catches emit-time bugs the string-only checks can't — e.g. the regression
 * where the placeholder-swap regex was double-escaped by the template literal
 * (`new RegExp('(\\d+)')` → a literal `d`), which silently dropped the pill and
 * left a bare index ("0") in the bubble.
 */

/** Extract a top-level `function <name>(…) {…}` body from the inlined script. */
function extractFn(src: string, name: string, last = false): string {
  const i = last
    ? src.lastIndexOf('function ' + name + '(')
    : src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function not found in client script: ' + name);
  let depth = 0;
  let k = src.indexOf('{', i);
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) {
        k++;
        break;
      }
    }
  }
  return src.slice(i, k);
}

// The bubble renderer + its deps (the active, last-defined mdToHtml) evaluated
// from the actual shipped script.
const code = [
  extractFn(guiAppHtml, 'escapeHtml'),
  extractFn(guiAppHtml, 'mdToHtml', true),
  extractFn(guiAppHtml, 'renderAssistantHtml'),
].join('\n');
const renderAssistantHtml = runInNewContext(
  code + '\nrenderAssistantHtml;',
  {},
  {
    filename: 'gui-client-script.js',
  },
) as (t: string) => string;

describe('assistant inline object-link pills', () => {
  it('renders [label](lattice://table/id) as a clickable lattice-ref pill', () => {
    const out = renderAssistantHtml(
      "Here's your contract:\n[Northwind Service Agreement](lattice://contracts/9b7c60f0-fbc2-4f87-a550-c59e3c5d761f)",
    );
    expect(out).toContain('class="chip chip-link lattice-ref"');
    expect(out).toContain('data-table="contracts"');
    expect(out).toContain('data-id="9b7c60f0-fbc2-4f87-a550-c59e3c5d761f"');
    expect(out).toContain('Northwind Service Agreement</a>');
  });

  it('does not leak the placeholder sentinel or a bare index (the (\\d+) regression)', () => {
    const out = renderAssistantHtml('See [the offer](lattice://contracts/abc-123) for details.');
    // The exact failure we shipped: U+0002 sentinel survived but the swap left a
    // bare index instead of the pill.
    expect(out).not.toContain(String.fromCharCode(2));
    expect(out).not.toMatch(/>\s*\d+\s*</); // no bare "0" where the pill belongs
    expect(out).toContain('lattice-ref');
    expect(out).toContain('the offer</a>');
  });

  it('handles multiple references in one message', () => {
    const out = renderAssistantHtml(
      'Two records: [Acme](lattice://clients/c1) and [Bob](lattice://people/p2).',
    );
    expect(out).toContain('data-table="clients"');
    expect(out).toContain('data-id="c1"');
    expect(out).toContain('data-table="people"');
    expect(out).toContain('data-id="p2"');
  });

  it('leaves ordinary prose without a lattice link untouched (no stray pill)', () => {
    const out = renderAssistantHtml('Just some **bold** text, no object reference here.');
    expect(out).not.toContain('lattice-ref');
    expect(out).toContain('<strong>bold</strong>');
  });
});
