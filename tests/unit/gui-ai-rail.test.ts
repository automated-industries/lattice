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

  it('wires file ingest (drag-drop + paperclip) into the rail', () => {
    expect(guiAppHtml).toContain('function uploadFile');
    expect(guiAppHtml).toContain('function initRailDragDrop');
    expect(guiAppHtml).toContain("'/api/ingest/upload'");
    expect(guiAppHtml).toContain('initRailDragDrop();');
    expect(guiAppHtml).toContain('id="chat-clip"');
  });

  it('wires chat threading (new chat + conversation switcher)', () => {
    expect(guiAppHtml).toContain('id="rail-threads"');
    expect(guiAppHtml).toContain('id="rail-newchat"');
    expect(guiAppHtml).toContain('function refreshThreadList');
    expect(guiAppHtml).toContain('function loadThread');
    expect(guiAppHtml).toContain("'/api/chat/threads'");
    expect(guiAppHtml).toContain('initThreadControls();');
  });

  it('checks native-entity setup on boot', () => {
    expect(guiAppHtml).toContain('function checkNativeSetup');
    expect(guiAppHtml).toContain("'/api/native-entities'");
    expect(guiAppHtml).toContain('checkNativeSetup();');
  });

  it('renders markdown/office previews via a safe inline renderer', () => {
    expect(guiAppHtml).toContain('function mdToHtml');
    expect(guiAppHtml).toContain('MD_MIMES');
    expect(guiAppHtml).toContain('class="md-body"');
  });

  it('provides a mobile bottom-drawer handle + toggle', () => {
    expect(guiAppHtml).toContain('id="rail-handle"');
    expect(guiAppHtml).toContain('function initRailDrawer');
    expect(guiAppHtml).toContain('initRailDrawer();');
    expect(guiAppHtml).toContain('@media (max-width: 720px)');
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
    // Intentional: new Function() compiles (without executing) the inline SPA
    // script to surface syntax errors that bundling/tsc never sees.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(body)).not.toThrow();
  });
});
