# Multiplayer cloud editing

When several people open `lattice gui` against the **same shared cloud
(Postgres) database**, Lattice 1.16 makes concurrent editing live and
loss-free. Everything here is **cloud-only** — a local SQLite GUI is a single
writer and behaves exactly as before.

## How it works

Each person runs their own local GUI server, all pointed at one cloud Postgres.
Two channels carry change:

- **`RealtimeBroker`** holds a dedicated `pg.Client` running
  `LISTEN lattice_changes` and forwards every `NOTIFY` to the browser over SSE
  (`GET /api/realtime/stream`). Use a **session-mode** connection (e.g. the
  Supabase pooler on port 5432) — transaction-mode poolers silently drop
  `LISTEN`.
- The **`__lattice_change_log`** table records every change with a per-team
  monotonic `seq`, `owner_user_id`, `created_at` (server receipt), `client_ts`
  (true edit time), and `edit_id` (client idempotency key). An `AFTER INSERT`
  trigger emits the NOTIFY (the large `payload_json` is _not_ in the NOTIFY —
  clients re-fetch; this keeps the payload under Postgres's 8000-byte cap).

GUI row writes append a change envelope (`op` `upsert`/`delete`, post-image as
`payload_json`), so the broker broadcasts data edits to everyone.

## What you see

- **Live share / de-share** — toggling a table's team visibility updates the
  visible set in place; no page reload, and other clients update from the
  broadcast.
- **Last edited by** — the row detail shows `Last edited by <user> · <time ago>`,
  resolved from the change-log + the team roster (`GET /api/team/users`,
  `GET /api/tables/:t/last-edited`).
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
reflects the last write, and _every_ prior version is retained in
`__lattice_change_log` and readable via
`GET /api/tables/:table/rows/:id/history` (newest first). Nothing is silently
destroyed — an overwritten value is always recoverable.

**A row in a table that was de-shared under you** returns `409 entity_unshared`
on write, so the client refetches + toasts rather than failing opaquely. Only
non-owners hit this; an owner always retains visibility.

**Sharing races** (two owners share/unshare concurrently) resolve last-write-wins
on `__lattice_shared_objects.updated_at` + the soft-delete flag; both envelopes
are retained, so all clients converge and the toggle history is recoverable.

**Data-model edits** use `schema_version` as an optimistic-concurrency token.
Each shared table's `schemaVersion` is surfaced on `/api/entities`; a client
edit carries its base version so a stale edit can be rejected and the client
re-fetch + re-issue against the current schema. (Re-shares bump the version.)

## Ordering & clock skew

`seq` is the **only** authoritative ordering key — history queries order by it.
`client_ts` is for display and to preserve recorded edit order across an offline
replay; it is **never** used for correctness ordering, so a client with a wrong
clock can't reorder the canonical log.
