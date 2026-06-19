# Scaling: connection pooling & bounded reads

This note documents how `latticesql` behaves under concurrency — the Postgres
connection-pool contract and the read-bounding posture — for deployments serving many
simultaneous cloud users. It is the recorded outcome of the 4.0 cloud-scale review.

## Connection pooling

- **One pool per `Lattice` instance.** The Postgres adapter creates a single
  `pg.Pool` with `max = poolSize` (default **10**). Configure it per instance:

  ```ts
  const db = new Lattice('postgres://…', { poolSize: 20 });
  ```

- **The data path reuses a long-lived instance, not a per-request one.** A GUI
  workspace opens exactly one `Lattice` (cached as the active DB) and serves every
  request for that workspace from its pool. The only short-lived instances are
  **transient probes** during connect/credential checks (a workspace open's peek and
  the connection-test probe) — they are not on the per-request data path and are
  disposed promptly, so there is no per-request connection churn.

- **The multi-tenant model is one connection identity per member.** Each cloud
  member's GUI connects to the shared Postgres **as that member's own role** through
  its own `Lattice`/pool. "Hundreds of concurrent members" therefore means hundreds of
  independent role-scoped connections governed by Postgres `max_connections` (and any
  external pooler such as PgBouncer), **not** contention on a single shared application
  pool. Size `max_connections` / the pooler for the expected concurrent-member count;
  keep each instance's `poolSize` modest (the default 10 is appropriate for a single
  workspace's request concurrency).

- **Statements are parameterized** (`pool.query(sql, params)`), so the driver reuses
  prepared statements per connection. The one deliberate exception is the member-grant
  reconcile, which uses the unparameterized simple-query protocol to batch a table's
  GRANTs into a single round-trip (see `cloud/member-access.ts`).

## Bounded reads (Rule of thumb: no unbounded whole-table read on a hot path)

The main GUI list endpoints are bounded at the route layer via `parsePageParam` /
`MAX_ROWS_PAGE` (`/api/tables/:t/rows`, `/api/system-tables/:t/rows`). The read API
(`getActive`, `queryTable`) accepts optional `{ limit, offset }` bounds.

A sweep of the remaining whole-table reads (empty-filter `query`/`queryTable`) found
only these, each acceptable for the reason given — **none scale with row count on a
per-request path**:

| Site                                                                            | Why it is acceptable                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-routes.ts` GUI metadata (`_lattice_gui_meta`, `_lattice_gui_column_meta`) | Bounded by **schema** size (≈ one row per entity/column), not data volume.                                                                              |
| `reverse-seed/engine.ts`                                                        | Recovery path — runs only against an **empty / missing** entity table.                                                                                  |
| `reverse-sync/engine.ts`                                                        | Inherent: diffs the full entity set against the rendered files; **debounced**, not per-request.                                                         |
| `dedup-service.ts`                                                              | Inherent: duplicate detection must scan the candidate set. **Known limitation** for very large tables — a future windowed/indexed dedup would bound it. |

When adding a read in a request handler, scheduler, or per-item loop, filter + bound it
in SQL; if a whole-table read is genuinely required, justify it in a comment like the
ones above so the next sweep can sign it off quickly.
