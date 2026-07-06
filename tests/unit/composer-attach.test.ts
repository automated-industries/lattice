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

  it('a drop attaches to Gladys on Analytics but auto-ingests on Configure', () => {
    // Analytics → stage into the composer; Configure → ingest immediately.
    expect(appJs).toContain('if (isAnalyticsHash(location.hash)) {');
    expect(appJs).toContain('stageFiles(files);');
    expect(appJs).toContain('uploadFiles(files);');
    // The old always-switch-to-Analytics behavior is gone.
    expect(appJs).not.toContain('location.hash = lastAnalyticsHash;\n          stageFiles');
  });
});
