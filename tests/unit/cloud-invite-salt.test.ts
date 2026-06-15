/**
 * #4.10 — the invite-audit email hash is salted. `hashInviteEmail` peppers the
 * SHA-256 with a per-cloud salt (so a bare rainbow table doesn't recover emails)
 * while staying a STABLE lookup key (same salt + email → same hash, for re-invite
 * + orphan cleanup). Pure-function unit test — no DB needed.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { hashInviteEmail } from '../../src/cloud/settings.js';

describe('#4.10 hashInviteEmail', () => {
  it('is deterministic for the same salt + email (stable lookup key)', () => {
    expect(hashInviteEmail('s4lt', 'a@b.com')).toBe(hashInviteEmail('s4lt', 'a@b.com'));
  });
  it('normalizes case + surrounding whitespace', () => {
    expect(hashInviteEmail('s4lt', '  A@B.COM ')).toBe(hashInviteEmail('s4lt', 'a@b.com'));
  });
  it('differs by salt (a bare unsalted SHA-256 would collide across clouds)', () => {
    expect(hashInviteEmail('salt-A', 'a@b.com')).not.toBe(hashInviteEmail('salt-B', 'a@b.com'));
  });
  it('differs by email', () => {
    expect(hashInviteEmail('s4lt', 'a@b.com')).not.toBe(hashInviteEmail('s4lt', 'c@d.com'));
  });
  it('is NOT the unsalted hash (the salt actually peppers the digest)', () => {
    const unsalted = createHash('sha256').update('a@b.com').digest('hex');
    expect(hashInviteEmail('s4lt', 'a@b.com')).not.toBe(unsalted);
  });
});
