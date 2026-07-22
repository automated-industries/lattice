# Brain-graph drill re-fetches every click — slow, then freezes (esp. on cloud)

**Date:** 2026-07-21
**Area:** GUI / brain-graph exploration
**Severity:** Medium-High — the graph becomes unusably slow after a click or two on a cloud workspace.

## Symptom

Clicking through the brain graph (drilling into an object, then a record, then its
neighbors) slows down and appears to freeze after one or two clicks. Exploration
should be near-instant; the data needed to click through layers should load once, not
on every click — this was especially bad on a cloud (Postgres) workspace.

## Root cause

The entity drill graph (`renderEntityGraphInto`, system-tables.ts) fetched its data
fresh on **every** render:

```
fetchRowsPage(table, { limit: 150 })            // this object's rows
… Promise.all(relTables.map(rt =>
    fetchRowsPage(rt, { limit: 300 })))         // + every linked table's rows
```

Clicking a node navigates to `#/graph/<table>/<id>`, which re-runs
`renderEntityGraphInto` — so each click re-issued that whole set of row fetches. On a
cloud each fetch is a network round-trip (and counts against the shared egress
budget), so drilling a few layers deep meant a dozen+ sequential round-trips, and the
UI stalled waiting on them before it could lay out the next graph. Nothing cached the
rows between drills, even though the data rarely changed between clicks.

## Fix

A bounded per-table row-page cache for the graph drill (`fetchRowsPageCached`,
router.ts). The graph now reads its rows through the cache, so after the first load,
clicking through layers reuses the already-fetched pages and is instant — no repeated
round-trips.

It is safe against stale data: the cache is dropped by the existing `invalidate()`
call, which every CRUD handler already runs after a mutation, so the next graph render
re-fetches any table that changed. It is also bounded — it caches the SAME limited
pages `fetchRowsPage` already returned (150 rows for the focus object, 300 per linked
table), just once per graph session instead of once per click, so it adds no extra
egress (it removes egress) and respects the bounded-reads rule. A fetch failure is not
cached, so a transient error still retries on the next drill.

## Tests

Client-bundle byte-pins recaptured (`tests/unit/app-js-composition.test.ts`), which
also asserts the composed script is syntactically valid. The drill behavior is
GUI-level; verify manually on a cloud workspace: open the graph, drill several layers
deep, and confirm each click is instant (no per-click network fetch of the same
tables) and that after editing a record the graph reflects the change on its next
render.

## Not changed

The schema (tables) graph still re-fetches `/api/graph?schema=1` on render, but that is
a small schema-only payload (nodes + edges, no rows) and was not the source of the
slowdown — the row fetches were. Left as-is to keep the change focused.
