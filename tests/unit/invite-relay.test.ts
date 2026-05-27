import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InviteRelayError,
  publishInviteEnvelope,
  resolveInviteEnvelope,
} from '../../src/teams/invite-relay.js';

describe('invite-relay client', () => {
  let prevPublish: string | undefined;
  let prevBase: string | undefined;

  beforeEach(() => {
    prevPublish = process.env.LATTICE_INVITE_PUBLISH;
    prevBase = process.env.LATTICE_INVITE_RELAY_BASE;
    // Use a sentinel that fetch won't actually hit.
    process.env.LATTICE_INVITE_RELAY_BASE = 'https://relay.example.test';
  });

  afterEach(() => {
    if (prevPublish === undefined) delete process.env.LATTICE_INVITE_PUBLISH;
    else process.env.LATTICE_INVITE_PUBLISH = prevPublish;
    if (prevBase === undefined) delete process.env.LATTICE_INVITE_RELAY_BASE;
    else process.env.LATTICE_INVITE_RELAY_BASE = prevBase;
    vi.unstubAllGlobals();
  });

  it('publishInviteEnvelope swallows fetch errors silently', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network down')));
    await expect(
      publishInviteEnvelope({
        rawToken: 'latinv_x',
        email: 'alice@example.test',
        cloudUrl: 'postgres://example.test/db',
        teamId: '00000000-0000-0000-0000-000000000001',
        teamName: 'Test Team',
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it('publishInviteEnvelope skipped entirely when LATTICE_INVITE_PUBLISH=off', async () => {
    process.env.LATTICE_INVITE_PUBLISH = 'off';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await publishInviteEnvelope({
      rawToken: 'latinv_x',
      email: 'alice@example.test',
      cloudUrl: 'postgres://example.test/db',
      teamId: '00000000-0000-0000-0000-000000000001',
      teamName: 'Test Team',
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolveInviteEnvelope throws InviteRelayError on 404', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_invite' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(
      resolveInviteEnvelope('latinv_abc', 'alice@example.test'),
    ).rejects.toBeInstanceOf(InviteRelayError);
  });

  it('resolveInviteEnvelope returns the cloud URL + team metadata on 200', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            cloud_url: 'postgres://example.test/db',
            team_id: '00000000-0000-0000-0000-000000000001',
            team_name: 'Test Team',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const result = await resolveInviteEnvelope('latinv_abc', 'alice@example.test');
    expect(result.cloud_url).toBe('postgres://example.test/db');
    expect(result.team_name).toBe('Test Team');
  });

  it('resolveInviteEnvelope refuses non-https relay URLs unless LATTICE_DEV=1', async () => {
    process.env.LATTICE_INVITE_RELAY_BASE = 'http://relay.example.test';
    delete process.env.LATTICE_DEV;
    await expect(
      resolveInviteEnvelope('latinv_x', 'alice@example.test'),
    ).rejects.toThrow(/non-https/i);
  });
});
