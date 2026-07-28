// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderProgressJs } from '../../src/gui/app/modules/render-progress.js';
import { onboardingJs } from '../../src/gui/app/modules/onboarding.js';

/**
 * Chat timestamps have to keep counting. relTime() was always correct, but nothing
 * ever re-ran it: the label was written once at append time, and a live send passes no
 * timestamp — so every message in an open conversation read "0s ago" forever, no matter
 * how long ago it was actually sent. The fix is a machine-readable stamp on the node
 * plus one shared ticker that rewrites every stamped label.
 */

interface Ticker {
  appendUserBubble: (text: string, files: string[] | undefined, createdAt?: string) => Element;
  newAssistantBubble: (createdAt?: string) => { bubble: HTMLElement; msg: HTMLElement };
  stampRelTime: (el: Element, iso: string) => void;
  tickRelTimes: () => number;
  startRelTimeTicker: () => void;
  relTimeTickMs: () => number;
}

function load(): Ticker {
  const src =
    renderProgressJs +
    '\n' +
    onboardingJs +
    '\n;return {' +
    ' appendUserBubble: appendUserBubble,' +
    ' newAssistantBubble: newAssistantBubble,' +
    ' stampRelTime: stampRelTime,' +
    ' tickRelTimes: tickRelTimes,' +
    ' startRelTimeTicker: startRelTimeTicker,' +
    ' relTimeTickMs: function () { return REL_TIME_TICK_MS; }' +
    '};';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(src)() as Ticker;
}

describe('chat timestamps keep counting', () => {
  let t: Ticker;
  beforeEach(() => {
    document.body.innerHTML = '<div id="rail-feed"></div>';
    t = load();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps the node with a machine-readable time, not just a rendered label', () => {
    const iso = new Date().toISOString();
    t.appendUserBubble('hi', [], iso);
    const el = document.querySelector('#rail-feed .chat-time');
    expect(el?.getAttribute('data-ts')).toBe(iso);
  });

  it('a live send starts at "0s ago" and advances when the ticker runs', () => {
    const start = new Date('2026-07-26T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    t.appendUserBubble('live message', []);
    const el = document.querySelector('#rail-feed .chat-time');
    expect(el?.textContent).toBe('0s ago');
    vi.setSystemTime(start + 3 * 60 * 1000);
    // Pre-fix nothing recomputes this and it stays frozen at "0s ago".
    expect(t.tickRelTimes()).toBe(1);
    expect(el?.textContent).toBe('3m ago');
  });

  it('advances an assistant bubble the same way', () => {
    const start = new Date('2026-07-26T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    t.newAssistantBubble();
    vi.setSystemTime(start + 2 * 3600 * 1000);
    t.tickRelTimes();
    const el = document.querySelector('#rail-feed .chat-msg.assistant .chat-time');
    expect(el?.textContent).toBe('2h ago');
  });

  it('rewrites every stamped node, including ones outside the conversation feed', () => {
    const start = new Date('2026-07-26T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const card = document.createElement('div');
    card.className = 'feed-time';
    document.body.appendChild(card);
    t.stampRelTime(card, new Date(start).toISOString());
    expect(card.textContent).toBe('0s ago');
    vi.setSystemTime(start + 45 * 1000);
    t.tickRelTimes();
    expect(card.textContent).toBe('45s ago');
  });

  it('runs one shared interval rather than a timer per bubble', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    t.startRelTimeTicker();
    t.startRelTimeTicker(); // idempotent — a second boot must not double it
    expect(spy).toHaveBeenCalledTimes(1);
    expect(t.relTimeTickMs()).toBeGreaterThan(0);
    const start = new Date('2026-07-26T12:00:00.000Z').getTime();
    vi.setSystemTime(start);
    t.appendUserBubble('tick me', []);
    const el = document.querySelector('#rail-feed .chat-time');
    vi.setSystemTime(start + 90 * 1000);
    vi.advanceTimersByTime(t.relTimeTickMs());
    expect(el?.textContent).toBe('2m ago');
    spy.mockRestore();
  });
});
