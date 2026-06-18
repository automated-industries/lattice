/**
 * Render-cursor freshness comparison — the unit-testable core of the open-time
 * staleness gate.
 *
 * `cursorIsFresh(recorded, live)` decides whether the open render can be SKIPPED.
 * It must be conservative (fail open): skip ONLY when the template version matches
 * AND every cursor field proves nothing newer appeared. These tests pin that
 * contract, including the per-viewer case the full Postgres member harness covers
 * end-to-end (case 3): a change-log row OR a sharing-graph row newer than the
 * recorded mark must read as STALE, while an unchanged state reads as FRESH.
 */
import { describe, it, expect } from 'vitest';
import { cursorIsFresh } from '../../src/lifecycle/render-cursor.js';
import { TEMPLATE_VERSION, type RenderCursor } from '../../src/lifecycle/manifest.js';

const cur = (o: Partial<RenderCursor>): RenderCursor => ({
  changelog: null,
  grants: null,
  owners: null,
  ...o,
});

describe('cursorIsFresh', () => {
  it('FRESH: matching template version + identical non-null marks', () => {
    const recorded = { templateVersion: TEMPLATE_VERSION, cursor: cur({ changelog: '5' }) };
    expect(cursorIsFresh(recorded, cur({ changelog: '5' }))).toBe(true);
  });

  it('FRESH: a local DB with no sharing graph (grants/owners null on both sides)', () => {
    const recorded = {
      templateVersion: TEMPLATE_VERSION,
      cursor: cur({ changelog: '00000000000000000010' }),
    };
    expect(cursorIsFresh(recorded, cur({ changelog: '00000000000000000010' }))).toBe(true);
  });

  it('STALE: a newer change-log mark (a plain edit OR a per-viewer derived observation)', () => {
    const recorded = {
      templateVersion: TEMPLATE_VERSION,
      cursor: cur({ changelog: '00000000000000000005' }),
    };
    // live changelog advanced → must render (this is what catches an in-place edit
    // on a table with no updated_at, and a member-visible derived observation).
    expect(cursorIsFresh(recorded, cur({ changelog: '00000000000000000006' }))).toBe(false);
  });

  it('STALE: a sharing digest that ROSE (a new share visible to the member)', () => {
    const recorded = {
      templateVersion: TEMPLATE_VERSION,
      cursor: cur({ changelog: '5', grants: '2#t1', owners: '2#t1' }),
    };
    // The member-visible feed digest grew (a share added a visible row) → render.
    expect(cursorIsFresh(recorded, cur({ changelog: '5', grants: '3#t2', owners: '3#t2' }))).toBe(
      false,
    );
  });

  it('STALE: a sharing digest that FELL (an un-share — a row left the member view)', () => {
    const recorded = {
      templateVersion: TEMPLATE_VERSION,
      cursor: cur({ changelog: '5', grants: '3#t2', owners: '3#t2' }),
    };
    // The digest dropped (un-share removed a previously-visible row). A monotonic
    // `<=` would WRONGLY accept this as fresh; equality correctly flags it stale.
    expect(cursorIsFresh(recorded, cur({ changelog: '5', grants: '2#t2', owners: '2#t2' }))).toBe(
      false,
    );
  });

  it('FRESH: an identical sharing digest (no share/un-share since the render)', () => {
    const recorded = {
      templateVersion: TEMPLATE_VERSION,
      cursor: cur({ changelog: '5', grants: '2#t1', owners: '2#t1' }),
    };
    expect(cursorIsFresh(recorded, cur({ changelog: '5', grants: '2#t1', owners: '2#t1' }))).toBe(
      true,
    );
  });

  it('STALE: template-version mismatch (render output format changed)', () => {
    const recorded = { templateVersion: TEMPLATE_VERSION + 1, cursor: cur({ changelog: '5' }) };
    expect(cursorIsFresh(recorded, cur({ changelog: '5' }))).toBe(false);
  });

  it('STALE (fail-open): a missing manifest', () => {
    expect(cursorIsFresh(null, cur({ changelog: '5' }))).toBe(false);
  });

  it('STALE (fail-open): a manifest with no recorded cursor', () => {
    expect(cursorIsFresh({ templateVersion: TEMPLATE_VERSION }, cur({ changelog: '5' }))).toBe(
      false,
    );
  });

  it('STALE (fail-open): a manifest with no recorded template version', () => {
    expect(cursorIsFresh({ cursor: cur({ changelog: '5' }) }, cur({ changelog: '5' }))).toBe(false);
  });

  it('STALE (fail-open): live changelog unreadable now but was recorded', () => {
    const recorded = { templateVersion: TEMPLATE_VERSION, cursor: cur({ changelog: '5' }) };
    // changelog null live (couldn't read) but non-null recorded → can't prove
    // unchanged → render.
    expect(cursorIsFresh(recorded, cur({ changelog: null }))).toBe(false);
  });

  it('STALE (fail-open): a field appeared live that was not recorded', () => {
    const recorded = { templateVersion: TEMPLATE_VERSION, cursor: cur({ changelog: '5' }) };
    // grants null recorded but non-null live (sharing graph now readable) → render.
    expect(cursorIsFresh(recorded, cur({ changelog: '5', grants: '1' }))).toBe(false);
  });

  it('FRESH: a changelog mark strictly OLDER than recorded is still fresh (never newer)', () => {
    // The MONOTONIC changelog field: a reduced live mark cannot mean "newer data";
    // the safe-skip rule is "nothing newer appeared", so live <= recorded is fresh.
    // (Contrast the sharing digest, which must match exactly.)
    const recorded = {
      templateVersion: TEMPLATE_VERSION,
      cursor: cur({ changelog: '00000000000000000010' }),
    };
    expect(cursorIsFresh(recorded, cur({ changelog: '00000000000000000009' }))).toBe(true);
  });
});
