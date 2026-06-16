# Multiplayer cloud editing

When several people open `lattice gui` against the **same shared cloud
(Postgres) database**, Lattice 1.16 makes concurrent editing live and
loss-free. Everything here is **cloud-only** — a local SQLite GUI is a single
writer and behaves exactly as before.

## How it works

Each person runs their own local GUI server, all pointed at one cloud Postgres —
each connecting as their **own scoped, non-superuser Postgres role** (see
[cloud.md](cloud.md)). Postgres Row-Level Security confines every read and write to
the rows that role may see, so collaboration is naturally scoped: you only ever see
and flash on changes to rows shared with you. Two channels carry change:

- **`RealtimeBroker`** holds a dedicated `pg.Client` running
  `LISTEN lattice_changes` and forwards every `NOTIFY` to the browser over SSE
  (`GET /api/realtime/stream`). Use a **session-mode** connection (e.g. the
  Supabase pooler on port 5432) — transaction-mode poolers silently drop
  `LISTEN`. A transaction-mode proxy can drop the registration _without_ closing
  the socket, so the broker also runs a periodic **backstop poll** that re-delivers
  missed changes regardless; see the managed-Postgres / RDS Proxy notes in
  `cloud.md`. The poll interval is configurable via `startGuiServer`'s
  `realtimeWatchdogMs` (0 disables it).
- The **`__lattice_changes`** table is the append-only change feed: each row carries
  a monotonic `seq`, the `table_name`, the `pk`, the `op` (`upsert`/`delete`), the
  `owner_role`, and `created_at`. The per-table RLS trigger writes one entry per
  insert/update/delete; an `AFTER INSERT` trigger emits the NOTIFY carrying only that
  metadata — **never row content** — so clients re-fetch the affected row _through
  RLS_ (which keeps the payload tiny and never broadcasts another member's data).

## What you see

- **Live share / un-share** — when a row's owner changes its visibility
  (`private` ↔ `everyone`, via `/api/cloud/share`), the row appears or disappears in
  every other member's view on the next broadcast; no page reload. Sharing is
  per-**row** under RLS, not per-table.
- **Last edited by** — the row detail shows `Last edited by <role> · <time ago>`,
  resolved from the change feed's `owner_role` + `created_at`
  (`GET /api/tables/:t/last-edited`).
- **Flash + counts** — a row visible in the current view flashes when another
  editor changes it (honoring `prefers-reduced-motion`); changes to other
  tables bump a per-table unseen-change badge in the sidebar.
- **Offline editing** — see below.

## Offline editing

When the cloud is unreachable (the realtime channel is disconnected), row edits
are persisted to an IndexedDB queue instead of being lost, and a top-bar pill
shows the pending count. On reconnect, `drainQueue()` replays them **in
edit-timestamp (`client_ts`) order**, each carrying its `X-Lattice-Edit-Id` and
`X-Lattice-Client-Ts` headers. The server records `client_ts` on the envelope
(preserving true edit order) and **no-ops a re-sent `edit_id`**
(`findEnvelopeByEditId`), so a replay after a flaky reconnect can't double-apply.

> Optimistic local re-render of a queued edit _before_ it syncs is a documented
> follow-on; today a queued edit is captured + toasted ("saved offline") and
> appears once it replays.

## Conflict policy

**Row edits — last-write-wins by edit timestamp, every version recoverable.**
Concurrent edits to the same row are applied in arrival order; the live row
reflects the last write, and _every_ prior version is retained in the
`__lattice_changes` feed and readable via
`GET /api/tables/:table/rows/:id/history` (newest first). Nothing is silently
destroyed — an overwritten value is always recoverable.

**A row that was made private out from under you** simply stops being returned —
Postgres RLS excludes it, so a subsequent read returns nothing and a write affects
zero rows. Only the row's owner may change its visibility; the owner always retains
access to their own rows.

**Sharing changes** go through the owner-only `lattice_set_row_visibility` SQL
function, which updates `__lattice_owners.visibility` for a single row. Because each
change is one row's visibility flip recorded in the change feed, clients converge on
the latest state and the history is recoverable.

**Data-model edits** use `schema_version` as an optimistic-concurrency token. Each
table's `schemaVersion` is surfaced on `/api/entities`; a client edit carries its
base version so a stale edit can be rejected and the client re-fetch + re-issue
against the current schema.

## Ordering & clock skew

`seq` is the **only** authoritative ordering key — history queries order by it.
`client_ts` is for display and to preserve recorded edit order across an offline
replay; it is **never** used for correctness ordering, so a client with a wrong
clock can't reorder the canonical log.
