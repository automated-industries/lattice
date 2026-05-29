import { describe, it, expect } from 'vitest';
import { shouldMkdirForDbPath } from '../../src/gui/server.js';

/**
 * Regression: the GUI crashed on Windows when `db:` was a Postgres URL —
 * openConfig() did `mkdirSync(dirname(dbPath))`, and dirname("postgres://…:5432/…")
 * contains ':', illegal in Windows paths. mkdir must be skipped for URLs +
 * :memory: (only real filesystem SQLite paths get a parent dir created).
 */
describe('shouldMkdirForDbPath', () => {
  it('skips Postgres URLs', () => {
    expect(shouldMkdirForDbPath('postgres://user:pw@host:5432/db')).toBe(false);
    expect(shouldMkdirForDbPath('postgresql://user:pw@host:5432/db')).toBe(false);
    expect(shouldMkdirForDbPath('POSTGRES://HOST:5432/DB')).toBe(false);
  });

  it('skips file: URLs and :memory:', () => {
    expect(shouldMkdirForDbPath('file:///tmp/x.db')).toBe(false);
    expect(shouldMkdirForDbPath(':memory:')).toBe(false);
  });

  it('creates the parent dir for real SQLite filesystem paths', () => {
    expect(shouldMkdirForDbPath('./data/lattice.db')).toBe(true);
    expect(shouldMkdirForDbPath('/var/lib/lattice/app.db')).toBe(true);
    expect(shouldMkdirForDbPath('data/app.sqlite')).toBe(true);
  });
});
