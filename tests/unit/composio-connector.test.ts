import { describe, it, expect } from 'vitest';
import {
  ComposioConnector,
  registerToolkit,
  registeredToolkits,
  getToolkitSpec,
} from '../../src/connectors/composio/adapter.js';
import type { ComposioClient, ComposioActionResult } from '../../src/connectors/composio/client.js';
import type { ConnectedModelDef, ExternalRecord } from '../../src/connectors/types.js';

/**
 * 4.3 — the Composio connector drives a per-toolkit spec: it authorizes, paginates
 * fetch actions into normalized records, fails loudly on an action error, and revokes.
 * A fake ComposioClient is injected so the logic is tested without the real SDK.
 */

function fakeModel(table: string): ConnectedModelDef {
  return {
    model: 'thing',
    table,
    naturalKey: 'key',
    definition: { columns: { key: 'TEXT PRIMARY KEY' }, render: () => '', outputFile: 'x.md' },
  };
}

/** Register a 2-page fetch spec for a fake toolkit. */
function registerFakeToolkit(toolkit: string): void {
  registerToolkit({
    toolkit,
    models: [fakeModel(`${toolkit}_things`)],
    fetch: {
      thing: {
        action: 'FAKE_LIST',
        args: (cursor) => ({ cursor }),
        map: (data) => data as { records: ExternalRecord[]; nextCursor: string | null },
      },
    },
  });
}

describe('Composio connector (fake client)', () => {
  it('registers toolkits and exposes their models', () => {
    registerFakeToolkit('faketk');
    expect(registeredToolkits()).toContain('faketk');
    expect(getToolkitSpec('faketk')?.models[0]?.table).toBe('faketk_things');
    const c = new ComposioConnector(async () => ({}) as ComposioClient);
    expect(c.models('faketk')[0]?.table).toBe('faketk_things');
    expect(() => c.models('nope')).toThrow(/Unknown toolkit/);
  });

  it('authorize + completeAuth delegate to the client', async () => {
    const client: ComposioClient = {
      authorize: async () => ({ redirectUrl: 'https://auth.example/x', pendingId: 'p1' }),
      finalize: async () => ({ connectionId: 'conn_42' }),
      execute: async () => ({ data: null, successful: true }),
      revoke: async () => {},
    };
    const c = new ComposioConnector(async () => client);
    expect(await c.authorize('u1', 'faketk')).toEqual({
      redirectUrl: 'https://auth.example/x',
      pendingId: 'p1',
    });
    expect(await c.completeAuth('u1', 'faketk')).toEqual({ connectionId: 'conn_42' });
  });

  it('listChanges paginates across pages and yields all records', async () => {
    registerFakeToolkit('pagetk');
    const pages: Record<string, ComposioActionResult> = {
      null: {
        data: { records: [{ id: 'a', row: { key: 'a' } }], nextCursor: 'c2' },
        successful: true,
      },
      c2: {
        data: { records: [{ id: 'b', row: { key: 'b' } }], nextCursor: null },
        successful: true,
      },
    };
    const client: ComposioClient = {
      authorize: async () => ({ redirectUrl: '' }),
      finalize: async () => ({ connectionId: '' }),
      execute: async (_slug, input) => pages[String(input.arguments?.cursor)]!,
      revoke: async () => {},
    };
    const c = new ComposioConnector(async () => client);
    const out: string[] = [];
    for await (const rec of c.listChanges('pagetk', 'thing', { connectionId: 'x', userId: 'u' })) {
      out.push(rec.id);
    }
    expect(out).toEqual(['a', 'b']);
  });

  it('listChanges fails loudly when an action is not successful', async () => {
    registerFakeToolkit('errtk');
    const client: ComposioClient = {
      authorize: async () => ({ redirectUrl: '' }),
      finalize: async () => ({ connectionId: '' }),
      execute: async () => ({ data: null, successful: false, error: 'token expired' }),
      revoke: async () => {},
    };
    const c = new ComposioConnector(async () => client);
    await expect(async () => {
      for await (const _ of c.listChanges('errtk', 'thing', { connectionId: 'x', userId: 'u' })) {
        // drain
      }
    }).rejects.toThrow(/token expired/);
  });

  it('disconnect revokes via the client', async () => {
    let revoked = '';
    const client: ComposioClient = {
      authorize: async () => ({ redirectUrl: '' }),
      finalize: async () => ({ connectionId: '' }),
      execute: async () => ({ data: null, successful: true }),
      revoke: async (id) => {
        revoked = id;
      },
    };
    const c = new ComposioConnector(async () => client);
    await c.disconnect('conn_99');
    expect(revoked).toBe('conn_99');
  });
});
