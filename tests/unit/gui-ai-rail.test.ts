import { describe, it, expect } from 'vitest';
import { guiAppHtml } from '../../src/gui/app.js';

describe('assistant dock + Outputs markup + wiring', () => {
  it('houses the assistant in the Analytics dock (floating panel retired)', () => {
    // The chat lives in the Analytics view's docked right column. The chat
    // element IDs are reused inside the dock so the chat client code is
    // unchanged; the old floating upper-right panel is gone.
    expect(guiAppHtml).toContain('id="ask-dock"');
    expect(guiAppHtml).toContain('id="analytics-layout"');
    expect(guiAppHtml).toContain('id="dash-list"');
    expect(guiAppHtml).toContain('id="antabstrip-tabs"');
    expect(guiAppHtml).toContain('id="ask-lattice-trigger"');
    expect(guiAppHtml).toContain('id="configure-trigger"');
    expect(guiAppHtml).toContain('id="rail-feed"');
    expect(guiAppHtml).toContain('id="outputs-rail"');
    expect(guiAppHtml).toContain('id="outputs-resize"');
    expect(guiAppHtml).toContain('class="outputs"');
    // The docked rail AND the floating panel are gone.
    expect(guiAppHtml).not.toContain('id="assistant-rail"');
    expect(guiAppHtml).not.toContain('class="assistant-rail"');
    expect(guiAppHtml).not.toContain('id="ask-lattice-panel"');
  });

  it('drives the layout grid off the --outputs-width variable', () => {
    expect(guiAppHtml).toContain('--outputs-width');
    expect(guiAppHtml).toContain('var(--outputs-width)');
    expect(guiAppHtml).not.toContain('--sidebar-width');
  });

  it('wires the multiplexed event stream + Outputs resize on boot', () => {
    // Feed/realtime/render events ride ONE WebSocket (`/api/stream`) instead of
    // three SSE streams, so a tab holds a single persistent connection.
    expect(guiAppHtml).toContain("'/api/stream'");
    expect(guiAppHtml).toContain('function startEventStream');
    expect(guiAppHtml).toContain('new WebSocket(');
    expect(guiAppHtml).toContain('function initOutputsResize');
    expect(guiAppHtml).toContain('startEventStream();');
    expect(guiAppHtml).toContain('initOutputsResize();');
    // The three separate SSE stream openers are gone.
    expect(guiAppHtml).not.toContain("new EventSource('/api/feed/stream')");
  });

  it('wires file ingest (whole-window drop zone + paperclip)', () => {
    expect(guiAppHtml).toContain('function uploadFile');
    // The drop target is now the whole window (a full-screen overlay), not a
    // panel-scoped listener — a drop anywhere opens Gladys and stages the file.
    expect(guiAppHtml).toContain('function initFileDropZone');
    expect(guiAppHtml).toContain('file-drop-overlay');
    expect(guiAppHtml).toContain("'/api/ingest/upload'");
    expect(guiAppHtml).toContain('initAskLattice();');
    expect(guiAppHtml).toContain('id="chat-clip"');
  });

  it('moves the live activity feed to a header popover (next to version history)', () => {
    expect(guiAppHtml).toContain('id="activity-pill"');
    expect(guiAppHtml).toContain('id="activity-feed"');
    expect(guiAppHtml).toContain('function initActivityHeader');
    expect(guiAppHtml).toContain('initActivityHeader();');
  });

  it('artifacts live in the Markdown column tree (no sidebar tree, no separate section)', () => {
    // ONE Markdown view: artifacts are a category inside the markdown tree.
    expect(guiAppHtml).toContain('id="out-markdown-tree"');
    expect(guiAppHtml).toContain('mdt-artifact');
    // The old left-sidebar artifacts tree AND the separate Outputs sections are gone.
    expect(guiAppHtml).not.toContain('id="src-artifacts-tree"');
    expect(guiAppHtml).not.toContain('id="out-artifacts-tree"');
    expect(guiAppHtml).not.toContain('renderOutputsArtifacts');
    expect(guiAppHtml).not.toContain('id="out-tables-mount"');
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

  it("renders the assistant's data changes as collapsed activity cards (no inline tool pills)", () => {
    // Tool actions are no longer painted as inline pills. The assistant's data
    // changes render as the same full-width activity cards as the live feed,
    // collapsed by type and persisted per-turn for replay. Reads emit no card.
    expect(guiAppHtml).toContain('function makeFeedCard');
    expect(guiAppHtml).toContain('function renderTurnEventCards');
    expect(guiAppHtml).toContain('function feedGroupKey');
    // Same-type events collapse even across different objects (table excluded
    // from the key) — e.g. "Removed N rows across M tables".
    expect(guiAppHtml).toContain('across ');
    // Live (op:'schema') and persisted (op:'schema.delete_entity') schema events
    // both collapse + take the 🛠 icon via the shared normalizer.
    expect(guiAppHtml).toContain('function isSchemaOp');
    // The old inline tool-pill system is gone entirely.
    expect(guiAppHtml).not.toContain('renderResolvedPills');
    expect(guiAppHtml).not.toContain('addToolPill');
    expect(guiAppHtml).not.toContain("className = 'tool-pill'");
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

  it('switches views from the header triggers (no floating panel logic)', () => {
    expect(guiAppHtml).toContain('function initAnalyticsView');
    expect(guiAppHtml).toContain('function applyAppView');
    expect(guiAppHtml).toContain('function renderAnalyticsRoute');
    // The floating panel machinery is gone.
    expect(guiAppHtml).not.toContain('function openAskLattice');
    expect(guiAppHtml).not.toContain('function toggleAskLattice');
    // The retired mobile bottom-drawer is gone too.
    expect(guiAppHtml).not.toContain('id="rail-handle"');
    expect(guiAppHtml).not.toContain('function initRailDrawer');
  });

  it('inline SPA script parses without syntax errors', () => {
    // The inline <script> isn't type-checked or bundled, so a syntax error
    // would only surface in the browser. new Function() compiles (but does
    // NOT execute) the body, so it throws SyntaxError on malformed JS while
    // never touching browser globals.
    // There are multiple inline <script> blocks now (the analytics snippet plus
    // the SPA). Compile EACH so a syntax error in either surfaces here.
    const re = /<script>([\s\S]*?)<\/script>/g;
    const bodies: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(guiAppHtml)) !== null) bodies.push(m[1] ?? '');
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) {
      // Intentional: new Function() compiles (without executing) the inline
      // script to surface syntax errors that bundling/tsc never sees.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      expect(() => new Function(body)).not.toThrow();
    }
  });
});
