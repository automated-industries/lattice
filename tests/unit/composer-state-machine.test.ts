// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderProgressJs } from '../../src/gui/app/modules/render-progress.js';
import { onboardingJs } from '../../src/gui/app/modules/onboarding.js';
import { createDatabaseWizardJs } from '../../src/gui/app/modules/create-database-wizard.js';

/**
 * The composer's send path: one action button whose state is derived (Send / Queue /
 * Stop), a queue that lives in its own tray above the composer instead of as ghost
 * bubbles in the conversation, and a submit that commits the composer BEFORE the
 * upload starts so a text+attachment send is never stuck in limbo.
 *
 * These client segments are plain declarations that run concatenated inside the app's
 * single IIFE, so they are evaluated together here and driven against a jsdom shell
 * that mirrors the real one. The wizard segment CLOSES that IIFE, so its tail
 * (`init(); })();`) is cut off before evaluation.
 */

interface Client {
  renderComposer: () => void;
  setBusy: (busy: boolean) => void;
  isBusy: () => boolean;
  enqueueChat: (text: string, files: { id: string; name: string }[] | undefined) => void;
  flushChatQueue: () => void;
  releaseComposer: () => void;
  updateComposerAction: () => void;
  queueLength: () => number;
  stageFiles: (files: unknown[]) => void;
  stagedCount: () => number;
  setUploadFiles: (fn: (files: unknown[], opts: unknown) => Promise<unknown>) => void;
  bindFakeTurn: (messageId: string) => void;
  endAllTurns: () => void;
  toasts: () => string[];
}

const WIZARD_TAIL = 'init();';

function shell(): string {
  return [
    '<div class="rail-feed" id="rail-feed"><div class="rail-empty" id="rail-empty">x</div></div>',
    '<div class="question-cards" id="question-cards"></div>',
    '<div class="staging-tray-host" id="staging-tray-host"></div>',
    '<div class="rail-composer" id="rail-composer"></div>',
  ].join('');
}

/** Stubs for the wrapper-scoped helpers the two segments call but do not declare. */
const PROLOGUE = `
  var __toasts = [];
  var feedTurnId = 0, feedTurnActive = false, feedTurnStartMs = 0;
  var cloudMode = true;
  var state = { columnMeta: {} };
  function showToast(m) { __toasts.push(String(m)); }
  function gaTrack() {}
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }
  function fetchJson() { return Promise.resolve({}); }
  function openSearchHit() {}
  function handleAutoImport() {}
  function invalidate() {}
  function bgTask() { return { done: function () {}, fail: function () {} }; }
  function ingestProgress() { return { update: function () {}, done: function () {} }; }
  function activeElement() { return null; }
  function clearIngestProgress() {}
  function anToolStatus() {}
  function anStatusThinking() {}
  function mdToHtml(s) { return String(s == null ? '' : s); }
`;

const EPILOGUE = `
  ;return {
    renderComposer: renderComposer,
    setBusy: function (b) { chatBusy = b; updateComposerAction(); },
    isBusy: function () { return chatBusy; },
    enqueueChat: enqueueChat,
    flushChatQueue: flushChatQueue,
    releaseComposer: releaseComposer,
    updateComposerAction: updateComposerAction,
    queueLength: function () { return chatQueue.length; },
    stageFiles: stageFiles,
    stagedCount: function () { return stagedFiles.length; },
    setUploadFiles: function (fn) { uploadFiles = fn; },
    bindFakeTurn: function (mid) {
      bindChatTurn({ messageId: mid, threadId: currentThreadId, actx: null, assembled: '', pendingOpen: null, done: false });
    },
    endAllTurns: function () { chatTurns = {}; releaseComposer(); },
    toasts: function () { return __toasts; },
  };
`;

function loadClient(): Client {
  const wizard = createDatabaseWizardJs.slice(0, createDatabaseWizardJs.lastIndexOf(WIZARD_TAIL));
  const src = PROLOGUE + renderProgressJs + '\n' + onboardingJs + '\n' + wizard + '\n' + EPILOGUE;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(src)() as Client;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}
let calls: FetchCall[] = [];

/** A fetch that acks every chat POST 202 and every stop 202, recording both. */
function installFetch(): void {
  calls = [];
  let n = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(
    (url: string, init?: { method?: string; body?: string }) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body ? { body: init.body } : {}),
      });
      if (url.endsWith('/stop')) {
        return Promise.resolve({
          ok: true,
          status: 202,
          headers: { get: () => null },
          json: () => Promise.resolve({ stopped: true }),
        });
      }
      n += 1;
      return Promise.resolve({
        ok: true,
        status: 202,
        headers: { get: (h: string) => (h === 'x-thread-id' ? 'thread-1' : null) },
        json: () => Promise.resolve({ threadId: 'thread-1', messageId: 'msg-' + String(n) }),
      });
    },
  );
}

