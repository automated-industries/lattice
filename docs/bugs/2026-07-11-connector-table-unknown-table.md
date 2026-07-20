# Clicking a post-open registered table 404s "Unknown table"

- **Date:** 2026-07-11
- **Area:** GUI row/read routes — table-name validation vs. the live registry
- **Severity:** High (a table shown in the sidebar is unclickable — hard error)

## Symptom

After connecting a connector (e.g. a Gmail connector registering `gmail_labels`), the new
table appears in the sidebar TABLES list, but clicking it returns `Unknown table: gmail_labels`
and the collection never loads. A page reload does not help. The same applies to tables
registered by a connected external database (db-source).

## Root cause

The sidebar list is built from the **live** table registry (`db.getRegisteredTableNames()`,
via `entitiesSummary` / `registeredExtraTables`), but the row + read routes validated table
names against `active.validTables` — a **snapshot** built once when the workspace opened
(config tables ∪ registered non-internal tables at open time). A connector or db-source
registers its tables via `db.defineLate` **after** the workspace opened, so those tables are
in the live registry (hence listed) but absent from the snapshot (hence rejected). The list
source and the validation source diverge.

The gate appeared in several places — `tables-routes.ts` (row CRUD, the reported error),
`read-routes.ts` (provenance graph/row + the rows-markdown listing) and `server.ts`
(`/api/gui-meta`) — all using the bare `active.validTables.has(table)` snapshot check. Notably
the schema-op paths (`computed-ops.ts`, `schema-ops.ts`, `schema-routes.ts`) **already** used
the correct `validTables.has(x) || db.getRegisteredTableNames().includes(x)` idiom; the row/read
gates were simply never migrated to it.

## Fix

Add one shared predicate `isRegisteredTable(active, table)` in `active-db.ts`: true if the
table is in the `validTables` snapshot **or** in the live registry, with internal
(`__lattice*` / `_lattice*`) tables always excluded so the security boundary is unchanged.
Replace the bare `validTables.has` snapshot checks on the row/read/navigate gates
(`tables-routes.ts`, `read-routes.ts` ×3, `server.ts` gui-meta) with it. Genuinely-unknown
tables still 400/404 (they are in neither set).

## Lessons learned

- A "snapshot at open" set that a later runtime step (`defineLate`) can extend is a divergence
  waiting to happen. When the same question ("is this a real table?") is answered against two
  sources — a live registry for _listing_ and a snapshot for _validation_ — they will drift.
  Answer it one way. Here the schema paths already had the right idiom; the fix is consistency.
- When adding a gate, prefer a single named predicate over inlining `set.has(x)` at each call
  site, so a policy change lands in one place instead of ~40.

## Regression tests

- `tests/unit/gui-registered-table.test.ts` — pins `isRegisteredTable`: accepts a snapshot
  table, accepts a table registered after open (absent from the snapshot — the regressed case),
  rejects a table in neither, and never exposes internal `__lattice*` / `_lattice*` tables even
  when live-registered. The existing integration test that a genuinely-unknown table still
  returns "Unknown table" continues to guard the reject path.
