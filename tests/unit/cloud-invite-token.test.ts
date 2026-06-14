import { describe, it, expect } from 'vitest';
import {
  mintInviteToken,
  redeemInviteToken,
  poolerAwareUser,
  normalizeEmail,
  type MintInput,
} from '../../src/cloud/invite.js';
import { assertScopedMemberRole } from '../../src/cloud/members.js';

function baseInput(overrides: Partial<MintInput> = {}): MintInput {
  return {
    coords: { host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, dbname: 'postgres' },
    user: 'lm_alice_abc123.projref',
    password: '0123456789abcdef0123456789abcdef',
    role: 'lm_alice_abc123',
    email: 'Alice@Example.com',
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    ...overrides,
  };
}

describe('3.1 — email-bound invite token (mint/redeem)', () => {
  it('round-trips: redeem with the bound email returns the same credential', () => {
    const token = mintInviteToken(baseInput());
    const p = redeemInviteToken('alice@example.com', token); // different casing on purpose
    expect(p.user).toBe('lm_alice_abc123.projref');
    expect(p.password).toBe('0123456789abcdef0123456789abcdef');
    expect(p.host).toBe('aws-1-us-east-1.pooler.supabase.com');
    expect(p.role).toBe('lm_alice_abc123');
    expect(p.email).toBe('alice@example.com');
  });

  it('rejects redemption with the WRONG email (GCM tag fails — email binding)', () => {
    const token = mintInviteToken(baseInput());
    expect(() => redeemInviteToken('mallory@example.com', token)).toThrow(
      /does not match this email|corrupt/i,
    );
  });

  it('rejects an expired token', () => {
    const token = mintInviteToken(baseInput({ expiresAt: new Date(Date.now() - 1000) }));
    expect(() => redeemInviteToken('alice@example.com', token)).toThrow(/expired/i);
  });

  it('rejects a tampered token (flipped ciphertext byte)', () => {
    const buf = Buffer.from(mintInviteToken(baseInput()), 'base64url');
    buf[buf.length - 20] ^= 0xff;
    expect(() => redeemInviteToken('alice@example.com', buf.toString('base64url'))).toThrow(
      /does not match this email|corrupt|malformed/i,
    );
  });

  it('rejects a malformed token', () => {
    expect(() => redeemInviteToken('alice@example.com', 'not-a-real-token')).toThrow(
      /malformed|corrupt|does not match/i,
    );
  });

  it('two mints of the same input produce different tokens (random salt/secret/nonce)', () => {
    expect(mintInviteToken(baseInput())).not.toBe(mintInviteToken(baseInput()));
  });

  it('requires an email to mint', () => {
    expect(() => mintInviteToken(baseInput({ email: '   ' }))).toThrow(/email/i);
  });
});

describe('3.1 — poolerAwareUser', () => {
  it('appends the project ref for a Supabase pooler host', () => {
    expect(
      poolerAwareUser('aws-1-us-east-1.pooler.supabase.com', 'lm_bob', 'postgres.abcdefref'),
    ).toBe('lm_bob.abcdefref');
  });
  it('keeps the bare role for a non-pooler host', () => {
    expect(poolerAwareUser('db.example.com', 'lm_bob', 'postgres.abcdefref')).toBe('lm_bob');
  });
  it('falls back to the bare role when the owner user has no ref', () => {
    expect(poolerAwareUser('x.pooler.supabase.com', 'lm_bob', 'postgres')).toBe('lm_bob');
  });
});

describe('3.1 — normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
});

function roleDb(attrs: Record<string, unknown> | null) {
  return {
    getDialect: () => 'postgres',
    adapter: { getAsync: () => Promise.resolve(attrs) },
  } as never;
}

describe('3.1 — assertScopedMemberRole (mint refuses privileged/owner roles)', () => {
  it('accepts a freshly scoped non-privileged role', async () => {
    await expect(
      assertScopedMemberRole(
        roleDb({ rolsuper: false, rolcreaterole: false, rolbypassrls: false, is_self: false }),
        'lm_x',
      ),
    ).resolves.toBeUndefined();
  });
  it('refuses a superuser', async () => {
    await expect(
      assertScopedMemberRole(roleDb({ rolsuper: true, is_self: false }), 'postgres'),
    ).rejects.toThrow(/privileged/i);
  });
  it('refuses CREATEROLE', async () => {
    await expect(
      assertScopedMemberRole(roleDb({ rolcreaterole: true, is_self: false }), 'owner'),
    ).rejects.toThrow(/privileged/i);
  });
  it('refuses BYPASSRLS', async () => {
    await expect(
      assertScopedMemberRole(roleDb({ rolbypassrls: true, is_self: false }), 'bypass'),
    ).rejects.toThrow(/privileged/i);
  });
  it('refuses the cloud owner (connecting role)', async () => {
    await expect(
      assertScopedMemberRole(
        roleDb({ rolsuper: false, rolcreaterole: false, rolbypassrls: false, is_self: true }),
        'me',
      ),
    ).rejects.toThrow(/owner/i);
  });
  it('refuses a non-existent role', async () => {
    await expect(assertScopedMemberRole(roleDb(null), 'ghost')).rejects.toThrow(/does not exist/i);
  });
});
