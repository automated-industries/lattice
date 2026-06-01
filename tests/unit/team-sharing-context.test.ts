import { describe, it, expect } from 'vitest';
import {
  applySharingToContext,
  isVisibleInTeam,
  type TeamContext,
} from '../../src/gui/team-context.js';

/**
 * Pure in-place sharing/visibility updates (the path the share route + the
 * realtime broker subscription both use, so a share/unshare needs no DB
 * re-open). The cloud SQL itself is exercised manually at release time; this
 * locks down the visibility arithmetic that drives "no refresh on share".
 */
function ctx(overrides: Partial<TeamContext> = {}): TeamContext {
  return {
    teamId: 'team-1',
    myUserId: 'me',
    creatorUserId: 'creator',
    isCreator: false,
    isMember: true,
    owners: new Map(),
    shared: new Set(),
    ...overrides,
  };
}

describe('applySharingToContext', () => {
  it('makes a not-owned table visible when shared and hides it when unshared', () => {
    const c = ctx({ owners: new Map([['widgets', 'someone-else']]) });
    const valid = new Set<string>();

    applySharingToContext(c, valid, 'widgets', true);
    expect(c.shared.has('widgets')).toBe(true);
    expect(valid.has('widgets')).toBe(true);
    expect(isVisibleInTeam('widgets', c)).toBe(true);

    applySharingToContext(c, valid, 'widgets', false);
    expect(c.shared.has('widgets')).toBe(false);
    expect(valid.has('widgets')).toBe(false);
  });

  it('keeps an owned table visible even after it is unshared', () => {
    const c = ctx({ owners: new Map([['mine', 'me']]) });
    const valid = new Set<string>(['mine']);

    applySharingToContext(c, valid, 'mine', true);
    expect(valid.has('mine')).toBe(true);

    applySharingToContext(c, valid, 'mine', false);
    // Owner retains visibility regardless of sharing.
    expect(valid.has('mine')).toBe(true);
  });

  it('is idempotent for a repeated share envelope', () => {
    const c = ctx({ owners: new Map([['t', 'other']]) });
    const valid = new Set<string>();
    applySharingToContext(c, valid, 't', true);
    applySharingToContext(c, valid, 't', true);
    expect([...c.shared]).toEqual(['t']);
    expect(valid.has('t')).toBe(true);
  });
});
