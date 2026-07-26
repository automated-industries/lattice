// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { analyticsViewJs } from '../../src/gui/app/modules/analytics-view.js';

/**
 * The assistant working status is ONE ordered STATUS STRIP (5.3.1 / A4), rendered
 * in its own #ask-status region — never chat bubbles. Each tool call appends a
 * step whose label is a plain-language gerund mapped from the fixed registry tool
 * name ("Looking up a URL…", "Searching your data…"), with a generic
 * "Working on your data…" fallback for anything unmapped — never the raw name.
 * Prior steps resolve; a null call clears the strip (turn end / answer streaming).
 */

interface StatusGlobals {
  anToolStatus: (tool: string | null) => void;
  anStatusThinking: () => void;
}

function loadStatus(): StatusGlobals {
  document.body.innerHTML = '<div id="ask-status" role="status" hidden></div>';
  // The module uses the composed-IIFE global escapeHtml; provide it for the
  // isolated eval (labels are static, so identity is a faithful stub).
  (globalThis as unknown as { escapeHtml: (s: string) => string }).escapeHtml = (s) => s;
  (0, eval)(analyticsViewJs as string);
  return globalThis as unknown as StatusGlobals;
}

/** Label of the current running step (what the user is told is happening now). */
function runningStep(): string {
  return (
    document.querySelector('#ask-status .ask-status-running .ask-status-label')?.textContent ?? ''
  );
}
function stripText(): string {
  return document.getElementById('ask-status')!.textContent ?? '';
}

describe('anToolStatus — ordered per-tool status strip', () => {
  let w: StatusGlobals;
  beforeEach(() => {
    w = loadStatus();
  });

  it('maps each tool to its own specific label (as the current running step)', () => {
    w.anToolStatus('ingest_url');
    expect(runningStep()).toBe('Looking up a URL…');
    w.anToolStatus('search');
    expect(runningStep()).toBe('Searching your data…');
    w.anToolStatus('update_row');
    expect(runningStep()).toBe('Updating your records…');
    w.anToolStatus('import_spreadsheet');
    expect(runningStep()).toBe('Importing your spreadsheet…');
    w.anToolStatus('get_provenance');
    expect(runningStep()).toBe('Tracing where this data came from…');
  });

  it('distinguishes building a new dashboard from editing an existing one', () => {
    w.anToolStatus('create_dashboard');
    expect(runningStep()).toBe('Building your dashboard…');
    w.anToolStatus('edit_dashboard');
    expect(runningStep()).toBe('Editing your dashboard…');
  });

  it('falls back to a generic label for an unmapped/connector tool — never the raw name', () => {
    w.anToolStatus('mcp_justworks_query');
    expect(runningStep()).toBe('Working on your data…');
    expect(stripText()).not.toContain('mcp_justworks_query');
  });

  it('shows a Thinking head at turn start, then steps per tool', () => {
    w.anStatusThinking();
    expect(runningStep()).toBe('Thinking…');
    w.anToolStatus('search');
    // The head resolves; the tool becomes the running step.
    expect(runningStep()).toBe('Searching your data…');
    expect(stripText()).toContain('Thinking…'); // prior step still shown (resolved)
  });

  it('clears and hides the strip when passed null (turn end / answer starts)', () => {
    w.anToolStatus('search');
    expect(document.getElementById('ask-status')!.hidden).toBe(false);
    w.anToolStatus(null);
    expect(stripText()).toBe('');
    expect(document.getElementById('ask-status')!.hidden).toBe(true);
  });
});
