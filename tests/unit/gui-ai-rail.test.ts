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

  it('collapses a run of identical tool calls into one counted pill', () => {
    // A turn with several list_rows must read "Listed N rows", not N copies of
    // "Listed rows". The grouping mirrors the activity feed's coalescing.
    expect(guiAppHtml).toContain('function toolGroupLabel');
    expect(guiAppHtml).toContain('function paintToolPill');
    expect(guiAppHtml).toContain('function renderResolvedPills');
    expect(guiAppHtml).toContain('TOOL_GROUP');
    // The grouped label is verb + count + noun ("Listed" + n + "rows").
    expect(guiAppHtml).toContain("['Listing',  'Listed',  'rows']");
    // Live grouping coalesces into the turn's lastTool run.
    expect(guiAppHtml).toContain('ctx.lastTool');
  });

  it('auto-grows the composer textarea and re-fits on width change', () => {
    expect(guiAppHtml).toContain('function autoGrowInput');
    expect(guiAppHtml).toContain('COMPOSER_MAX_H');
    // Recompute height when the textarea is re-wrapped at a new rail width.
    expect(guiAppHtml).toContain(
      'new ResizeObserver(function () { autoGrowInput(); }).observe(input)',
    );
    // Long unbroken tokens must wrap rather than overflow the rail.
    expect(guiAppHtml).toContain('overflow-wrap: break-word');
  });

  it('renders markdown/office previews via a safe inline renderer', () => {
    expect(guiAppHtml).toContain('function mdToHtml');
    expect(guiAppHtml).toContain('MD_MIMES');
    expect(guiAppHtml).toContain('class="md-body"');
  });

  it('fades + tooltips the mic button when no microphone is available', () => {
    // Detect mic presence and reflect it on the button instead of popping a
    // "Microphone unavailable" dialog on click.
    expect(guiAppHtml).toContain('function refreshMicAvailability');
    expect(guiAppHtml).toContain('function markMicUnavailable');
    expect(guiAppHtml).toContain('enumerateDevices');
    expect(guiAppHtml).toContain('composer-mic-unavailable');
    expect(guiAppHtml).toContain('No microphone available');
    // The click is a no-op while unavailable (no alert).
    expect(guiAppHtml).toContain("classList.contains('composer-mic-unavailable')");
    // The old blocking alert is gone.
    expect(guiAppHtml).not.toContain("alert('Microphone unavailable: ' + e.message)");
  });

  it('uses inline toasts instead of blocking alert() dialogs', () => {
    // The user wants no browser alert() popups — messaging is inline (toasts).
    expect(guiAppHtml).not.toContain('alert(');
    expect(guiAppHtml).toContain('function showToast');
  });

  it('opts API-token + secret inputs out of password-manager popups', () => {
    expect(guiAppHtml).toContain('data-1p-ignore');
    expect(guiAppHtml).toContain('data-lpignore="true"');
  });

  it('lets workspace names contain special characters (server derives the slug)', () => {
    // The restrictive character regex is removed; only a length guard remains.
    expect(guiAppHtml).not.toContain('must start with a letter or digit and contain only');
    expect(guiAppHtml).toContain('Workspace name must be 200 characters or fewer');
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
