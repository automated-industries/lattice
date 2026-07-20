// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { questionsJs } from '../../src/gui/app/modules/questions.js';
import { appJs } from '../../src/gui/app/script.js';
import { css } from '../../src/gui/app/css.js';

/**
 * Non-destructive clarification-question surfacing + a11y wiring.
 *
 * A background 'question' realtime event used to flip the hash to the Analytics
 * view, yanking the user out of whatever they were doing. Questions now live in a
 * dedicated Data Questions tab (Configure) + the dock (Analytics), so a new question
 * NEVER switches views — it surfaces where the user already is. The behavioral tests
 * below execute the REAL questions client in a jsdom global (deps stubbed) and assert
 * the route is preserved (mid-build or idle), the dot/toast fire, and that answering
 * in the tab reaps the dock twin.
 */

interface QGlobals extends Record<string, unknown> {
  fetchJson: () => Promise<unknown>;
  isAnalyticsHash: (h: string) => boolean;
  lastAnalyticsHash: string;
  showToast: ReturnType<typeof vi.fn>;
  refreshQuestions: (openOnNew: boolean) => Promise<void>;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function loadQuestions(pending: Record<string, unknown>[]): QGlobals {
  const w = globalThis as unknown as QGlobals;
  w.fetchJson = () => Promise.resolve({ questions: pending });
  w.isAnalyticsHash = (h: string) => (h || '').startsWith('#/analytics');
  w.lastAnalyticsHash = '#/analytics';
  w.showToast = vi.fn();
  // Indirect eval defines the questions client (refreshQuestions, the dot/toast
  // helpers, qCards/qPendingCount state) on the jsdom global scope.
  (0, eval)(questionsJs as string);
  return w;
}

describe('clarification questions — non-destructive surfacing (jsdom)', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<button id="ask-lattice-trigger" aria-label="Open Analytics"></button>' +
      '<div id="question-cards"></div>';
    window.location.hash = '';
  });

  it('a new question while mid-build (#/computed/*) does NOT navigate — dot + toast instead', async () => {
    window.location.hash = '#/computed/new';
    const w = loadQuestions([{ id: 'q1', question: 'Track suppliers?', options: ['Yes', 'No'] }]);

    await w.refreshQuestions(true);
    await flush();

    // The involuntary navigation is gone: the builder route is preserved.
    expect(window.location.hash).toBe('#/computed/new');
    // Surfaced non-destructively: the trigger dot lights and a toast points at
    // the Data Questions tab.
    const trig = document.getElementById('ask-lattice-trigger')!;
    expect(trig.classList.contains('has-question')).toBe(true);
    expect(w.showToast).toHaveBeenCalledTimes(1);
    expect(String((w.showToast.mock.calls[0] ?? [])[0])).toMatch(/data question/i);
    // The pending count reaches assistive tech via the accessible name + a live
    // region (the CSS-only dot is not the sole signal).
    expect(trig.getAttribute('aria-label')).toContain('1 question waiting');
    const live = document.getElementById('q-live')!;
    expect(live).toBeTruthy();
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent || '').toMatch(/data question is waiting/i);
  });

  it('a new question while idle does NOT switch views — dot + toast, route preserved', async () => {
    window.location.hash = '#/tables';
    const w = loadQuestions([{ id: 'q1', question: 'Track suppliers?', options: ['Yes', 'No'] }]);

    await w.refreshQuestions(true);
    await flush();

    // The confusing auto-switch to Analytics is gone — a new ingestion question
    // surfaces where the user already is (the Data Questions tab + a toast), so the
    // Configure route is preserved instead of being yanked to #/analytics.
    expect(window.location.hash).toBe('#/tables');
    expect(w.showToast).toHaveBeenCalledTimes(1);
    expect(document.getElementById('ask-lattice-trigger')!.classList.contains('has-question')).toBe(
      true,
    );
  });

  it('answering in the Data Questions tab removes the Analytics dock twin (no stale duplicate)', async () => {
    // A question surfaces while in Analytics → a dock card is created + tracked.
    const w = loadQuestions([{ id: 'q1', question: 'Track suppliers?', options: ['Yes', 'No'] }]);
    await w.refreshQuestions(false);
    await flush();
    // Cards now live in the #q-stack collapsible region (a #q-banner sibling summarizes it).
    const stack = document.getElementById('q-stack')!;
    expect(stack.children.length).toBe(1); // dock twin present in the stack
    expect(document.getElementById('q-banner')).not.toBeNull(); // banner summarizes 1 pending
    // The user answers it from the Data Questions tab: qDqAfterResolve must remove the
    // dock twin's DOM node (not just its qCards entry), or a stale, still-clickable card
    // lingers in the dock that refreshQuestions can no longer reap.
    const qDqAfterResolve = (
      globalThis as unknown as { qDqAfterResolve: (id: string, c: unknown) => void }
    ).qDqAfterResolve;
    qDqAfterResolve('q1', document.createElement('div'));
    expect(document.getElementById('q-stack')!.children.length).toBe(0); // twin gone
    // …and the banner is repainted to zero (removed), not left stale (the qDqAfterResolve fix).
    expect(document.getElementById('q-banner')).toBeNull();
  });

  it('pluralizes the pending-count accessible name', async () => {
    window.location.hash = '#/computed/x';
    const w = loadQuestions([
      { id: 'q1', question: 'A?', options: ['1', '2'] },
      { id: 'q2', question: 'B?', options: ['1', '2'] },
    ]);
    await w.refreshQuestions(true);
    await flush();
    expect(document.getElementById('ask-lattice-trigger')!.getAttribute('aria-label')).toContain(
      '2 questions waiting',
    );
  });
});

