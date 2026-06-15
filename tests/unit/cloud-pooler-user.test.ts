import { describe, it, expect } from 'vitest';
import { poolerAwareUser, mintInviteToken, redeemInviteToken } from '../../src/cloud/invite.js';

/**
 * #A — on the Supabase pooler the connection username must be `<role>.<ref>`; the
 * tenant ref lives ONLY in the connection-string username (`postgres.<ref>`),
 * never in session_user. The bug passed session_user (bare `postgres`) so the
 * minted member username lost the ref and the pooler rejected it (ENOIDENTIFIER).
 */
describe('#A poolerAwareUser — keep the Supabase pooler tenant ref', () => {
  it('appends the owner ref to the member role on a pooler host', () => {
    expect(poolerAwareUser('aws-0-us-east-1.pooler.supabase.com', 'lm_y', 'postgres.abc')).toBe(
      'lm_y.abc',
    );
  });

  it('keeps the bare role on a non-pooler host', () => {
    expect(poolerAwareUser('db.example.com', 'lm_y', 'postgres.abc')).toBe('lm_y');
    expect(poolerAwareUser('127.0.0.1', 'lm_y', 'postgres')).toBe('lm_y');
  });

  it('falls back to the bare role when the owner user carries no ref', () => {
    // session_user on the pooler returns a bare role — this is exactly the input
    // that produced the broken username; with no ref there is nothing to append.
    expect(poolerAwareUser('x.pooler.supabase.com', 'lm_y', 'postgres')).toBe('lm_y');
  });

  it('mint→redeem round-trips the pooler-corrected user into the token payload', () => {
    const coords = { host: 'x.pooler.supabase.com', port: 5432, dbname: 'postgres' };
    const user = poolerAwareUser(coords.host, 'lm_y', 'postgres.abc');
    expect(user).toBe('lm_y.abc');
    const expiresAt = new Date(Date.now() + 3_600_000);
    const token = mintInviteToken({
      coords,
      user,
      password: 'deadbeefdeadbeef',
      role: 'lm_y',
      email: 'a@b.com',
      expiresAt,
    });
    const payload = redeemInviteToken('a@b.com', token);
    expect(payload.user).toBe('lm_y.abc'); // the suffix survives mint→redeem
  });
});
