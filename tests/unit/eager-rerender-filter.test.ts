import { describe, it, expect, vi } from 'vitest';
import { wireEagerRerender } from '../../src/gui/lifecycle.js';
import type { ActiveDb } from '../../src/gui/active-db.js';
import type { RealtimePayload, RealtimePayloadHandler } from '../../src/gui/realtime.js';

/**
 * Regression for the spurious-render-on-chat bug (confirmed live: every assistant
 * message upserts `chat_messages` → __lattice_changes → NOTIFY → eager re-render).
 *
 * The eager per-viewer re-render fires on every realtime payload. Bookkeeping +
 * assistant-chat writes (chat_messages/chat_threads, every `_lattice*` table) are
 * NOT part of the rendered entity tree, so they must be filtered out — otherwise a
 * chat conversation re-renders the whole workspace on every turn, and (because the
 * file-loopback watcher defers reverse-sync while a render is in flight) starves
 * the file→DB writeback.
 *
 * This is BEHAVIORAL: it drives the real wiring through a fake realtime broker and
 * a spied requestRender — the only way to catch the regression. The prior
 * string-match flash test passed the whole time this was broken.
 */
function makeActive(): {
  active: ActiveDb;
  requestRender: ReturnType<typeof vi.fn>;
  deliver: (p: Partial<RealtimePayload>) => void;
} {
  let handler: RealtimePayloadHandler | undefined;
  const requestRender = vi.fn();
  const payload = (p: Partial<RealtimePayload>): RealtimePayload => ({
    seq: 1,
    table_name: null,
    pk: null,
    op: 'upsert',
    owner_role: null,
    created_at: '2026-06-21T00:00:00.000Z',
    ...p,
  });
  const active = {
    eagerRenderWired: false,
    realtime: {
      subscribePayload: (h: RealtimePayloadHandler): (() => void) => {
        handler = h;
        return () => undefined; // unsubscribe — unused by the test
      },
    },
    db: { requestRender },
  } as unknown as ActiveDb;
  return { active, requestRender, deliver: (p) => handler?.(payload(p)) };
}

describe('eager re-render — feed-hidden writes must not trigger a render', () => {
  it('a chat_messages / chat_threads / _lattice* NOTIFY does NOT schedule any render', () => {
    const { active, requestRender, deliver } = makeActive();
    wireEagerRerender(active);

    deliver({ table_name: 'chat_messages' });
    deliver({ table_name: 'chat_threads' });
    deliver({ table_name: '__lattice_changes' });
    deliver({ table_name: '_lattice_gui_meta' });

    // The bug: any of these fired a full render. After the filter, none do.
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('a real entity-table NOTIFY DOES schedule that table render (sharing/un-share freshness preserved)', () => {
    const { active, requestRender, deliver } = makeActive();
    wireEagerRerender(active);

    deliver({ table_name: 'client' });

    // First payload fires immediately (leading edge); scoped to the changed table.
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalledWith('client');
  });

  it('a chat write interleaved with a real change still only renders for the real table', () => {
    const { active, requestRender, deliver } = makeActive();
    wireEagerRerender(active);

    deliver({ table_name: 'chat_messages' }); // filtered
    deliver({ table_name: 'contact' }); // real

    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalledWith('contact');
  });

  it('a no-table_name change still forces a full render (the pendingFull path is preserved)', () => {
    const { active, requestRender, deliver } = makeActive();
    wireEagerRerender(active);

    deliver({ table_name: null }); // unattributed change → refresh everything

    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalledWith(); // full render = no table arg
  });
});
