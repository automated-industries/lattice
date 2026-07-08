import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { guiAppHtml } from '../../src/gui/app.js';

/**
 * Composer file-attach UX: the staged-files "to add" chips sit directly above the
 * chat box (removable), the upload button opens the picker reliably, and a drop
 * behaves per view (attach-to-chat on Analytics, auto-ingest on Configure).
 */
describe('composer file-attach UX', () => {
  it('renders the staged-files tray in its own host above the composer (not the feed)', () => {
    // The host sits between the question cards and the composer in the shell.
    expect(guiAppHtml).toContain('id="staging-tray-host"');
    // The tray is appended into that host — no longer inserted into rail-feed.
    expect(appJs).toContain("document.getElementById('staging-tray-host')");
    expect(appJs).toContain('host.appendChild(tray)');
  });

  it('opens the file picker via a native <label for>, not a blocked programmatic click', () => {
    expect(appJs).toContain('class="composer-clip" id="chat-clip" for="chat-file"');
    // The clip no longer calls fileInput.click() on click (blocked in the desktop
    // webview + double-triggers against the label's native activation).
    expect(appJs).not.toContain(
      "clipBtn.addEventListener('click', function () { fileInput.click(); });",
    );
  });

  it('a drop attaches to Gladys on Analytics but ingests on the Inputs column in Configure', () => {
    // The drop is scoped to ONE surface per view: the chat window (#ask-dock) in
    // Analytics (stage into the composer), the Inputs column (nav.sidebar) in
    // Configure (ingest). There is no whole-window drop anymore.
    expect(appJs).toContain('function dropTarget()');
    expect(appJs).toContain("document.getElementById('ask-dock')");
    expect(appJs).toContain("document.querySelector('nav.sidebar')");
    expect(appJs).toContain('stageFiles(files);');
    expect(appJs).toContain('uploadFiles(files);');
    // A dropped folder is expanded into its files via the Entries API.
    expect(appJs).toContain('function collectDroppedFiles(');
    expect(appJs).toContain('webkitGetAsEntry');
    // The old always-switch-to-Analytics behavior is gone.
    expect(appJs).not.toContain('location.hash = lastAnalyticsHash;\n          stageFiles');
  });

  it('refreshes the conversation list when an AI thread title lands', () => {
    // The friendly Haiku title is written after the chat stream closes, so the
    // client re-fetches the thread list on the thread_title feed signal — otherwise
    // the raw first-message placeholder stays visible until a manual reload.
    expect(appJs).toContain("data.op === 'thread_title'");
    expect(appJs).toContain('refreshThreadList()');
  });
});
