import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import {
  ensureConnectorRegistry,
  createConnector,
  getConnector,
  getConnectorByToolkit,
  listConnectors,
  recordSync,
  setConnectorStatus,
  deleteConnectorRecord,
} from '../../src/connectors/registry.js';

/**
 * 4.3 — connector registry CRUD over the internal `__lattice_connectors` table.
 */
describe('connector registry (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function open(): Promise<Lattice> {
    db = new Lattice(':memory:');
    await db.init();
    return db;
  }

  it('ensure is idempotent and creates an empty registry', async () => {
    const d = await open();
    await ensureConnectorRegistry(d);
    await ensureConnectorRegistry(d); // second call must not throw
    expect(await listConnectors(d)).toEqual([]);
  });

  it('creates and reads back a connector', async () => {
    const d = await open();
    const id = await createConnector(d, {
      connector: 'composio',
      toolkit: 'jira',
      displayName: 'Atlassian Jira',
      composioConnectionId: 'conn_123',
      connectedBy: 'alice',
    });
    const rec = await getConnector(d, id);
    expect(rec).toMatchObject({
      id,
      connector: 'composio',
      toolkit: 'jira',
      displayName: 'Atlassian Jira',
      composioConnectionId: 'conn_123',
      connectedBy: 'alice',
      status: 'connected',
      lastSyncAt: null,
      lastError: null,
    });
  });

  it('looks up by toolkit, optionally scoped to the connecting identity', async () => {
    const d = await open();
    await createConnector(d, { connector: 'composio', toolkit: 'jira', connectedBy: 'alice' });
    await createConnector(d, { connector: 'composio', toolkit: 'jira', connectedBy: 'bob' });
    const anyJira = await getConnectorByToolkit(d, 'jira');
    expect(anyJira?.toolkit).toBe('jira');
    const bobJira = await getConnectorByToolkit(d, 'jira', 'bob');
    expect(bobJira?.connectedBy).toBe('bob');
    expect(await getConnectorByToolkit(d, 'slack')).toBeNull();
  });

  it('records sync success and failure', async () => {
    const d = await open();
    const id = await createConnector(d, { connector: 'composio', toolkit: 'jira' });
    await recordSync(d, id, { ok: true, at: '2026-06-23T00:00:00.000Z' });
    let rec = await getConnector(d, id);
    expect(rec?.status).toBe('connected');
    expect(rec?.lastSyncAt).toBe('2026-06-23T00:00:00.000Z');
    expect(rec?.lastError).toBeNull();

    await recordSync(d, id, { ok: false, error: 'auth expired' });
    rec = await getConnector(d, id);
    expect(rec?.status).toBe('error');
    expect(rec?.lastError).toBe('auth expired');
    // last successful sync timestamp is retained across a later failure
    expect(rec?.lastSyncAt).toBe('2026-06-23T00:00:00.000Z');
  });

  it('sets status and deletes', async () => {
    const d = await open();
    const id = await createConnector(d, { connector: 'composio', toolkit: 'jira' });
    await setConnectorStatus(d, id, 'disconnected');
    expect((await getConnector(d, id))?.status).toBe('disconnected');
    await deleteConnectorRecord(d, id);
    expect(await getConnector(d, id)).toBeNull();
  });
});
