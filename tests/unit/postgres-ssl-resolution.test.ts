import { describe, it, expect, afterEach } from 'vitest';
import { resolvePgSsl } from '../../src/db/postgres.js';

// PostgresAdapter used to build the pool with no `ssl`, so node-postgres connected
// in cleartext by default. resolvePgSsl picks a mode + a pg-shaped ssl config.
describe('resolvePgSsl — Postgres TLS resolution', () => {
  afterEach(() => {
    delete process.env.LATTICE_PG_SSLMODE;
    delete process.env.PGSSLMODE;
    delete process.env.LATTICE_PG_SSLROOTCERT;
    delete process.env.PGSSLROOTCERT;
  });

  it('defaults a NON-LOCAL host to require (encrypt, no verify) — no plaintext by default', () => {
    const r = resolvePgSsl('postgres://u:p@db.example.com:5432/lattice', {});
    expect(r.mode).toBe('require');
    expect(r.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('defaults localhost / 127.0.0.1 to disable (local is fine in cleartext)', () => {
    expect(resolvePgSsl('postgres://u:p@localhost:5432/db', {}).ssl).toBe(false);
    expect(resolvePgSsl('postgres://u:p@127.0.0.1:5432/db', {}).mode).toBe('disable');
  });

  it('sslMode option wins and shapes the pg ssl config', () => {
    expect(resolvePgSsl('postgres://u@db.example.com/db', { sslMode: 'disable' }).ssl).toBe(false);
    expect(
      resolvePgSsl('postgres://u@db.example.com/db', { sslMode: 'verify-full' }).ssl,
    ).toMatchObject({
      rejectUnauthorized: true,
    });
    const vc = resolvePgSsl('postgres://u@db.example.com/db', { sslMode: 'verify-ca' });
    expect(vc.ssl).toMatchObject({ rejectUnauthorized: true });
    // verify-ca skips the hostname check (a no-op checkServerIdentity); verify-full keeps it.
    expect(typeof (vc.ssl as { checkServerIdentity?: unknown }).checkServerIdentity).toBe(
      'function',
    );
    const vf = resolvePgSsl('postgres://u@db.example.com/db', { sslMode: 'verify-full' });
    expect((vf.ssl as { checkServerIdentity?: unknown }).checkServerIdentity).toBeUndefined();
  });

  it('an inline CA PEM is passed through for verify modes', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBfoo\n-----END CERTIFICATE-----';
    const r = resolvePgSsl('postgres://u@db.example.com/db', {
      sslMode: 'verify-full',
      sslRootCert: pem,
    });
    expect((r.ssl as { ca?: string }).ca).toBe(pem);
  });

  it('honors an sslmode / ssl query param on the connection string', () => {
    expect(resolvePgSsl('postgres://u@db.example.com/db?sslmode=require', {}).mode).toBe('require');
    expect(resolvePgSsl('postgres://u@localhost/db?sslmode=verify-full', {}).mode).toBe(
      'verify-full',
    );
    expect(resolvePgSsl('postgres://u@db.example.com/db?ssl=true', {}).mode).toBe('require');
  });

  it('env LATTICE_PG_SSLMODE overrides the default', () => {
    process.env.LATTICE_PG_SSLMODE = 'disable';
    expect(resolvePgSsl('postgres://u@db.example.com/db', {}).ssl).toBe(false);
  });

  it('precedence: option > env > connection-string > default', () => {
    process.env.LATTICE_PG_SSLMODE = 'require';
    // option beats env + conn-string
    expect(
      resolvePgSsl('postgres://u@db.example.com/db?sslmode=verify-full', { sslMode: 'disable' })
        .mode,
    ).toBe('disable');
    // env beats conn-string
    expect(resolvePgSsl('postgres://u@db.example.com/db?sslmode=verify-full', {}).mode).toBe(
      'require',
    );
  });
});
