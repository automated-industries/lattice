# Connector sync fails with "possible conflict" for a scoped cloud member

**Date:** 2026-07-21
**Area:** cloud RLS / connector sync
**Severity:** High — a member's connector never finishes its first sync, and previously-synced rows become invisible to the member who synced them.

## Symptom

On a cloud (Postgres) workspace, a scoped member connects a connector. OAuth and
connector creation succeed, but the connector's registry row ends up
`status = 'error'` with:

```
A record could not be written during sync (possible conflict). Try reconnecting.
```

Reconnecting does not help — it fails the same way every time. Some rows the sync
did write are not visible to the member in the GUI even though the member is the
one who synced them.

## Root cause

Enabling row-level security on a table (`ALTER TABLE … ENABLE / FORCE ROW LEVEL
SECURITY`, plus installing the per-table ownership trigger) requires table-owner
privilege. A scoped member does not have it, so `enableConnectorRls` is a no-op for
a member (`canManageRoles` is false).

That means the sequence for a member-initiated connector is:

1. The member's connect defines the connected tables and runs the initial sync,
   inserting rows **while the table has no ownership trigger** — so those rows get
   **no `__lattice_owners` record**. They are "ownerless".
2. Later, the owner opens the workspace and secures the connector tables, which
   `ENABLE`/`FORCE`s RLS and installs the ownership trigger.
3. Under `FORCE ROW LEVEL SECURITY`, `lattice_row_visible()` returns **false for a
   row that has no ownership record** — so every ownerless row is now invisible to
   **everyone**, including the member who synced it.
4. The member's next sync upserts the same natural keys. The write is
   `INSERT … ON CONFLICT (pk) DO UPDATE`; the conflicting physical row exists but is
   RLS-invisible, so Postgres raises **`new row violates row-level security policy`**.
   `sanitizeConnectorError` genericizes any constraint/violation error (so a raw key
   value can't leak another member's data through the surfaced message) to the
   "possible conflict" text above.

The cross-_member_ variant of this (two members syncing the same external instance
colliding on a shared physical PK) was already mitigated by namespacing every synced
row's primary key per connector. The remaining gap was the single-member
**ownerless-row window** created by step 1.

## Fix

Stamp ownership on connector rows so they are never left ownerless, from both sides:

- **Prevent** — a new member-callable `SECURITY DEFINER` function
  `lattice_member_claim_ownerless(table, connector_id)` stamps the calling member
  (`session_user`) as owner of every still-ownerless row of one of their connectors.
  The connector sync path calls it right after each model's writes (a member-only,
  cloud-only step). It only ever claims rows that have **no** owner yet (so it can
  never take over another member's row) and only in a connected table (one bearing
  the `_source_connector_id` lineage column).

- **Heal** — securing a connector table stamps each still-ownerless row to the role
  that synced it (its connector's `connected_by`, which on a cloud is the member's own
  login role), guarded to roles that still exist. This recovers workspaces that were
  already broken before this fix. It runs inside the securing SQL, between a lifted
  and a re-applied `FORCE`, so it also works for an owner without `BYPASSRLS` — see
  the 5.7 follow-up below. Securing is what triggers it, so it reaches a table when
  that source is next connected, reconnected, or refreshed; there is no owner-open
  path that secures a table, so it does not run merely because the owner opened the
  workspace.

Both are idempotent (`ON CONFLICT DO NOTHING` / `NOT EXISTS`) and stamp the table's
default visibility — exactly what the ownership trigger would have stamped had it
existed at insert time.

## Tests

`tests/integration/bug5-upsert-rls-hidden-conflict.test.ts` (Postgres-gated, real
member login role):

- reproduces the failure — a member cannot re-sync an ownerless row (the upsert
  raises the RLS violation);
- **PREVENT** — after `claimOwnerlessConnectorRows`, the member owns the row, can see
  it, and re-syncs without conflict;
- **HEAL** — after the table is secured again, the row is owned by the connector's
  member and is visible + re-syncable;
- **safety** — the claim never takes over a row already owned by another member.

## Lessons

- CI runs on SQLite, which has no RLS — this class of bug is invisible there and only
  reproduces against a real cloud Postgres with a non-BYPASSRLS member login role.
- Any write path that inserts rows a member will later own must ensure ownership is
  recorded at (or before) the moment RLS is enabled; an "insert now, secure later"
  ordering is a data-visibility trap under `FORCE ROW LEVEL SECURITY`.

## Follow-up (5.7): the heal never actually ran for an owner without `BYPASSRLS`

The heal above was written as a separate statement issued **after** the table was
secured, and its docstring asserted it "runs as the owner (BYPASSRLS), so it sees
the ownerless rows". That assertion was the bug. `FORCE ROW LEVEL SECURITY` applies
the policies to the table's owner too, and `lattice_row_visible` answers from an
ownership record — so on a cloud whose owner is an ordinary role, the heal's `SELECT`
read through the very policy it existed to populate, matched nothing, and inserted
nothing. It reported success. Every row already in the table went dark permanently,
to the owner as well as to the members, with nothing raised anywhere.

The second half was the connector **registry**. It was being secured with the same
per-table primitive, but it is owner-only bookkeeping (members hold no grant on it),
so the policies protected nothing while making the registry unreadable to that same
owner. That blinded connector lookups, and it broke attribution too, since a row is
attributed by joining the registry to find who connected it — the heal could not have
worked even with the ordering fixed.

Both halves are closed structurally rather than reordered:

- The stamp now lives **inside** the securing SQL, between `NO FORCE` and
  `ENABLE` + `FORCE`, in the one transaction. One statement covers an authored table
  and a connected one, because `to_jsonb(t) ->> '_source_connector_id'` is NULL rather
  than an error on a table without that column. The two standalone backfill helpers
  are deleted — there is no longer a way to call the stamp at the wrong moment.
- The registry is no longer routed through the per-table primitive, and the cloud
  bootstrap repairs clouds that already were: it takes the member group's grants on
  the base table back **before** lifting row security, then drops the tracking
  trigger, the policies, and the row-security flags. The revoke is the statement that
  closes the leak — those grants are column-level `SELECT`, held so members can
  upsert, and they return nothing only while the table is forced; disabling row
  security with them still standing is what flips members from reading nothing to
  reading the whole registry. The member-granted read view is dropped in the same
  block, but it is not what holds the leak shut: it carries the same row-visibility
  predicate the policies do, so lifting row security does not widen what it returns.
  It goes because it is a member read path onto owner-only bookkeeping, and it goes
  with `CASCADE`, because on this hard-fail path a relation built on it would
  otherwise make the drop raise and turn the repair into a failed open.

Regression: `tests/integration/connector-rls-restricted-owner-postgres.test.ts`, which
connects as a real `NOSUPERUSER NOBYPASSRLS` owner rather than the cluster superuser
every other Postgres suite uses, and asserts on row counts rather than on the absence
of an exception.

### Lesson

A test that connects as a superuser cannot see a row-security defect at all: the rows
come back either way and the assertion passes. The owner side of row security was
effectively untested until a restricted owner harness existed.
