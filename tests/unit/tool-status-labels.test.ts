// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { analyticsViewJs } from '../../src/gui/app/modules/analytics-view.js';

/**
 * Every tool call surfaces its OWN plain-language status line. anToolStatus maps the fixed
 * registry tool name → a specific gerund label ("Looking up a URL…", "Searching your data…"),
 * with a generic "Working on your data…" fallback for anything unmapped (e.g. a connector tool
 * registered later) — and never renders the raw tool name.
 */

interface StatusGlobals {
  anToolStatus: (tool: string | null) => void;
}

function loadAnToolStatus(): StatusGlobals {
  document.body.innerHTML = '<div id="ask-status" role="status" hidden></div>';
  // Indirect eval defines the analytics-view client (incl. anToolStatus + TOOL_LABELS).
  (0, eval)(analyticsViewJs as string);
  return globalThis as unknown as StatusGlobals;
}

function statusText(): string {
  return document.getElementById('ask-status')!.textContent ?? '';
}

describe('anToolStatus — per-tool status labels', () => {
  let w: StatusGlobals;
  beforeEach(() => {
    w = loadAnToolStatus();
  });

  it('maps each tool to its own specific label', () => {
    w.anToolStatus('ingest_url');
    expect(statusText()).toBe('Looking up a URL…');
    w.anToolStatus('search');
    expect(statusText()).toBe('Searching your data…');
    w.anToolStatus('update_row');
    expect(statusText()).toBe('Updating your records…');
    w.anToolStatus('import_spreadsheet');
    expect(statusText()).toBe('Importing your spreadsheet…');
  });

  it('distinguishes building a new dashboard from editing an existing one', () => {
    w.anToolStatus('create_dashboard');
    expect(statusText()).toBe('Building your dashboard…');
    w.anToolStatus('edit_dashboard');
    expect(statusText()).toBe('Editing your dashboard…');
  });

  it('falls back to a generic label for an unmapped/connector tool — never the raw name', () => {
    w.anToolStatus('mcp_justworks_query');
    expect(statusText()).toBe('Working on your data…');
    expect(statusText()).not.toContain('mcp_justworks_query');
  });

  it('clears and hides the status line when passed null (turn end)', () => {
    w.anToolStatus('search');
    expect(document.getElementById('ask-status')!.hidden).toBe(false);
    w.anToolStatus(null);
    expect(statusText()).toBe('');
    expect(document.getElementById('ask-status')!.hidden).toBe(true);
  });
});
