# Chat lost the currently-open dashboard/record as context on the 5.0 Workspace routes

- **Date:** 2026-07-11
- **Area:** GUI chat context (`activeContext`) / client route detection
- **Severity:** High (core "assistant knows what you're looking at" feature silently no-ops)

## Symptom

With a dashboard open, asking the assistant "why is this dashboard blank?" produced a reply
asking the user to _open_ the dashboard they were already viewing (e.g. "I need to see the
dashboard to diagnose the issue. Could you open it so I can investigate?"). The same class of
failure applied to any open table record or file — the assistant never received the
currently-open surface as context, so "this dashboard / this row / this file" resolved to
nothing and the self-diagnosis (`investigate`) tool had no default target.

## Root cause

The client sends a `activeContext: { table, id }` hint with every chat message, computed by
`activeElement()` in `src/gui/app/modules/boot-interstitial.ts`. Its dashboard branch matched
**only** the retired route `#/analytics/<id>`. In the 5.0 single layout:

- the canonical open-dashboard route is `#/w/dash/<id>` (see `renderRoute` in
  `analytics-view.ts`), and
- `normalizeLegacyHash` (`workspace-switch-progress.ts`) rewrites `#/analytics/<id>` →
  `#/w/dash/<id>` on entry,

so a user viewing a dashboard is **always** on `#/w/dash/<id>` — a hash `activeElement()`
never recognized. It therefore returned `null`, the client POSTed `activeContext: null`, and
the entire (correct) server chain went idle: `parseActiveContext` → `undefined`,
`describeActiveView` emitted no note, `dispatch.activeDashboardId` was never set, and the
`investigate` tool returned "No dashboard is open… have them open it." The same gap dropped
open table records (`#/w/table/<name>/<rowId>`) and files (`#/w/file/<id>`) from chat context.

The server side of the feature was fully built and correct — it was starved of the one input
it needed because the client route detector was never migrated to the `#/w/…` scheme.

## Fix

Add a `#/w/(dash|table|file|md)/<first>[/<drill-in>…]` branch to `activeElement()` that mirrors
`renderRoute`'s parser:

- `dash` → `{ table: 'dashboards', id }`
- `file` → `{ table: 'files', id }`
- `table` / `md` → the deepest complete `table,id` pair (a bare collection yields `null`)

The legacy `#/analytics/<id>` branch is retained for back-compat.

## Lessons learned

- When a route scheme is migrated (`#/analytics` / `#/fs` → `#/w/…`), audit **every** consumer
  of the hash, not just the renderers. A route producer (`renderRoute`) and a route _reader_
  (`activeElement`) drifted apart, and only the reader was missed — a silent no-op with no error.
- Client-computed context that feeds the model needs a behavioral test at the client seam.
  There was thorough coverage of the _server_ consuming a well-formed hint and of the
  downstream tools once `activeDashboardId` was set, but nothing asserted the client actually
  _produces_ the hint from the current route — so the regression slipped through green tests.

## Regression tests

- `tests/unit/gui-active-element-dashboard.test.ts` — jsdom test that evals the client segment
  and asserts `activeElement()` returns the right `{ table, id }` for `#/w/dash/<id>` (incl.
  percent-encoded ids), `#/w/file/<id>`, `#/w/table/<name>/<rowId>`, a drilled relation
  (deepest pair), `null` for a bare collection, and the legacy `#/analytics/<id>` route.