interface DeferredChat {
  /** Deliver the 202 the send has been waiting on. */
  ack: (messageId: string) => void;
  /** Refuse the send before any turn is started. */
  refuse: (error: string) => void;
}

/**
 * Like installFetch, except the chat POST is HELD: its response is delivered only
 * when the test says so. That gap — the send is away, the turn is running on the
 * server, but no messageId has come back yet — is the window this file's last
 * describe block is about.
 */
function installHeldChatFetch(): DeferredChat {
  calls = [];
  let settle: ((r: unknown) => void) | null = null;
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(
    (url: string, init?: { method?: string; body?: string }) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body ? { body: init.body } : {}),
      });
      if (url.endsWith('/stop')) {
        return Promise.resolve({
          ok: true,
          status: 202,
          headers: { get: () => null },
          json: () => Promise.resolve({ stopped: true }),
        });
      }
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  );
  const deliver = (r: unknown): void => {
    const s = settle as unknown as ((v: unknown) => void) | null;
    if (!s) throw new Error('no chat POST is in flight');
    settle = null;
    s(r);
  };
  return {
    ack: (messageId) => {
      deliver({
        ok: true,
        status: 202,
        headers: { get: (h: string) => (h === 'x-thread-id' ? 'thread-1' : null) },
        json: () => Promise.resolve({ threadId: 'thread-1', messageId }),
      });
    },
    refuse: (error) => {
      deliver({
        ok: false,
        status: 400,
        headers: { get: () => null },
        json: () => Promise.resolve({ error }),
      });
    },
  };
}

const chatPosts = (): FetchCall[] => calls.filter((c) => c.url === '/api/chat');
const stopPosts = (): FetchCall[] => calls.filter((c) => c.url.endsWith('/stop'));

describe('composer action state machine', () => {
  let c: Client;
  let btn: HTMLButtonElement;
  let input: HTMLTextAreaElement;

  beforeEach(async () => {
    document.body.innerHTML = shell();
    installFetch();
    c = loadClient();
    c.renderComposer();
    await flush();
    btn = document.getElementById('chat-send') as HTMLButtonElement;
    input = document.getElementById('chat-input') as HTMLTextAreaElement;
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'fetch');
  });

  it('idle + empty composer is a disabled Send', () => {
    expect(btn.getAttribute('data-action')).toBe('send');
    expect(btn.disabled).toBe(true);
  });

  it('idle + typed text is an active Send', () => {
    input.value = 'hello';
    input.dispatchEvent(new Event('input'));
    expect(btn.getAttribute('data-action')).toBe('send');
    expect(btn.disabled).toBe(false);
  });

  it('idle + only staged files is an active Send (no text needed)', () => {
    c.stageFiles([{ name: 'a.csv', size: 4 }]);
    expect(btn.getAttribute('data-action')).toBe('send');
    expect(btn.disabled).toBe(false);
  });

  it('busy + empty composer is Stop', () => {
    c.setBusy(true);
    expect(btn.getAttribute('data-action')).toBe('stop');
    expect(btn.disabled).toBe(false);
  });

  it('busy + typed text is Queue', () => {
    c.setBusy(true);
    input.value = 'and also this';
    input.dispatchEvent(new Event('input'));
    expect(btn.getAttribute('data-action')).toBe('queue');
    expect(btn.disabled).toBe(false);
  });

  it('Stop posts to the server, because the turn runs there, not in this fetch', async () => {
    c.bindFakeTurn('msg-live');
    c.setBusy(true);
    btn.click();
    await flush();
    expect(stopPosts().map((s) => s.url)).toEqual(['/api/chat/messages/msg-live/stop']);
    expect(stopPosts()[0]?.method).toBe('POST');
  });
});

