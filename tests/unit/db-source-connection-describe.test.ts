import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  setDbSourceCreds,
  clearDbSourceCreds,
  describeDbSourceConnection,
} from '../../src/connectors/db-source/connector.js';
import {
  setSchemaDescriptor,
  clearSchemaDescriptor,
} from '../../src/connectors/db-source/schema-cache.js';

/**
 * describeDbSourceConnection surfaces the NON-SECRET connection parts (host / port
 * / user / database / schema) so the GUI can pre-fill the edit form — the password
 * is NEVER returned, because Lattice does not display stored secrets. This is what
 * makes "edit a connection, leave the password blank to keep it" safe.
 */
describe('describeDbSourceConnection', () => {
  let tmp: string;
  const savedEnv: Record<string, string | undefined> = {};
  const CONN = 'describetest1';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dbsrc-describe-'));
    for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY']) savedEnv[k] = process.env[k];
    process.env.LATTICE_CONFIG_DIR = tmp;
    process.env.LATTICE_ENCRYPTION_KEY = 'describe-test-key';
  });
  afterEach(() => {
    clearDbSourceCreds(CONN);
    clearSchemaDescriptor(CONN);
    rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  it('parses host/port/user/database and pulls schema from the descriptor', () => {
    setDbSourceCreds(CONN, 'postgres://reader:s3cr3t@db.example.com:6543/shop');
    setSchemaDescriptor(CONN, {
      dialect: 'postgres',
      schema: 'reporting',
      prefix: 'shop_ab12',
      tables: [],
    });
    const parts = describeDbSourceConnection(CONN);
    expect(parts).toEqual({
      host: 'db.example.com',
      port: '6543',
      user: 'reader',
      database: 'shop',
      schema: 'reporting',
    });
  });

  it('NEVER returns the password, even though the stored string contains one', () => {
    setDbSourceCreds(CONN, 'postgres://reader:s3cr3t@db.example.com:5432/shop');
    setSchemaDescriptor(CONN, { dialect: 'postgres', schema: 'public', prefix: 'p', tables: [] });
    const parts = describeDbSourceConnection(CONN);
    expect(JSON.stringify(parts)).not.toContain('s3cr3t');
    expect(parts).not.toHaveProperty('password');
  });

  it('decodes URL-encoded user + database', () => {
    setDbSourceCreds(CONN, 'postgres://read%40er:p%40ss@db.example.com:5432/my%20db');
    setSchemaDescriptor(CONN, { dialect: 'postgres', schema: 'public', prefix: 'p', tables: [] });
    const parts = describeDbSourceConnection(CONN);
    expect(parts?.user).toBe('read@er');
    expect(parts?.database).toBe('my db');
  });

  it('defaults schema to public when the descriptor has none cached', () => {
    setDbSourceCreds(CONN, 'postgres://u:p@h:5432/d');
    // No setSchemaDescriptor → getSchemaDescriptor returns undefined.
    const parts = describeDbSourceConnection(CONN);
    expect(parts?.schema).toBe('public');
  });

  it('returns null when the connection has no stored credentials', () => {
    expect(describeDbSourceConnection('no-such-connection')).toBeNull();
  });
});
