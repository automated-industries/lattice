import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';
import { css } from '../../src/gui/app/css.js';

/**
 * 5.3.1 realtime-feedback unification, tranche 2:
 *  A1 — one activity-menu-anchored background-task tracker absorbs the three
 *       ingestion progress surfaces (sticky feed bar + per-file pending rows +
 *       server folder ingest) into a single tracker with a progress bar.
 *  A4 — bot thinking / tool-usage becomes one ordered realtime STATUS STRIP in
 *       its own region (#ask-status), never chat bubbles.
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

describe('A4 — bot thinking / tool-usage status strip', () => {
  it('renders an ordered step strip, not a single overwriting line', () => {
    expect(appJs).toContain('function anStatusThinking');
    expect(appJs).toContain('function anStatusRender');
    expect(appJs).toContain('anStatusSteps');
    expect(appJs).toContain("classList.add('ask-status-strip')");
    expect(css).toContain('.ask-status-strip');
    expect(css).toContain('.ask-status-step');
  });

  it('seeds a Thinking head at turn start and steps per tool', () => {
    expect(appJs).toContain("label: 'Thinking…'");
    // the turn-start hook wires it
    expect(appJs).toContain('anStatusThinking()');
  });
});
