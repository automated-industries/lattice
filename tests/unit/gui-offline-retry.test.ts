import { describe, expect, it } from 'vitest';

import { appJs } from '../../src/gui/app/script.js';

/**
 * The offline-edit replay queue (modules/realtime-feed.ts) self-heals a transient
 * drain failure with a bounded exponential-backoff retry, and ages a poison edit
 * out to a dead-letter at a per-edit attempt cap so it can neither retry forever
 * nor be lost. drainQueue itself is impure (IDB + fetch + timers), so the decision
 * logic is factored into small pure helpers — classifyDrainResponse / nextBackoff /
 * shouldDeadLetter — which we extract from the shipped appJs bundle and run here,
 * mirroring how gui-artifact-ui.test.ts extracts mdRender. Plus toContain guards
 * that the orchestration wiring (retry timer, backoff reset, connectivity-event
 * supersede) is present.
 */
function loadDrainHelpers(): {
  classifyDrainResponse: (status: number) => 'ok' | 'deadletter' | 'transient';
  nextBackoff: (current: number) => number;
  shouldDeadLetter: (attempts: number) => boolean;
} {
  // The three pure helpers are a contiguous block prefixed by the
  // MAX_DRAIN_ATTEMPTS constant they depend on, ending where clearDrainRetry
  // (which touches a module timer) begins.
  const start = appJs.indexOf('var MAX_DRAIN_ATTEMPTS');
  const end = appJs.indexOf('function clearDrainRetry');
  if (start < 0 || end < 0 || end <= start)
    throw new Error('could not locate drain helpers in appJs');
  const slice = appJs.slice(start, end);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    `${slice}\n;return { classifyDrainResponse: classifyDrainResponse, nextBackoff: nextBackoff, shouldDeadLetter: shouldDeadLetter };`,
  ) as () => {
    classifyDrainResponse: (status: number) => 'ok' | 'deadletter' | 'transient';
    nextBackoff: (current: number) => number;
    shouldDeadLetter: (attempts: number) => boolean;
  };
  return factory();
}

describe('offline-retry drain decision helpers', () => {
  const { classifyDrainResponse, nextBackoff, shouldDeadLetter } = loadDrainHelpers();

  it('classifies a 2xx as ok (delete the edit)', () => {
    expect(classifyDrainResponse(200)).toBe('ok');
    expect(classifyDrainResponse(201)).toBe('ok');
    expect(classifyDrainResponse(204)).toBe('ok');
  });

  it('classifies a 4xx as deadletter (permanent — never retry)', () => {
    expect(classifyDrainResponse(400)).toBe('deadletter');
    expect(classifyDrainResponse(403)).toBe('deadletter');
    expect(classifyDrainResponse(404)).toBe('deadletter');
    expect(classifyDrainResponse(409)).toBe('deadletter');
  });

  it('classifies a 5xx as transient (leave pending, retry with backoff)', () => {
    expect(classifyDrainResponse(500)).toBe('transient');
    expect(classifyDrainResponse(502)).toBe('transient');
    expect(classifyDrainResponse(503)).toBe('transient');
  });

  it('treats a non-numeric/unknown status (network error) as transient', () => {
    // A network error has no HTTP status; the classifier must not dead-letter it.
    expect(classifyDrainResponse(NaN as unknown as number)).toBe('transient');
    expect(classifyDrainResponse(0)).toBe('transient');
  });

  it('nextBackoff doubles the delay and caps at 60000ms', () => {
    expect(nextBackoff(2000)).toBe(4000);
    expect(nextBackoff(4000)).toBe(8000);
    expect(nextBackoff(8000)).toBe(16000);
    expect(nextBackoff(16000)).toBe(32000);
    expect(nextBackoff(32000)).toBe(60000); // 64000 → capped
    expect(nextBackoff(60000)).toBe(60000); // stays at the cap
  });

  it('shouldDeadLetter flips true at the 8th attempt (MAX_DRAIN_ATTEMPTS)', () => {
    expect(shouldDeadLetter(0)).toBe(false);
    expect(shouldDeadLetter(7)).toBe(false);
    expect(shouldDeadLetter(8)).toBe(true);
    expect(shouldDeadLetter(9)).toBe(true);
  });
});

describe('offline-retry drain orchestration wiring', () => {
  it('schedules a setTimeout-based retry when an edit is still pending after a drain', () => {
    // A pending edit re-arms drainQueue on the bounded backoff.
    expect(appJs).toContain('setTimeout(drainQueue, drainBackoff)');
    expect(appJs).toContain('drainBackoff = nextBackoff(drainBackoff)');
  });

  it('resets the backoff to 2000 on a fully clean drain and drops any pending retry', () => {
    expect(appJs).toContain('drainBackoff = 2000');
    expect(appJs).toContain('clearDrainRetry()');
  });

  it('clears the retry timer + resets backoff on a real connectivity event before draining', () => {
    // drainNow is the connectivity-event path: clear the timer, reset backoff, drain.
    expect(appJs).toContain('function drainNow()');
    // The online listener and the cloud-reconnect path both supersede the backoff.
    expect(appJs).toContain(
      "window.addEventListener('online', function () { if (cloudConnected) drainNow(); })",
    );
    expect(appJs).toContain('if (cloudConnected && !wasConnected) drainNow();');
  });

  it('uses .unref() defensively so the retry timer never pins a process', () => {
    expect(appJs).toContain('if (t && t.unref) t.unref();');
  });

  it('only deletes an edit on a 2xx (never lost on transient/network failure)', () => {
    expect(appJs).toContain("if (verdict === 'ok') return idbDelete(it.editId);");
    // The transient/network paths persist the edit (idbPut), they never idbDelete it.
    expect(appJs).toContain('it.attempts = (it.attempts || 0) + 1;');
  });
});
