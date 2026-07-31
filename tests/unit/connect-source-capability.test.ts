import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import {
  connectSource,
  connectDatabaseSource,
  reconnectDatabaseSource,
  refreshStaleSources,
  completeMcpConnection,
  mcpConnectionLabel,
} from '../../src/ops/connect-source.js';
import { connectorErrorCode } from '../../src/ops/connector-errors.js';
import { listConnectors, createConnector, getConnector } from '../../src/connectors/registry.js';
import { DatabaseConnector, setDbSourceCreds } from '../../src/connectors/db-source/connector.js';
import { setSchemaDescriptor } from '../../src/connectors/db-source/schema-cache.js';
import { runConnectorCommand } from '../../src/cli-connector.js';
import type {
  Connector,
  ConnectedModelDef,
  ExternalRecord,
  McpConnector,
  McpBeginResult,
} from '../../src/connectors/types.js';

/**
 * Attaching an external source, with no server anywhere.
 *
 * The claim under test is not "a function exists". It is that the whole connect
 * really happens from one call — the source is validated, a registry row is
 * written, its tables are defined, and the first import lands — and that the two
 * ways it can fail stay told apart. That distinction is the reason this file
 * exists at all: a setup failure must leave NOTHING behind, and an import failure
 * must leave EVERYTHING behind, in an error state, with the id of what it left so
 * the caller can retry or remove it. Collapsing the two is how a half-made
 * connection goes unnoticed, and how rows that imported get silently wiped.
 *
 * Nothing here reaches a real database or a real MCP server: the connector is the
 * seam, and every layer below it — the registry, the sync engine, the teardown —
 * is the real one.
 */

