# Connecting a database imports every row, then silently wipes it

**Date:** 2026-07-05
**Area:** db-source connector connect route (`src/gui/db-sources-routes.ts`) + teardown (`src/connectors/teardown.ts`)

## Symptom

A user connected an external Postgres (≈20 tables, ~2,900 rows). Every table was
created and every row was imported — and then, ~50 seconds later, **all of it
disappeared**: the graph and object views showed "No objects with data yet", and
the connection was gone from the Databases list. From the user's side it looked
like nothing had ingested at all.

## Root cause

The connect handler ran the entire import inside one `try`:

```
defineLate(each table) → enableConnectorRls → syncConnector → publishImportSummary
```

and its `catch` responded to **any** throw — including one that happens _after_
all the rows are already committed — by calling
`disconnectConnector(mode: 'hard')`. That teardown soft-deletes every imported
row (under one shared `deleted_at` timestamp) and hard-deletes the registry row.

So the handler conflated two very different failures:

1. **Pre-persistence** (bad creds, no reachable tables, a `defineLate`/RLS
   failure) — nothing landed, so rolling back is correct.
2. **Post-persistence** (a late/derived/transient step throws after thousands of
   rows are committed) — the rollback **destroys a fully successful import**.

The specific late throw is not even deterministic on a local SQLite workspace,
which is the tell: the defect isn't any single operation, it's the _all-or-nothing
rollback policy_. It also destroyed its own evidence — the only persisted error
trace (the registry's `last_error`) was hard-deleted by the same teardown, so the
failure surfaced as "nothing ingested" with no cause.

## Fix

Split the connect into two phases:

- **Setup** (`defineLate` + RLS) keeps the hard rollback — a failure here means
  nothing landed, so no phantom entry is left behind.
- **Import** (`syncConnector`) no longer rolls back on failure. `syncConnector`'s
  own catch has already stamped the registry row `status='error'` + `last_error`,
  and `GET /api/db-sources` returns every status, so the connection stays visible
  with its error, the imported rows stay live, the raw error is logged
  server-side, and the user can **Refresh** to retry or **Disconnect** to remove.

This is the intended loud-failure behavior: surface the error, keep the data.

## Lessons

- An "atomic connect" must not treat a post-commit failure the same as a
  pre-commit one — discarding already-persisted user data to satisfy atomicity is
  worse than a visible partial import.
- A rollback that also deletes the error record makes the failure undiagnosable.
  Log the raw error before any cleanup.

## Regression tests

`tests/integration/gui-db-sources-rollback.test.ts`:

- An import failure keeps an errored connection (registry row survives with
  `status='error'`, shows in `/api/db-sources`, creds/descriptor retained) instead
  of wiping everything.
- A **post-persistence** failure (rows imported for the first model, the second
  model throws) keeps the already-imported rows **live** and the connection
  present — the exact production data-loss path.
