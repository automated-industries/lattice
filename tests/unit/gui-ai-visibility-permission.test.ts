import { describe, it, expect } from 'vitest';
import { visibilityDenialReason } from '../../src/gui/ai/dispatch.js';

/**
 * Regression: the assistant reported it had made a record "private" when it
 * lacked permission to do so (and only refused correctly on a retry). The
 * `set_visibility` tool now computes a DETERMINISTIC refusal reason — mirroring
 * the Postgres RLS owner-only enforcement — BEFORE touching the DB, so the
 * assistant relays a real failure instead of hallucinating success.
 */
describe('visibilityDenialReason (set_visibility permission gate)', () => {
  it('allows the owner to change a row it owns', () => {
    expect(visibilityDenialReason({ kind: 'row', rowAccess: { ownedByMe: true } })).toBeNull();
  });

  it('refuses changing a row the caller does NOT own', () => {
    expect(visibilityDenialReason({ kind: 'row', rowAccess: { ownedByMe: false } })).toMatch(
      /do not own this record/i,
    );
  });

  it('refuses a row that is not visible to / not found for the caller', () => {
    expect(visibilityDenialReason({ kind: 'row', rowAccess: undefined })).toMatch(
      /not found, or is not visible/i,
    );
  });

  it('allows an owner/DBA to change a table default', () => {
    expect(visibilityDenialReason({ kind: 'table', canManageTableDefault: true })).toBeNull();
  });

  it('refuses a non-owner changing a table default', () => {
    expect(visibilityDenialReason({ kind: 'table', canManageTableDefault: false })).toMatch(
      /only the workspace owner/i,
    );
  });
});