describe('UX-review bundle wiring (composed client)', () => {
  it('the composed client is syntactically valid', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- parse-only syntax check
    expect(() => new Function(appJs)).not.toThrow();
  });

  it('question surfacing guards active work + wires the toast (non-destructive nav)', () => {
    expect(appJs).toContain('function qUserIsEditing()');
    expect(appJs).toContain("(location.hash || '').indexOf('#/computed/') === 0");
    expect(appJs).toContain('New data question');
  });

  it('the Data Questions view + its route survive (the Configure tab strip is retired)', () => {
    // The transient Configure tab + its badge went with the Configure tab strip
    // (tabs.ts), but the questions VIEW + its #/questions route remain (surfaced via
    // the dock badge). The tab-strip fn setQuestionsTab is gone; its callers are guarded.
    expect(appJs).not.toContain('function setQuestionsTab(');
    expect(appJs).toContain('function renderQuestionsView(');
    expect(appJs).toContain("hash === '#/questions'");
    // The questions client's call is kept behind a typeof guard (no-op now).
    expect(appJs).toContain('setQuestionsTab(qPendingCount)');
  });

  it('review-hardening: soft-refresh guard, renderGen guard, workspace-switch reset', () => {
    // A soft refresh must not rebuild the questions page (would clobber a half-typed answer).
    expect(appJs).toContain('if (!soft) renderQuestionsView(content)');
    // A stale in-flight fetch refuses to commit (drops DOM writes + setQuestionsTab).
    expect(appJs).toContain('if (myGen !== renderGen) return;');
    // Workspace switch wipes the previous workspace's question state.
    expect(appJs).toContain('function resetQuestionsState()');
    expect(appJs).toContain('resetQuestionsState();');
    // (The old "removing the Configure tab bounces the user off the questions page"
    // logic went with the retired Configure tab strip.)
  });

  it('the pending state has a non-visual signal (aria-label + aria-live) and dismiss confirms', () => {
    expect(appJs).toContain(' question waiting');
    expect(appJs).toContain(' questions waiting');
    expect(appJs).toContain("'q-live'");
    expect(appJs).toContain("setAttribute('aria-live', 'polite')");
    expect(appJs).toContain("confirm('Dismiss this question?')");
  });

  // (Removed: the computed-view AI-pending banner lived on the old Formatted/Markdown
  // collection page, which is now the SQL runner — computed tables render through the
  // same runner, so there is no per-collection pending-fill banner.)

  it('deleting a computed table or a dashboard confirms before the DELETE', () => {
    // Computed-table builder Remove.
    expect(appJs).toContain("confirm('Remove ' + cbS.name + '? You can undo this from history.')");
    // Dashboard ⋯ Delete.
    expect(appJs).toContain(
      `window.confirm('Remove "' + (row.title || 'dashboard') + '"? You can undo this from history.')`,
    );
  });
});

describe('dead-CSS removal (composed stylesheet)', () => {
  it('drops the retired 5.0 markup styles', () => {
    for (const sel of [
      '.context-block',
      '.context-file',
      '.prov-mount',
      '.cell-clip',
      '.empty-row',
      '.assistant-rail',
      '.rail-handle',
      '.row-actions',
      '.out-group',
      '.out-placeholder',
      '.toggle-track',
      '.toggle-thumb',
      '.fs-doc {',
    ]) {
      expect(css, sel + ' should be removed').not.toContain(sel);
    }
  });

  it('keeps still-referenced styles', () => {
    // .fs-tile-vis is emitted by the shared vis() helper (exercised by
    // gui-visibility-indicators.test.ts) — retained on purpose.
    expect(css).toContain('.fs-tile-vis');
    // The live file-drop overlay is still used.
    expect(css).toContain('.file-drop-overlay');
  });
});
