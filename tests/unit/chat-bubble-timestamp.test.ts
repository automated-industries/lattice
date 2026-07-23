// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderProgressJs } from '../../src/gui/app/modules/render-progress.js';
import { onboardingJs } from '../../src/gui/app/modules/onboarding.js';
import { chatCss } from '../../src/gui/app/styles/chat.js';

/**
 * A replayed chat bubble must carry a relative timestamp so an older reply reads
 * as older on reload (not indistinguishable from a fresh one). relTime lives in
 * render-progress; the bubble factories (which now call stampBubble) in onboarding.
 * Both fragments are pure declarations (they run concatenated in the app's one
 * IIFE), so eval them together and drive the factories against a jsdom #rail-feed.
 */
interface Factories {
  appendUserBubble: (text: string, files: string[] | undefined, createdAt?: string) => void;
  newAssistantBubble: (createdAt?: string) => { bubble: HTMLElement; msg: HTMLElement };
}
function loadFactories(): Factories {
  const src =
    renderProgressJs +
    '\n' +
    onboardingJs +
    '\n;return { appendUserBubble: appendUserBubble, newAssistantBubble: newAssistantBubble };';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(src)() as Factories;
}

describe('chat bubble relative timestamp', () => {
  let f: Factories;
  beforeEach(() => {
    document.body.innerHTML = '<div id="rail-feed"></div>';
    f = loadFactories();
  });

  it('stamps a replayed user bubble ~26h old with a day-relative time', () => {
    const iso = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    f.appendUserBubble('yesterday note', [], iso);
    const time = document.querySelector('#rail-feed .chat-msg.user .chat-time');
    expect(time).not.toBeNull(); // pre-fix the factories append no .chat-time
    expect(time?.textContent).toMatch(/day/);
  });

  it('stamps a replayed assistant bubble ~3h old with an "h ago" time', () => {
    const iso = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    f.newAssistantBubble(iso);
    const time = document.querySelector('#rail-feed .chat-msg.assistant .chat-time');
    expect(time).not.toBeNull();
    expect(time?.textContent).toMatch(/h ago/);
  });

  it('a live bubble (no timestamp) reads as just now', () => {
    f.appendUserBubble('hi', []);
    const time = document.querySelector('#rail-feed .chat-msg.user .chat-time');
    expect(time).not.toBeNull();
    expect(time?.textContent).toMatch(/s ago|m ago/);
  });
});

describe('chat bubble layout scoping', () => {
  it('wraps only non-queued bubbles, so a queued follow-up tag stays beside its bubble', () => {
    // The timestamp needs the row to wrap (the full-width .chat-time drops beneath
    // the bubble); a queued follow-up carries no timestamp and must NOT wrap, or its
    // "queued" tag drops below the bubble instead of sitting beside it. So flex-wrap
    // must be scoped to :not(.queued) and never live on the shared .chat-msg base.
    expect(chatCss).toContain('.chat-msg:not(.queued) { flex-wrap: wrap; }');
    expect(chatCss).toContain(
      '.chat-msg { display: flex; animation: feedIn var(--dur-2) ease-out; }',
    );
  });
});
