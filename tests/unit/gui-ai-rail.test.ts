import { describe, it, expect } from 'vitest';
import { guiAppHtml } from '../../src/gui/app.js';

describe('assistant rail markup + wiring', () => {
  it('includes the rail DOM hooks', () => {
    expect(guiAppHtml).toContain('id="assistant-rail"');
    expect(guiAppHtml).toContain('id="rail-feed"');
    expect(guiAppHtml).toContain('id="rail-resize"');
    expect(guiAppHtml).toContain('class="assistant-rail"');
  });

  it('drives the layout grid off the --sidebar-width variable', () => {
    expect(guiAppHtml).toContain('--sidebar-width');
    expect(guiAppHtml).toContain('var(--sidebar-width)');
  });

  it('wires the feed EventSource + resize on boot', () => {
    expect(guiAppHtml).toContain("'/api/feed/stream'");
    expect(guiAppHtml).toContain('function startFeed');
    expect(guiAppHtml).toContain('function initRailResize');
    expect(guiAppHtml).toContain('startFeed();');
    expect(guiAppHtml).toContain('initRailResize();');
  });

  it('inline SPA script parses without syntax errors', () => {
    // The inline <script> isn't type-checked or bundled, so a syntax error
    // would only surface in the browser. new Function() compiles (but does
    // NOT execute) the body, so it throws SyntaxError on malformed JS while
    // never touching browser globals.
    const open = guiAppHtml.indexOf('<script>');
    const close = guiAppHtml.lastIndexOf('</script>');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const body = guiAppHtml.slice(open + '<script>'.length, close);
    expect(() => new Function(body)).not.toThrow();
  });
});