describe('queued follow-ups live in a tray above the composer', () => {
  let c: Client;

  beforeEach(async () => {
    document.body.innerHTML = shell();
    installFetch();
    c = loadClient();
    c.renderComposer();
    await flush();
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'fetch');
  });

  it('renders a queued item in the tray host, never as a bubble in the feed', () => {
    c.setBusy(true);
    c.enqueueChat('follow up', undefined);
    const rows = document.querySelectorAll('#chat-queue-host .chat-queue-item');
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain('follow up');
    // The retired surface: no dimmed placeholder bubble in the conversation.
    expect(document.querySelectorAll('#rail-feed .chat-msg.queued').length).toBe(0);
  });

  it('drains the queue when the turn ends', async () => {
    c.setBusy(true);
    c.enqueueChat('later', undefined);
    expect(c.queueLength()).toBe(1);
    c.releaseComposer(); // no bound turns → composer frees → queue drains
    await flush();
    expect(c.queueLength()).toBe(0);
    expect(chatPosts().length).toBe(1);
    expect(document.querySelectorAll('#chat-queue-host .chat-queue-item').length).toBe(0);
  });

  it('a removed queued item is dropped and never sent', async () => {
    c.setBusy(true);
    c.enqueueChat('never mind', undefined);
    document.querySelector<HTMLButtonElement>('.chat-queue-x')!.click();
    expect(c.queueLength()).toBe(0);
    c.releaseComposer();
    await flush();
    expect(chatPosts().length).toBe(0);
  });

  it('force-push stops the running turn and sends that item exactly once', async () => {
    c.bindFakeTurn('msg-live');
    c.setBusy(true);
    c.enqueueChat('first', undefined);
    c.enqueueChat('urgent', undefined);
    const pushes = document.querySelectorAll('.chat-queue-push');
    (pushes[1] as HTMLButtonElement).click(); // jump the FIFO
    await flush();
    expect(stopPosts().length).toBe(1);
    // Exactly one send, and it is the force-pushed item — the ordinary drain must
    // not also fire it when the stopped turn's release comes through.
    expect(chatPosts().length).toBe(1);
    // The force-pushed send opened a turn of its own; when THAT ends the remaining
    // item drains normally — and 'urgent' is not sent a second time.
    c.endAllTurns();
    await flush();
    expect(chatPosts().length).toBe(2);
    expect(c.queueLength()).toBe(0);
  });
});

describe('submitting text + attachments commits the composer before the upload', () => {
  let c: Client;
  let btn: HTMLButtonElement;
  let input: HTMLTextAreaElement;

  beforeEach(async () => {
    document.body.innerHTML = shell();
    installFetch();
    c = loadClient();
    c.renderComposer();
    await flush();
    btn = document.getElementById('chat-send') as HTMLButtonElement;
    input = document.getElementById('chat-input') as HTMLTextAreaElement;
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'fetch');
  });

  it('shows the user bubble and clears the box immediately, not after the ingest', async () => {
    let settle: ((v: unknown) => void) | null = null;
    c.setUploadFiles(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    c.stageFiles([{ name: 'report.csv', size: 9 }]);
    input.value = 'summarize this';
    input.dispatchEvent(new Event('input'));
    btn.click();
    await flush();
    // Mid-upload: the message is already on screen, the box is empty, the tray is gone.
    const bubble = document.querySelector('#rail-feed .chat-msg.user');
    expect(bubble).not.toBeNull();
    expect(bubble?.textContent).toContain('summarize this');
    expect(bubble?.textContent).toContain('report.csv');
    expect(input.value).toBe('');
    expect(document.getElementById('staging-tray')).toBeNull();
    // ...and it is marked as still in flight, not as a delivered message.
    expect(bubble?.classList.contains('pending')).toBe(true);
    expect(chatPosts().length).toBe(0);

    (settle as unknown as (v: unknown) => void)({
      ok: [{ id: 'f1', name: 'report.csv' }],
      failed: [],
    });
    await flush();
    expect(bubble?.classList.contains('pending')).toBe(false);
    expect(chatPosts().length).toBe(1);
  });

  it('a rejected upload restores the text and the files and marks the bubble failed', async () => {
    c.setUploadFiles(() => Promise.reject(new Error('network down')));
    c.stageFiles([{ name: 'report.csv', size: 9 }]);
    input.value = 'summarize this';
    input.dispatchEvent(new Event('input'));
    btn.click();
    await flush();
    expect(chatPosts().length).toBe(0); // never send a message without its attachment
    expect(input.value).toBe('summarize this');
    expect(c.stagedCount()).toBe(1);
    expect(document.getElementById('staging-tray')).not.toBeNull();
    const bubble = document.querySelector('#rail-feed .chat-msg.user');
    expect(bubble?.classList.contains('failed')).toBe(true);
    expect(document.querySelector('#rail-feed .chat-retry')).not.toBeNull();
    expect(c.toasts().join(' ')).toContain('tap Send to retry');
  });

  it('a files-only send carries the attachment as data, not the filename as the message', async () => {
    c.setUploadFiles(() =>
      Promise.resolve({ ok: [{ id: 'f9', name: 'invoices.xlsx' }], failed: [] }),
    );
    c.stageFiles([{ name: 'invoices.xlsx', size: 12 }]);
    btn.click(); // nothing typed
    await flush();
    const sent = JSON.parse(chatPosts()[0]?.body ?? '{}') as {
      message: string;
      attachedFiles: { id: string; name: string }[];
    };
    // The filename must NOT arrive as the user's message: read as one, a bare filename
    // is genuinely ambiguous, and the assistant answered by asking what to do with it.
    expect(sent.message).toBe('');
    expect(sent.attachedFiles).toEqual([{ id: 'f9', name: 'invoices.xlsx' }]);
  });

  it('a partly-failed batch sends nothing and names the file that did not land', async () => {
    c.setUploadFiles(() =>
      Promise.resolve({
        ok: [{ id: 'f1', name: 'a.csv' }],
        failed: [{ name: 'b.csv', error: 'too big' }],
      }),
    );
    c.stageFiles([
      { name: 'a.csv', size: 1 },
      { name: 'b.csv', size: 2 },
    ]);
    input.value = 'compare these';
    input.dispatchEvent(new Event('input'));
    btn.click();
    await flush();
    expect(chatPosts().length).toBe(0);
    expect(input.value).toBe('compare these');
    expect(c.toasts().join(' ')).toContain('b.csv');
    const bubble = document.querySelector('#rail-feed .chat-msg.user');
    expect(bubble?.classList.contains('failed')).toBe(true);
  });
});

