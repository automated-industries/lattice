# Cloud workspace switch hangs (20s timeout) — per-table migration loop

**Date:** 2026-06-19
**Severity:** high (a cloud workspace with many tables could not be opened/switched to)

## Symptom

Switching to a cloud (Postgres) workspace in the GUI hung and then failed with:

> Switch failed: Opening "Automated Industries Lattice" timed out after 20s — the
> database may be slow or unreachable. Staying on the current workspace.

The database was **not** slow or unreachable.

## Root cause

The owner-open maintenance runs synchronously inside `openConfig` (it is awaited
before the open resolves), and the whole open is wrapped in a 20s timeout
(`SWITCH_OPEN_TIMEOUT_MS`). The silent data-upgrade added in the backwards-compat
work (`framework/data-upgrade.ts`, `normalizeEmptyDeletedAt`) issued **one
`db.migrate(...)` call per table** to normalize legacy `deleted_at = '' → NULL`.

`applyMigrationsAsync` opens a transaction and takes a transaction-scoped advisory
lock **once per call**. So one `db.migrate` per table = one pooled transaction +
advisory lock + commit per table. The affected cloud had **117 tables** and
connects through the Supabase transaction pooler; measured ~14ms for a simple
round-trip but far more for a full transaction setup/teardown through the pooler.
117 sequential migration transactions blew past the 20s open budget, so the switch
timed out. (A simple `SELECT 1` to the same cloud was 164ms — the DB was fine; the
open path was doing ~100+ pooled transactions.)

## Fix

Normalize in a **single server-side pass** on Postgres: one `db.migrate` whose SQL
is a `DO` block that loops `information_schema.columns` for `deleted_at` tables and
`EXECUTE`s the `UPDATE` per table **in-database** — one migration transaction, gated
by a single `…:v1:all` sentinel. SQLite (local, no pooler/network cost, and its
adapter rejects multi-statement migration SQL) keeps per-table single-statement
migrations but applies them in one `db.migrate([...])` pass.

Measured after the fix (same 117-table cloud): total owner-maintenance **~1.9s**
(was >20s); `upgradeLegacyData` ~389ms on the first open (server-side normalize +
files-path check), ~30ms on subsequent opens once the sentinel is stamped. No other
open phase is a bottleneck (`installCloudRls` 104ms, `reconcileCloudMemberAccess`
281ms).

## Lessons

- **On a remote/pooled cloud, prefer ONE round-trip / one server-side pass over an
  O(N-tables) client loop.** `db.migrate` per item means one transaction + advisory
  lock per item; batch into one call, or push the loop server-side with a `DO`
  block. This is the same class as the existing Phase-4 note that cloud reconcile
  "loops over every table" — keep table-count work off the per-open critical path.
- Anything awaited inside `openConfig` counts against the 20s switch timeout. New
  per-open work must be O(1)-ish in round-trips, or deferred to the background.

## Regression tests

- `tests/integration/data-upgrade-postgres.test.ts` — asserts the Postgres path
  normalizes every `deleted_at` table AND records **exactly one** `…:v1:all`
  sentinel (never a per-table sentinel — i.e. one migration, not N), plus
  idempotency on a second run.
- `tests/integration/data-upgrade.test.ts` — the SQLite path still normalizes
  per-table and is a no-op on a 4.0-native DB.
