// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { analyticsViewJs } from '../../src/gui/app/modules/analytics-view.js';

/**
 * The assistant's in-flight work reports through the SAME background-task tracker
 * every other long-running job uses — one task per turn, in the activity menu,
 * never a separate region beside the conversation. Each tool call re-labels that
 * task with a plain-language gerund mapped from the fixed registry tool name
 * ("Looking up a URL…", "Searching your data…"), with a generic
 * "Working on your data…" fallback for anything unmapped — never the raw name.
 * Passing null settles the task (the answer is streaming).
 */

interface StatusGlobals {
  anToolStatus: (tool: string | null) => void;
  anStatusThinking: () => void;
}

/** What the tracker was last told, and how the turn's task was settled. */
let taskId = '';
let label = '';
let settled: string | null = null;

function loadStatus(): StatusGlobals {
  taskId = '';
  label = '';
  settled = null;
  // The module uses composed-IIFE globals; provide faithful stubs for the
  // isolated eval (labels are static, so escapeHtml identity is faithful).
  (globalThis as unknown as { escapeHtml: (s: string) => string }).escapeHtml = (s) => s;
  (
    globalThis as unknown as {
      bgTask: (id: string, opts?: { label?: string }) => Record<string, unknown>;
    }
  ).bgTask = (id, opts) => {
    taskId = id;
    label = opts?.label ?? '';
    return {
      update: () => {},
      done: (l?: string) => {
        settled = l ?? '';
      },
      fail: () => {},
    };
  };
  (0, eval)(analyticsViewJs as string);
  return globalThis as unknown as StatusGlobals;
}

describe('anToolStatus — per-tool labels on the shared background-task tracker', () => {
  let w: StatusGlobals;
  beforeEach(() => {
    w = loadStatus();
  });

  it('maps each tool to its own specific label', () => {
    w.anToolStatus('ingest_url');
    expect(label).toBe('Looking up a URL…');
    w.anToolStatus('search');
    expect(label).toBe('Searching your data…');
    w.anToolStatus('update_row');
    expect(label).toBe('Updating your records…');
    w.anToolStatus('import_spreadsheet');
    expect(label).toBe('Importing your spreadsheet…');
    w.anToolStatus('get_provenance');
    expect(label).toBe('Tracing where this data came from…');
  });

  it('reports the turn as ONE task, so concurrent jobs stack rather than collide', () => {
    w.anToolStatus('search');
    expect(taskId).toBe('assistant');
    w.anToolStatus('update_row');
    expect(taskId).toBe('assistant');
  });

  it('distinguishes building a new dashboard from editing an existing one', () => {
    w.anToolStatus('create_dashboard');
    expect(label).toBe('Building your dashboard…');
    w.anToolStatus('edit_dashboard');
    expect(label).toBe('Editing your dashboard…');
  });

  it('falls back to a generic label for an unmapped/connector tool — never the raw name', () => {
    w.anToolStatus('mcp_justworks_query');
    expect(label).toBe('Working on your data…');
    expect(label).not.toContain('mcp_justworks_query');
  });

  it('shows a Thinking label at turn start, then re-labels per tool', () => {
    w.anStatusThinking();
    expect(label).toBe('Thinking…');
    w.anToolStatus('search');
    expect(label).toBe('Searching your data…');
  });

  it('keeps one task across rounds — a later Thinking does not open a second', () => {
    w.anStatusThinking();
    w.anToolStatus('search');
    w.anStatusThinking(); // a second round within the same turn
    expect(label).toBe('Searching your data…'); // unchanged: no new task opened
  });

  it('settles the task when passed null (turn end / answer starts)', () => {
    w.anToolStatus('search');
    expect(settled).toBeNull();
    w.anToolStatus(null);
    expect(settled).toBe('Finished');
  });
});