/**
 * Stop between send and ack. The turn does not run inside the POST that starts it:
 * that request acks 202 with the messageId, and the work continues server-side. So
 * for the moment between "the button flipped to Stop" and "the ack named the turn"
 * there is nothing a stop request can address — which is exactly when an alarmed
 * user reaches for Stop. The press must not evaporate.
 */
describe('Stop pressed before the send is acknowledged', () => {
  let c: Client;
  let chat: DeferredChat;
  let btn: HTMLButtonElement;
  let input: HTMLTextAreaElement;

  beforeEach(async () => {
    document.body.innerHTML = shell();
    installFetch();
    c = loadClient();
    c.renderComposer();
    await flush();
    chat = installHeldChatFetch(); // swap in the holding fetch AFTER the composer renders
    btn = document.getElementById('chat-send') as HTMLButtonElement;
    input = document.getElementById('chat-input') as HTMLTextAreaElement;
    input.value = 'go do the big thing';
    input.dispatchEvent(new Event('input'));
    btn.click(); // send — the POST is now held
    await flush();
    expect(chatPosts().length).toBe(1);
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'fetch');
  });

  it('is remembered and delivered the moment the ack names the turn', async () => {
    expect(c.isBusy()).toBe(true);
    btn.click(); // Stop, in the window
    await flush();
    // Nothing to address it to yet — but the press is not lost, and the control does
    // not sit there looking armed as though a second press would achieve something.
    expect(stopPosts().length).toBe(0);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('Stopping');

    chat.ack('msg-late');
    await flush();
    // The intent survived the race: the turn is actually stopped.
    expect(stopPosts().map((s) => s.url)).toEqual(['/api/chat/messages/msg-late/stop']);
    expect(stopPosts()[0]?.method).toBe('POST');
    expect(document.querySelector('#rail-feed .chat-stopped')).not.toBeNull();
    expect(c.isBusy()).toBe(false);
    expect(btn.getAttribute('data-action')).toBe('send');
  });

  it('never leaves the press as a click that did nothing', async () => {
    btn.click();
    await flush();
    // The press either goes out now or is visibly pending — never neither.
    const pressRegistered = stopPosts().length > 0 || btn.disabled;
    expect(pressRegistered).toBe(true);
    btn.click(); // a second press on the pending control adds no message and no send
    await flush();
    expect(chatPosts().length).toBe(1);
  });

  it('clears the pending Stop when the send never opened a turn at all', async () => {
    btn.click();
    await flush();
    expect(btn.textContent).toContain('Stopping');
    chat.refuse('claude_unreachable');
    await flush();
    // There is nothing running to stop, so the composer comes back — it must not sit
    // on a permanent "Stopping…" that can never resolve.
    expect(stopPosts().length).toBe(0);
    expect(c.isBusy()).toBe(false);
    expect(btn.getAttribute('data-action')).toBe('send');
    expect(btn.textContent).toContain('Send');
  });

  it('holds a "send now" queue item until the stop it waits on has really landed', async () => {
    c.enqueueChat('actually do this instead', undefined);
    document.querySelector<HTMLButtonElement>('.chat-queue-push')!.click();
    await flush();
    // The turn cannot be named yet, so nothing may jump ahead of it.
    expect(stopPosts().length).toBe(0);
    expect(chatPosts().length).toBe(1);

    chat.ack('msg-late');
    await flush();
    // Stop first, then the item — in that order, not into the middle of a live turn.
    expect(stopPosts().length).toBe(1);
    expect(chatPosts().length).toBe(2);
    expect(c.queueLength()).toBe(0);
  });
});
