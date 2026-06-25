# Cloud queries fail under load with `EMAXCONNSESSION` (session-pooler exhaustion)

**Date:** 2026-06-24
**Area:** Postgres adapter / cloud connections (`src/db/postgres.ts`)
**Severity:** queries fail under load on small-pool cloud projects

## Symptom

On a cloud (Supabase) workspace, a burst of activity — e.g. the assistant
gathering data for a dashboard while the realtime broker is also running — caused
queries to fail with:

```
(EMAXCONNSESSION) max clients reached in session mode — max clients are limited to pool_size: 15
```

The assistant, seeing failed tool queries, paraphrased this as a "rate limit."

## Root cause

The workspace connection string pointed at Supabase's **session-mode pooler**
(`*.pooler.supabase.com:5432`), and the query pool connected there. In session
mode, every pooled client holds one upstream connection for its entire lifetime.
The app's footprint against that pooler was:

- the query `pg.Pool` (default `max` 10), plus
- the realtime broker's dedicated `LISTEN/NOTIFY` `pg.Client` (can't be pooled),
  plus
- transient connections during workspace open (peek / converge / bootstrap).

Under a burst this exceeded the pooler's `pool_size` of 15. The visibility probe
(`changeVisibleToActiveRole`, fired per change on the **entire** cloud via the
global NOTIFY fan-out) competed for the same pool, amplifying the pressure.

This is a capacity mismatch, not a transient — so backoff/retry is the wrong fix;
it would just re-queue against a still-full pooler.

## Fix

Route the **query pool** through Supabase's **transaction-mode pooler** (port 6543) instead of the session pooler (5432). Transaction mode returns the upstream
connection to the pool at COMMIT, multiplexing many clients over far fewer
upstream slots. The adapter already holds no cross-statement session state (it
re-executes SQL per call rather than caching server-side prepared statements;
advisory locks are `_xact_` (transaction-scoped); `set_config(..., is_local=true)`
is transaction-local; `SET search_path` appears only inside `SECURITY DEFINER`
function bodies), so it is transaction-pooler-safe.

The realtime broker keeps its **session-mode** connection — `LISTEN/NOTIFY`
requires session mode, and it is a separate `pg.Client` not affected by the pool's
URL.

`toTransactionPoolerUrl()` does the rewrite surgically: only a Supabase pooler
host on :5432 is bumped to :6543 (host:port only, never userinfo); direct,
non-Supabase, already-:6543, and unparseable URLs are left untouched.
`LATTICE_PG_SESSION_POOLER=1` forces the pool back onto session mode.

## Lessons

- `EMAXCONNSESSION` is the session pooler's client cap, not your `pg.Pool` `max`
  — count the dedicated `LISTEN` client + transient open-time connections too.
- Use the session pooler only for what needs it (LISTEN/NOTIFY); route ordinary
  short queries through the transaction pooler.

## Regression tests

- `tests/unit/postgres-transaction-pooler.test.ts` — covers the rewrite
  (Supabase :5432 → :6543, userinfo/db/query preserved) and the no-ops
  (already-:6543, direct Supabase, non-Supabase, `:54321`, escape hatch).