const MODELS: ConnectedModelDef[] = [
  {
    model: 'thing',
    table: 'cap_things',
    naturalKey: 'tid',
    definition: {
      columns: { tid: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      primaryKey: 'tid',
      source: {
        connector: 'fake',
        toolkit: 'demo',
        model: 'thing',
        naturalKey: 'tid',
        defaultVisibility: 'private',
      },
      render: () => '',
      outputFile: 'd.md',
    },
  },
];

/** A credential source: it validates what it is given, then yields one record. */
class FakeCredentialConnector implements Connector {
  readonly connector = 'fake';
  readonly revoked: string[] = [];
  toolkits() {
    return ['demo'];
  }
  models() {
    return MODELS;
  }
  presentation() {
    return { label: 'Demo' };
  }
  credentialFields() {
    return [
      { key: 'site', label: 'Site', type: 'text' as const, required: true },
      { key: 'note', label: 'Note', type: 'text' as const, required: false },
    ];
  }
  authorize() {
    return Promise.resolve({ redirectUrl: 'https://auth.example/go' });
  }
  completeAuth() {
    return Promise.resolve({ connectionId: 'conn-1' });
  }
  connect(creds: Record<string, string>) {
    if (!/^https?:\/\//i.test(creds.site ?? '')) {
      return Promise.reject(new Error('site must be a full URL'));
    }
    return Promise.resolve({ connectionId: 'conn-1', displayName: 'Demo' });
  }
  disconnect(id: string) {
    this.revoked.push(id);
    return Promise.resolve();
  }
  async *listChanges(): AsyncIterable<ExternalRecord> {
    yield { id: 'T1', row: { tid: 'T1', name: 'one' } };
  }
}

/** An MCP source whose server always wants a person to approve it. */
class ApprovalMcpConnector implements McpConnector {
  readonly connector = 'mcp';
  lastOpts: Record<string, unknown> | undefined;
  toolkits() {
    return ['mcp'];
  }
  models() {
    return MODELS;
  }
  presentation() {
    return { label: 'MCP' };
  }
  mcpServers() {
    return [{ id: 'srv' }];
  }
  beginConnect(
    _userId: string,
    _toolkit: string,
    opts?: Record<string, unknown>,
  ): Promise<McpBeginResult> {
    this.lastOpts = opts;
    return Promise.resolve({
      kind: 'redirect',
      redirectUrl: 'https://server.example/authorize?x=1',
      pendingId: 'pending-1',
    });
  }
  completeConnect() {
    return Promise.resolve({ connectionId: 'mcp-conn-1', displayName: null });
  }
  authorize() {
    return Promise.resolve({ redirectUrl: 'https://server.example/authorize' });
  }
  completeAuth() {
    return Promise.resolve({ connectionId: 'mcp-conn-1' });
  }
  disconnect() {
    return Promise.resolve();
  }
  async *listChanges(): AsyncIterable<ExternalRecord> {
    yield { id: 'M1', row: { tid: 'M1', name: 'mcp' } };
  }
}

const DESCRIPTOR = {
  dialect: 'postgres',
  schema: 'public',
  prefix: 'shop',
  tables: [
    {
      name: 'authors',
      columns: [
        { name: 'id', sqlSpec: 'TEXT' as const },
        { name: 'name', sqlSpec: 'TEXT' as const },
      ],
      pk: ['id'],
      selected: true,
    },
  ],
};

/** A database that connects, introspects, and imports one row. */
class FakeDb extends DatabaseConnector {
  constructor(private readonly id: string) {
    super(() => 'postgres://u:p@example.invalid:5432/db');
  }
  connect(): Promise<{ connectionId: string; displayName: string | null }> {
    setDbSourceCreds(this.id, 'postgres://u:p@example.invalid:5432/db');
    setSchemaDescriptor(this.id, DESCRIPTOR);
    return Promise.resolve({ connectionId: this.id, displayName: 'shopdb' });
  }
  reconnect(id: string): Promise<{ connectionId: string; displayName: string | null }> {
    setDbSourceCreds(id, 'postgres://u:newpass@example.invalid:5432/db');
    return Promise.resolve({ connectionId: id, displayName: 'shopdb' });
  }
  async *listChanges(): AsyncIterable<ExternalRecord> {
    yield { id: 'a1', row: { id: 'a1', name: 'Ada' } };
  }
}

/** A database whose import throws — the failure that must KEEP the connection. */
class ExplodingDb extends FakeDb {
  // eslint-disable-next-line require-yield
  async *listChanges(): AsyncIterable<ExternalRecord> {
    throw new Error('import exploded');
  }
}

/**
 * A database whose SETUP throws — the failure that must leave NOTHING behind.
 *
 * It throws ONCE, so the rollback that follows can still read the models it needs
 * to tear the half-made connection down. A permanent throw would exercise the
 * "cleanup also failed" branch instead, which is a different claim.
 */
class UnsetupableDb extends FakeDb {
  private thrown = false;
  models(toolkit: string): ConnectedModelDef[] {
    if (!this.thrown) {
      this.thrown = true;
      throw new Error('descriptor is unreadable');
    }
    return super.models(toolkit);
  }
}

let db: Lattice;
let tmp: string;
let cfgDir: string;
/**
 * The machine-local store is redirected to a scratch directory, because
 * connecting a source WRITES credentials to it. A test that used the real one
 * would leave connection strings on whoever ran it.
 */
const savedConfigDir = process.env.LATTICE_CONFIG_DIR;
const savedRoot = process.env.LATTICE_ROOT;

/**
 * Put a variable back exactly as it was — ABSENT if it was absent. Restoring an
 * unset variable to an empty string is not the same thing: an empty path reads as
 * "use the current directory", so the next test in this worker would write the
 * machine store into the repo.
 */
function restoreEnv(key: string, was: string | undefined): void {
  if (was === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = was;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'connect-source-'));
  cfgDir = mkdtempSync(join(tmpdir(), 'connect-source-cfg-'));
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ROOT = join(tmp, '.lattice');
  db = new Lattice(join(tmp, 'app.db'));
  await db.init();
});

