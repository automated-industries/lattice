# PostgresAdapter connects in cleartext by default, with no way to require/verify TLS

- **Date:** 2026-07-21
- **Area:** `PostgresAdapter` (cloud / self-hosted Postgres workspaces)
- **Severity:** High (all workspace data transmitted unencrypted by default against any Postgres that isn't itself forcing TLS)

## Symptom

Opening a self-hosted Postgres workspace establishes an **unencrypted** connection even when the
server supports TLS — every query and result (people, meetings, messages, file contents, secrets)
crosses the network in cleartext. Enabling `ssl=on` on the Postgres server does nothing, because the
client never requests TLS. There was also no supported setting to require or verify TLS: the public
`PostgresAdapterOptions` exposed only `poolSize`.

## Root cause

`PostgresAdapter.open()` built the pool with just a connection string and pool size — **no `ssl`
option**. node-postgres (`pg`), unlike libpq (whose default `sslmode` is the opportunistic
`prefer`), does **not** negotiate TLS unless the caller opts in via an `ssl` config or an
`sslmode`/`ssl` on the connection string. So every connection was plaintext. This was masked against
Supabase (which enforces TLS server-side, so the missing client `ssl` never surfaced), but on a
self-hosted Postgres — the "bring your own cloud DB" case — nothing forced encryption.

## Fix

- **A real TLS config is passed to `pg.Pool`.** New `resolvePgSsl()` computes an `sslMode`
  (`disable` | `require` | `verify-ca` | `verify-full`) and a `pg`-shaped `ssl` object, with
  precedence: explicit `PostgresAdapterOptions.sslMode` → `LATTICE_PG_SSLMODE`/`PGSSLMODE` → an
  `sslmode`/`ssl` query param on the connection string → a **default of `require` for a non-local
  host** (`disable` for localhost / a unix socket). `require` encrypts without verifying;
  `verify-ca`/`verify-full` verify the chain (and, for `verify-full`, the hostname) against a CA from
  `PostgresAdapterOptions.sslRootCert` / `LATTICE_PG_SSLROOTCERT` / `PGSSLROOTCERT`, or Node's
  built-in CA set.
- **Transport state is surfaced at connect time.** The chosen `sslMode` is logged; a non-local host
  that resolves to `disable` logs a loud warning that the connection is unencrypted and how to
  encrypt it. (A first-class "Encrypted / ⚠️ Unencrypted" badge on the Database panel is a follow-up.)

### Behavior change (reviewer note)

Non-local Postgres connections now default to **encrypted (`require`)** instead of plaintext. This is
safe for the common case (Supabase already enforces TLS; the app's own deployments use it), and
`require` succeeds against any TLS-capable server regardless of cert validity. A server that offers
**no** TLS at all will now fail to connect until `sslMode=disable` (or `LATTICE_PG_SSLMODE=disable`)
is set — a deliberate "secure by default, opt out of encryption explicitly" posture.

## Lessons learned

- node-postgres is not libpq: "the server supports TLS" plus "the connection string looks normal"
  does not mean the client is using TLS. A data-in-transit-sensitive client must pass `ssl`
  explicitly and default it on for remote hosts.
- A silent plaintext downgrade is invisible; log the negotiated transport.

## Regression tests

- `tests/unit/postgres-ssl-resolution.test.ts` — non-local defaults to `require` (encrypt, no
  verify); localhost/127.0.0.1 to `disable`; the `sslMode` option shapes the `pg` ssl config
  (verify-ca vs verify-full hostname handling); an inline CA PEM passes through; connection-string
  `sslmode`/`ssl` params are honored; and precedence is option > env > connection-string > default.
