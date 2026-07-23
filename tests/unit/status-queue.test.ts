// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { statusIndicatorJs } from '../../src/gui/app/modules/status-indicator.js';

/**
 * 4.3 — the single top-right status indicator. Exactly ONE status shows at a time
 * (highest priority, ties → most recent); a still-active lower-priority status
 * resumes when the higher one clears; non-sticky statuses auto-expire.
 */

interface StatusApi {
  setStatus: (o: Record<string, unknown>) => void;
  clearStatus: (id: string) => void;
}

function loadStatus(): StatusApi {
  const w = globalThis as unknown as Record<string, unknown>;
  w.escapeHtml = (s: unknown): string => String(s);
  // Indirect eval defines the status functions on the (jsdom) global scope.
  (0, eval)(statusIndicatorJs);
  return {
    setStatus: w.setStatus as StatusApi['setStatus'],
    clearStatus: w.clearStatus as StatusApi['clearStatus'],
  };
}
const statusEl = (): HTMLElement | null => document.getElementById('app-status');

describe('status indicator queue', () => {
  beforeEach(() => {
    // The indicator mounts into the header status slot (the tab strip that used to
    // host it was removed); seed that slot so the factory has a home to render into.
    document.body.innerHTML = '<span id="header-status-slot"></span>';
  });

  it('shows exactly one — the highest priority', () => {
    const { setStatus } = loadStatus();
    setStatus({ id: 'a', text: 'low', priority: 10, sticky: true });
    setStatus({ id: 'b', text: 'high', priority: 50, sticky: true });
    expect(statusEl()!.hidden).toBe(false);
    expect(statusEl()!.textContent).toContain('high');
  });

  it('resumes a still-active lower-priority status when the higher clears', () => {
    const { setStatus, clearStatus } = loadStatus();
    setStatus({ id: 'a', text: 'low', priority: 10, sticky: true });
    setStatus({ id: 'b', text: 'high', priority: 50, sticky: true });
    clearStatus('b');
    expect(statusEl()!.hidden).toBe(false);
    expect(statusEl()!.textContent).toContain('low');
  });

  it('hides once everything is cleared', () => {
    const { setStatus, clearStatus } = loadStatus();
    setStatus({ id: 'a', text: 'x', priority: 10, sticky: true });
    clearStatus('a');
    expect(statusEl()!.hidden).toBe(true);
  });

  it('breaks priority ties by most-recent', () => {
    const { setStatus } = loadStatus();
    setStatus({ id: 'a', text: 'first', priority: 10, sticky: true });
    setStatus({ id: 'b', text: 'second', priority: 10, sticky: true });
    expect(statusEl()!.textContent).toContain('second');
  });

  it('auto-clears a non-sticky status after its ttl', async () => {
    const { setStatus } = loadStatus();
    setStatus({ id: 'a', text: 'transient', priority: 10, ttl: 20 });
    expect(statusEl()!.textContent).toContain('transient');
    await new Promise((r) => setTimeout(r, 45));
    expect(statusEl()!.hidden).toBe(true);
  });
});
