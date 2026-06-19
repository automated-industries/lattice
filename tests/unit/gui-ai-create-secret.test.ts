import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { executeFunction, DISPATCHABLE, type DispatchCtx } from '../../src/gui/ai/dispatch.js';
import { getFunction } from '../../src/gui/ai/registry.js';
import { getAsyncOrSync } from '../../src/db/adapter.js';

// Regression: the GUI assistant could NOT add a secret — asked to store a
// credential it replied "I don't have a tool to create secrets directly." The
// `secrets` table is in ASSISTANT_HIDDEN_TABLES (so the model can never READ a
// decrypted secret), which also blocked create_row from ever writing one. The fix
// is a dedicated WRITE-ONLY `create_secret` tool: it can store a secret but never
// read/list/echo existing secret values, the value is encrypted at rest, and it
// never lands the cleartext value in the audit log.
describe('create_secret — assistant can store (never read) a secret', () => {
  let tmpDir: string;
  let db: Lattice;
  let ctx: DispatchCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ai-create-secret-'));
    db = new Lattice(join(tmpDir, 'test.db'), { encryptionKey: 'create-secret-test-key' });
    registerNativeEntities(db); // defines `secrets` (value encrypted) + files + notes
    // The GUI audit table — so we can assert the secret VALUE never lands here.
    db.define('_lattice_gui_audit', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        table_name: 'TEXT NOT NULL',
        row_id: 'TEXT',
        operation: 'TEXT NOT NULL',
        before_json: 'TEXT',
        after_json: 'TEXT',
        session_id: 'TEXT',
      },
      render: () => '',
      outputFile: '_audit.md',
    });
    await db.init();
    ctx = {
      db,
      feed: new FeedBus(),
      validTables: new Set(['notes']),
      softDeletable: new Set(['notes']),
    } as DispatchCtx;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is a registered, dispatchable tool (the bug was: no tool to create secrets)', () => {
    expect(getFunction('create_secret')).toBeTruthy();
    expect(DISPATCHABLE.has('create_secret')).toBe(true);
  });

  it('stores the secret (retrievable) and returns only id + name — never the value', async () => {
    const SECRET = 'afsjiajisaasifsiasjfsa'; // the value from the bug report
    const res = await executeFunction(ctx, 'create_secret', {
      name: 'GitHub password',
      value: SECRET,
      kind: 'password',
      description: 'github login',
    });
    expect(res.ok).toBe(true);
    const result = (res as { result: { id: string; name: string } }).result;
    expect(result.name).toBe('GitHub password');
    expect(typeof result.id).toBe('string');
    // The value (or any other field) must NOT be echoed back to the model.
    expect(JSON.stringify(res)).not.toContain(SECRET);

    // It is actually stored and decryptable with the configured key.
    const row = await db.get('secrets', result.id);
    expect(row?.name).toBe('GitHub password');
    expect(row?.value).toBe(SECRET);
    expect(row?.kind).toBe('password');
    expect(row?.description).toBe('github login');
  });

  it('stores the value ENCRYPTED at rest (the raw column is not the plaintext)', async () => {
    const SECRET = 'plaintext-marker-should-not-be-on-disk';
    const { result } = (await executeFunction(ctx, 'create_secret', {
      name: 'k',
      value: SECRET,
    })) as { result: { id: string } };
    // Read the column RAW (bypassing the Lattice decrypt layer): it must be
    // ciphertext, never the plaintext.
    const raw = (await getAsyncOrSync(db.adapter, 'SELECT value FROM secrets WHERE id = ?', [
      result.id,
    ])) as { value?: string } | undefined;
    expect(raw?.value).toBeTruthy();
    expect(raw?.value).not.toBe(SECRET);
    expect(String(raw?.value)).not.toContain(SECRET);
  });

  it('never writes the cleartext value into the audit log (db.insert, not createRow)', async () => {
    const SECRET = 'super-sekret-token-9000';
    await executeFunction(ctx, 'create_secret', { name: 'tok', value: SECRET });
    const audit = await db.query('_lattice_gui_audit', {});
    expect(audit.some((r) => JSON.stringify(r).includes(SECRET))).toBe(false);
  });

  it('is still WRITE-ONLY: the assistant cannot read/list secrets', async () => {
    await executeFunction(ctx, 'create_secret', { name: 'k', value: 'v' });
    const res = await executeFunction(ctx, 'list_entities', {});
    expect(res.ok).toBe(true);
    const names = (res as { result: { name: string }[] }).result.map((e) => e.name);
    expect(names).not.toContain('secrets');
  });

  it('rejects a missing value (name + value required)', async () => {
    const res = await executeFunction(ctx, 'create_secret', { name: 'k' });
    expect(res.ok).toBe(false);
  });
});
