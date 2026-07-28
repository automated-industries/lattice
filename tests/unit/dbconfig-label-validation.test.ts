import { describe, expect, it } from 'vitest';
import {
  normalizeLabel,
  parseSaveBody,
  parseSaveBodyResult,
} from '../../src/gui/dbconfig/shared.js';

// Regression: a cloud-workspace Label containing a space (e.g. "Strategy Team") was
// rejected by parseSaveBody() returning bare null, which every cloud route collapsed
// into "Invalid Postgres credentials" — before any connection was attempted. The label
// (a cosmetic/key field) was blamed on the credentials and the network. Two fixes:
// (1) field-specific parse results so a validation failure is never a credentials error,
// (2) the label is normalized rather than rejected, so a space just works.

// The reader regex the credential key is matched with on read.
const KEY_RE = /^\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}$/;

const pgBody = (over: Record<string, unknown> = {}) => ({
  type: 'postgres',
  label: 'team',
  host: 'db.example.com',
  dbname: 'app',
  user: 'appuser',
  password: 'secret',
  port: 5432,
  ...over,
});

describe('normalizeLabel', () => {
  it('turns a spaced label into a valid hyphenated key', () => {
    expect(normalizeLabel('Strategy Team')).toBe('Strategy-Team');
  });
  it('collapses runs of unsupported characters and trims edges', () => {
    expect(normalizeLabel('  Team A / B!! ')).toBe('Team-A-B');
    expect(normalizeLabel('Q1 2026 Revenue')).toBe('Q1-2026-Revenue');
  });
  it('preserves an already-valid label unchanged', () => {
    expect(normalizeLabel('a.b_c-d')).toBe('a.b_c-d');
  });
  it('returns empty only when nothing usable survives', () => {
    expect(normalizeLabel('!!!')).toBe('');
    expect(normalizeLabel('已经')).toBe('');
  });
  it('always produces a value the LATTICE_DB key regex accepts (or empty)', () => {
    for (const raw of ['Strategy Team', 'My  Team', 'a.b_c-d', 'Q1 2026']) {
      const n = normalizeLabel(raw);
      expect(n).not.toBe('');
      expect(KEY_RE.test('${LATTICE_DB:' + n + '}')).toBe(true);
    }
  });
});

describe('parseSaveBodyResult — field-specific validation (never a blanket credentials error)', () => {
  it('accepts a spaced label by normalizing it (the reported bug case)', () => {
    const r = parseSaveBodyResult(pgBody({ label: 'Strategy Team' }));
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === 'postgres') {
      expect(r.value.label).toBe('Strategy-Team');
      expect(r.value.label).not.toMatch(/\s/);
      expect(KEY_RE.test('${LATTICE_DB:' + r.value.label + '}')).toBe(true);
    }
  });

  it('reports a missing label as a LABEL field error, not a credentials error', () => {
    const r = parseSaveBodyResult(pgBody({ label: '' }));
    expect(r).toMatchObject({ ok: false, field: 'label' });
    if (!r.ok) expect(r.error.toLowerCase()).not.toContain('credential');
  });

  it('reports an all-symbol label (normalizes to empty) as a LABEL field error', () => {
    const r = parseSaveBodyResult(pgBody({ label: '!!!' }));
    expect(r).toMatchObject({ ok: false, field: 'label' });
  });

  it('names the specific missing field for host / dbname / user / port', () => {
    expect(parseSaveBodyResult(pgBody({ host: '' }))).toMatchObject({ ok: false, field: 'host' });
    expect(parseSaveBodyResult(pgBody({ dbname: '' }))).toMatchObject({
      ok: false,
      field: 'dbname',
    });
    expect(parseSaveBodyResult(pgBody({ user: '' }))).toMatchObject({ ok: false, field: 'user' });
    expect(parseSaveBodyResult(pgBody({ port: 'abc' }))).toMatchObject({
      ok: false,
      field: 'port',
    });
  });

  it('never emits the word "credentials" for any validation failure', () => {
    for (const over of [{ label: '' }, { host: '' }, { dbname: '' }, { user: '' }, { port: 'x' }]) {
      const r = parseSaveBodyResult(pgBody(over));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.toLowerCase()).not.toContain('credential');
    }
  });

  it('accepts a fully valid postgres body', () => {
    const r = parseSaveBodyResult(pgBody());
    expect(r.ok).toBe(true);
  });

  it('requires a sqlite path with its own field error', () => {
    expect(parseSaveBodyResult({ type: 'sqlite' })).toMatchObject({ ok: false, field: 'path' });
    expect(parseSaveBodyResult({ type: 'sqlite', path: '/tmp/x.db' })).toMatchObject({ ok: true });
  });
});

describe('parseSaveBody back-compat wrapper', () => {
  it('returns null on failure and the value on success', () => {
    expect(parseSaveBody(pgBody({ label: '' }))).toBeNull();
    const v = parseSaveBody(pgBody({ label: 'Strategy Team' }));
    expect(v?.type === 'postgres' && v.label).toBe('Strategy-Team');
  });
});
