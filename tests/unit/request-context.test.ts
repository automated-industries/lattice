import { describe, it, expect, vi } from 'vitest';
import {
  createGuiRequestContext,
  type GuiRequestContextBindings,
} from '../../src/gui/request-context.js';
import type { ActiveDb } from '../../src/gui/active-db.js';

// Minimal fake ActiveDb — only the fields buildMutationCtx reads matter
// (db / feed / softDeletable / onColumnsAdded); everything else is irrelevant
// to the request-context unit and is cast through `unknown`.
function fakeActive(overrides: Partial<ActiveDb> = {}): ActiveDb {
  return {
    db: { id: 'db' },
    feed: { id: 'feed' },
    softDeletable: new Set<string>(['files']),
    ...overrides,
  } as unknown as ActiveDb;
}

// A bindings object backed by real mutable `let`s (mirroring the handler's
// activeRef / currentWorkspaceId) plus call recorders, so tests can assert both
// state and which setters fired.
function makeBindings(initial: ActiveDb | null) {
  let activeRef: ActiveDb | null = initial;
  let workspaceId: string | null = 'ws-initial';
  const calls = {
    setActiveRef: [] as (ActiveDb | null)[],
    setLocalActive: [] as ActiveDb[],
    setWorkspaceId: [] as (string | null)[],
    startBackgroundRender: [] as ActiveDb[],
  };
  const bindings: GuiRequestContextBindings = {
    getActiveRef: () => activeRef,
    setActiveRef: (n) => {
      activeRef = n;
      calls.setActiveRef.push(n);
    },
    setLocalActive: (n) => {
      calls.setLocalActive.push(n);
    },
    getWorkspaceId: () => workspaceId,
    setWorkspaceId: (n) => {
      workspaceId = n;
      calls.setWorkspaceId.push(n);
    },
    startBackgroundRender: (a) => {
      calls.startBackgroundRender.push(a);
    },
    sessionId: 'sess-1',
  };
  return { bindings, calls };
}

describe('createGuiRequestContext', () => {
  it('active() reads the LIVE activeRef, including after a mid-request swap', () => {
    const a1 = fakeActive();
    const { bindings } = makeBindings(a1);
    const ctx = createGuiRequestContext(bindings);
    expect(ctx.active()).toBe(a1);
    const a2 = fakeActive();
    ctx.swapActive(a2);
    // The getter is live, not a captured value: active() must now return a2.
    expect(ctx.active()).toBe(a2);
  });

  it('swapActive(next) with NO workspaceId arg leaves the label untouched', () => {
    const { bindings, calls } = makeBindings(fakeActive());
    const ctx = createGuiRequestContext(bindings);
    const next = fakeActive();
    ctx.swapActive(next);
    expect(calls.setActiveRef).toEqual([next]);
    expect(calls.setLocalActive).toEqual([next]);
    expect(calls.startBackgroundRender).toEqual([next]);
    expect(calls.setWorkspaceId).toEqual([]);
  });

  it('swapActive(next, id) and swapActive(next, null) BOTH write the label', () => {
    const { bindings, calls } = makeBindings(fakeActive());
    const ctx = createGuiRequestContext(bindings);
    ctx.swapActive(fakeActive(), 'ws-2');
    ctx.swapActive(fakeActive(), null);
    // The single guard against regressing to an impl that can't tell omit from
    // pass-null: both forms must reach setWorkspaceId.
    expect(calls.setWorkspaceId).toEqual(['ws-2', null]);
  });

  it('workspaceId() reflects the live label after a labelled swap', () => {
    const { bindings } = makeBindings(fakeActive());
    const ctx = createGuiRequestContext(bindings);
    ctx.swapActive(fakeActive(), 'ws-9');
    expect(ctx.workspaceId()).toBe('ws-9');
  });

  it('buildMutationCtx(): canonical base, onColumnsAdded folded when present, no clientTs key', () => {
    const onCols = vi.fn();
    const { bindings } = makeBindings(fakeActive({ onColumnsAdded: onCols }));
    const ctx = createGuiRequestContext(bindings);
    const m = ctx.buildMutationCtx();
    expect(m.source).toBe('gui');
    expect(m.sessionId).toBe('sess-1');
    expect(m.onColumnsAdded).toBe(onCols);
    expect('clientTs' in m).toBe(false);
  });

  it('buildMutationCtx({ clientTs }) includes the clientTs key (even when undefined)', () => {
    const { bindings } = makeBindings(fakeActive());
    const ctx = createGuiRequestContext(bindings);
    expect(ctx.buildMutationCtx({ clientTs: '2026-01-01T00:00:00Z' }).clientTs).toBe(
      '2026-01-01T00:00:00Z',
    );
    expect('clientTs' in ctx.buildMutationCtx({ clientTs: undefined })).toBe(true);
  });

  it('active() throws loudly (never a silent default) when there is no active workspace', () => {
    const { bindings } = makeBindings(null);
    const ctx = createGuiRequestContext(bindings);
    expect(() => ctx.active()).toThrow(/no active workspace/);
  });
});
