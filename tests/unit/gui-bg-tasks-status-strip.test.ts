import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { css } from '../../src/gui/app/css.js';

/**
 * One background-progress surface: the activity-menu tracker absorbs every
 * long-running job — ingestion (sticky feed bar + per-file pending rows + server
 * folder ingest) and the assistant's own in-flight turn — into a single stacking
 * tracker with a progress bar. There is no separate status region beside the
 * conversation: the rail carries the user's messages and the assistant's answers,
 * and nothing else.
 */
describe('A1 — activity-menu background-task tracker', () => {
  it('defines the bgTask registry + handle API', () => {
    expect(appJs).toContain('function bgTask(id, opts)');
    expect(appJs).toContain('function clearBgTask(id)');
    expect(appJs).toContain('function renderBgTasks()');
  });

  it('anchors to the activity menu (bg-tasks section + pill running dot)', () => {
    expect(appJs).toContain("getElementById('bg-tasks')");
    expect(appJs).toContain("getElementById('activity-running')");
    expect(css).toContain('.bg-tasks');
    expect(css).toContain('.bg-task-fill');
    expect(css).toContain('.activity-running');
  });

  it('routes ingestion through the tracker (retiring the sticky feed bar)', () => {
    // ingest progress upserts a single 'ingest' bgTask...
    expect(appJs).toContain("bgTask('ingest'");
    // ...and no longer builds the old sticky .ingest-progress feed node.
    expect(appJs).not.toContain("node.className = 'ingest-progress'");
  });

  it('retired the redundant per-file pending feed rows', () => {
    expect(appJs).not.toContain('function pendingIngestItem');
  });
});

describe('assistant turn progress reports through the same tracker', () => {
  it('drives a background task rather than a separate status region', () => {
    expect(appJs).toContain('function anStatusThinking');
    expect(appJs).toContain('function anToolStatus');
    expect(appJs).toContain("bgTask('assistant'");
  });

  it('seeds a Thinking label at turn start and re-labels per tool', () => {
    expect(appJs).toContain("label: 'Thinking…'");
    // the turn-start hook wires it
    expect(appJs).toContain('anStatusThinking()');
    // each tool call re-labels the same task from the shared label map
    expect(appJs).toContain('TOOL_LABELS[toolName]');
  });

  it('leaves no separate status strip beside the conversation', () => {
    expect(appJs).not.toContain('anStatusSteps');
    expect(appJs).not.toContain('ask-status');
    expect(css).not.toContain('.ask-status');
  });
});