afterEach(() => {
  db.close();
  restoreEnv('LATTICE_CONFIG_DIR', savedConfigDir);
  restoreEnv('LATTICE_ROOT', savedRoot);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

describe('connecting a source without a server', () => {
  it('a credential source connects, records itself, and imports on the same call', async () => {
    const impl = new FakeCredentialConnector();
    const out = await connectSource(db, impl, 'demo', 'tester', {
      kind: 'credential',
      credentials: { site: 'https://example.test', note: '  ' },
    });
    expect(out.kind).toBe('connected');
    if (out.kind !== 'connected') return;

    // The registry knows about it…
    const rows = await listConnectors(db, 'tester');
    expect(rows.map((r) => r.id)).toEqual([out.connectorId]);
    expect(rows[0]?.status).toBe('connected');
    // …and the rows really landed, from this one call.
    expect(out.result.upserted.cap_things).toBe(1);
    const stored = await db.query('cap_things', {});
    expect(stored).toHaveLength(1);
    expect((stored[0] as { tid: string }).tid).toContain('T1');
    expect((stored[0] as { name: string }).name).toBe('one');
  });

  it('a blank required field is refused before the source is contacted', async () => {
    const impl = new FakeCredentialConnector();
    let contacted = false;
    impl.connect = () => {
      contacted = true;
      return Promise.resolve({ connectionId: 'x', displayName: null });
    };
    const err = await connectSource(db, impl, 'demo', 'tester', {
      kind: 'credential',
      credentials: { site: '   ' },
    }).catch((e: unknown) => e);
    expect(connectorErrorCode(err)).toBe('invalid_request');
    expect((err as Error).message).toContain('site');
    expect(contacted, 'nothing should be attempted on an incomplete request').toBe(false);
    expect(await listConnectors(db, 'tester')).toEqual([]);
  });

  it('a source that refuses the credentials is reported as the caller-fixable refusal', async () => {
    const err = await connectSource(db, new FakeCredentialConnector(), 'demo', 'tester', {
      kind: 'credential',
      credentials: { site: 'not-a-url' },
    }).catch((e: unknown) => e);
    expect(connectorErrorCode(err)).toBe('source_rejected');
    expect((err as Error).message).toContain('full URL');
    expect(await listConnectors(db, 'tester'), 'a refused connect records nothing').toEqual([]);
  });

  it('reconnecting a credential source reuses its row and retires the old credentials', async () => {
    const impl = new FakeCredentialConnector();
    const first = await connectSource(db, impl, 'demo', 'tester', {
      kind: 'credential',
      credentials: { site: 'https://example.test' },
    });
    impl.connect = () => Promise.resolve({ connectionId: 'conn-2', displayName: 'Demo' });
    const again = await connectSource(db, impl, 'demo', 'tester', {
      kind: 'credential',
      credentials: { site: 'https://example.test' },
    });
    expect(again.kind === 'connected' && first.kind === 'connected').toBe(true);
    if (again.kind !== 'connected' || first.kind !== 'connected') return;
    expect(again.connectorId).toBe(first.connectorId);
    expect(impl.revoked, 'the superseded connection is retired').toEqual(['conn-1']);
    expect(await listConnectors(db, 'tester')).toHaveLength(1);
  });

  it('a server that needs approval hands back the URL rather than pretending', async () => {
    const impl = new ApprovalMcpConnector();
    const out = await connectSource(db, impl, 'mcp', 'tester', {
      kind: 'mcp',
      redirectUri: 'http://127.0.0.1:4317/api/connectors/oauth/callback',
      serverUrl: 'https://server.example/mcp',
      scope: 'read',
    });
    expect(out.kind).toBe('authorize');
    if (out.kind !== 'authorize') return;
    expect(out.redirectUrl).toBe('https://server.example/authorize?x=1');
    expect(out.pendingId).toBe('pending-1');
    expect(impl.lastOpts?.serverUrl).toBe('https://server.example/mcp');
    expect(impl.lastOpts?.scope).toBe('read');
    // Nothing is recorded until the approval comes back.
    expect(await listConnectors(db, 'tester')).toEqual([]);
  });

  it('the approval a person gave elsewhere is finished by an ordinary call', async () => {
    const impl = new ApprovalMcpConnector();
    const out = await completeMcpConnection(db, impl, {
      connectionId: 'mcp-conn-1',
      connectedBy: 'tester',
      displayName: 'Partner API',
    });
    const rows = await listConnectors(db, 'tester');
    expect(rows.map((r) => r.id)).toEqual([out.connectorId]);
    expect(rows[0]?.displayName).toBe('Partner API');
    expect(rows[0]?.toolkit).toBe('mcp:mcp-conn-1');
    expect(out.result.upserted.cap_things).toBe(1);
  });

  it('re-authorizing somebody else’s connection is refused by id', async () => {
    const impl = new ApprovalMcpConnector();
    const theirs = await createConnector(db, {
      connector: 'mcp',
      toolkit: 'mcp:other',
      displayName: 'Theirs',
      connectionRef: 'other',
      connectedBy: 'somebody-else',
    });
    const err = await connectSource(db, impl, 'mcp', 'tester', {
      kind: 'mcp',
      redirectUri: 'http://127.0.0.1:4317/api/connectors/oauth/callback',
      targetConnectorId: theirs,
    }).catch((e: unknown) => e);
    expect(connectorErrorCode(err)).toBe('connector_not_found');
    expect(impl.lastOpts, 'the server is never contacted on somebody else’s behalf').toBe(
      undefined,
    );
  });

  it('a placeholder name never beats a real one when labelling a connection', () => {
    expect(mcpConnectionLabel({ serverName: 'MCP Server', displayName: 'Partner' })).toBe(
      'Partner',
    );
    expect(mcpConnectionLabel({ serverName: 'Acme Billing', displayName: 'Partner' })).toBe(
      'Acme Billing',
    );
    expect(mcpConnectionLabel({ serverUrl: 'https://api.acme.test/mcp' })).toBeTruthy();
  });
});

describe('attaching an external database without a server', () => {
  it('imports its tables and reports what landed', async () => {
    const out = await connectDatabaseSource(db, {
      credentials: { host: 'example.invalid', user: 'reader', database: 'shopdb' },
      connectedBy: 'tester',
      outputDir: tmp,
      connector: new FakeDb('capconn1'),
    });
    expect(out.displayName).toBe('shopdb');
    expect(Object.values(out.result.upserted).reduce((a, b) => a + b, 0)).toBe(1);
    const rows = await listConnectors(db, 'tester');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('connected');
    expect(rows[0]?.connector).toBe('db_source');
  });

  it('a SETUP failure rolls the whole connection back and leaves nothing behind', async () => {
    const err = await connectDatabaseSource(db, {
      credentials: { host: 'example.invalid', user: 'reader', database: 'shopdb' },
      connectedBy: 'tester',
      outputDir: tmp,
      connector: new UnsetupableDb('capconn2'),
    }).catch((e: unknown) => e);
    expect(connectorErrorCode(err)).toBe('setup_failed');
    expect((err as Error).message).toContain('Connection setup failed');
    expect(
      await listConnectors(db, 'tester'),
      'a failed setup must not leave a connection pointing at nothing',
    ).toEqual([]);
  });

  it('an IMPORT failure keeps the connection, names it, and stamps its error', async () => {
    const err = await connectDatabaseSource(db, {
      credentials: { host: 'example.invalid', user: 'reader', database: 'shopdb' },
      connectedBy: 'tester',
      outputDir: tmp,
      connector: new ExplodingDb('capconn3'),
    }).catch((e: unknown) => e);
    expect(connectorErrorCode(err)).toBe('import_failed');
    expect((err as Error).message).toContain('import exploded');

    // The id rides on the failure precisely because something WAS left behind.
    const kept = (err as { connectorId?: string }).connectorId;
    expect(kept).toBeTruthy();
    const rec = await getConnector(db, kept ?? '');
    expect(rec?.status).toBe('error');
    expect(rec?.lastError).toBeTruthy();
  });

  it('a reconnect re-points the same connection and clears its error', async () => {
    const broken = await connectDatabaseSource(db, {
      credentials: { host: 'example.invalid', user: 'reader', database: 'shopdb' },
      connectedBy: 'tester',
      outputDir: tmp,
      connector: new ExplodingDb('capconn4'),
    }).catch((e: unknown) => (e as { connectorId?: string }).connectorId ?? '');
    expect(typeof broken).toBe('string');

    const fixed = await reconnectDatabaseSource(db, {
      connectorId: broken as string,
      credentials: { host: 'example.invalid', user: 'reader', database: 'shopdb' },
      connectedBy: 'tester',
      outputDir: tmp,
      connector: new FakeDb('capconn4'),
    });
    expect(fixed.connectorId).toBe(broken);
    const rec = await getConnector(db, fixed.connectorId);
    expect(rec?.status, 'a working reconnect makes a broken connection well').toBe('connected');
    expect(rec?.lastError).toBeFalsy();
    // The SAME row — an edit re-points a database, it does not fork a second one.
    expect(await listConnectors(db, 'tester')).toHaveLength(1);
  });

  it("a reconnect against somebody else's connection is refused", async () => {
    const theirs = await createConnector(db, {
      connector: 'db_source',
      toolkit: 'db_source:theirs',
      displayName: 'Theirs',
      connectionRef: 'theirs',
      connectedBy: 'somebody-else',
    });
    const err = await reconnectDatabaseSource(db, {
      connectorId: theirs,
      credentials: { host: 'example.invalid', user: 'reader', database: 'shopdb' },
      connectedBy: 'tester',
      outputDir: tmp,
      connector: new FakeDb('capconn5'),
    }).catch((e: unknown) => e);
    expect(connectorErrorCode(err)).toBe('connector_not_found');
  });
});

describe('the refresh pass is one call, not a page load', () => {
  it('counts what it brought up to date and what refused', async () => {
    const impl = new FakeCredentialConnector();
    await connectSource(db, impl, 'demo', 'tester', {
      kind: 'credential',
      credentials: { site: 'https://example.test' },
    });
    // Just synced, so nothing is stale — the pass runs and reports honestly.
    const fresh = await refreshStaleSources(db, [impl], 'tester');
    expect(fresh).toEqual({ synced: 0, failed: 0, failures: [] });
  });

  it('hands back the reason each refusal gave, not only how many there were', async () => {
    // A connection with no authorization behind it — what a machine is left with
    // once its stored credentials are revoked. The count alone would say three
    // sources are broken and nothing about why or which.
    const impl = new FakeCredentialConnector();
    await createConnector(db, {
      connector: impl.connector,
      toolkit: 'demo',
      displayName: 'Demo Source',
      connectedBy: 'tester-unauthorized',
    });

    const pass = await refreshStaleSources(db, [impl], 'tester-unauthorized');

    expect(pass.synced).toBe(0);
    expect(pass.failed).toBe(1);
    expect(pass.failures).toHaveLength(1);
    expect(pass.failures[0]?.displayName).toBe('Demo Source');
    expect(pass.failures[0]?.error).toMatch(/no connection/);
  });
});

describe('the connector command drives the same capabilities', () => {
  const run = (
    args: Parameters<typeof runConnectorCommand>[0] extends infer A
      ? Omit<A & object, 'configPath' | 'outputDir' | 'open'>
      : never,
  ): ReturnType<typeof runConnectorCommand> =>
    runConnectorCommand({
      ...args,
      configPath: join(tmp, 'lattice.config.yml'),
      outputDir: tmp,
      open: () => Promise.resolve(db),
    });

  /** The lines a verb printed, asserting it also reported success. */
  const cmd = async (args: Parameters<typeof run>[0]): Promise<string[]> => {
    const result = await run(args);
    expect(result.exitCode, result.lines.join('\n')).toBe(0);
    return result.lines;
  };

  it('lists nothing on a workspace with no sources, and the attached one after', async () => {
    expect(await cmd({ subcommand: 'list' })).toEqual(['No connected sources.']);
    await connectDatabaseSource(db, {
      credentials: { host: 'example.invalid', user: 'reader', database: 'shopdb' },
      connectedBy: await connectedByForCommand(),
      outputDir: tmp,
      connector: new FakeDb('capconn6'),
    });
    const lines = await cmd({ subcommand: 'list' });
    expect(lines[0]).toContain('Connected sources (1)');
    expect(lines[1]).toContain('shopdb');
  });

  it('attaches a database and then detaches it by id', async () => {
    const connected = await connectDatabaseSource(db, {
      credentials: { host: 'example.invalid', user: 'reader', database: 'shopdb' },
      connectedBy: await connectedByForCommand(),
      outputDir: tmp,
      connector: new FakeDb('capconn7'),
    });
    const out = await cmd({ subcommand: 'disconnect', action: connected.connectorId });
    expect(out[0]).toContain('Disconnected');
    expect(await listConnectors(db)).toEqual([]);
  });

  it('reports a refresh pass that lost every source as a failure, with the reasons', async () => {
    // The exit code the wrapper hands the shell — the one a nightly job branches
    // on, and the one this pass used to report as success.
    await createConnector(db, {
      connector: 'mcp',
      toolkit: 'mcp:unauthorized',
      displayName: 'Unauthorized Source',
      connectedBy: await connectedByForCommand(),
    });

    const result = await run({ subcommand: 'sync' });

    expect(result.exitCode, result.lines.join('\n')).not.toBe(0);
    expect(result.lines.join('\n')).toContain('Unauthorized Source');
    expect(result.lines.join('\n')).toMatch(/no connection/);
  });

  it('refuses an id that is not this machine’s, rather than acting on it', async () => {
    const theirs = await createConnector(db, {
      connector: 'db_source',
      toolkit: 'db_source:theirs',
      displayName: 'Theirs',
      connectionRef: 'theirs',
      connectedBy: 'somebody-else',
    });
    await expect(cmd({ subcommand: 'disconnect', action: theirs })).rejects.toThrow(
      /No connected source/,
    );
    expect(await listConnectors(db), 'the row is untouched').toHaveLength(1);
  });

  it('rejects an unknown verb and a --json that would silently do nothing', async () => {
    await expect(cmd({ subcommand: 'frobnicate' })).rejects.toThrow(/Unknown connector subcommand/);
    await expect(cmd({ subcommand: 'disconnect', action: 'x', json: true })).rejects.toThrow(
      /--json applies to/,
    );
  });
});

/** The identity the command resolves, so a fixture attaches a source it can see. */
async function connectedByForCommand(): Promise<string> {
  const { readIdentity } = await import('../../src/framework/user-config.js');
  const { resolveConnectorIdentity } = await import('../../src/connectors/registry.js');
  const ident = readIdentity();
  return await resolveConnectorIdentity(db, ident.email || ident.display_name || 'local');
}
