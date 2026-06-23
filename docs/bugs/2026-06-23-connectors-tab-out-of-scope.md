# Connectors settings tab rendered nothing (`fetchJson is not defined`)

**Date:** 2026-06-23
**Area:** GUI client script composition (`src/gui/app/modules/`)
**Severity:** broken feature (the entire Connectors settings tab was non-functional)

## Symptom

Opening **Settings → Connectors** in the GUI highlighted the tab but left the
drawer body showing whatever tab was previously open (e.g. the Lattice/Workspaces
panel). The connectors panel never appeared. The browser console showed an
uncaught `ReferenceError: fetchJson is not defined`.

## Root cause

The GUI client script (`appJs`) is composed by concatenating per-subsystem module
strings in `src/gui/app/modules/index.ts` and inlining the result into a single
`<script>` tag. The original modules' bodies execute inside a wrapper scope (an
IIFE/`DOMContentLoaded` closure), so their top-level functions — `fetchJson`,
`escapeHtml`, the `render*` panels, `selectDrawerTab` — are **scoped to the
wrapper**, not attached to `window`.

`connectorsSettingsJs` was appended as the **last** element of the composition
array — _after_ the wrapper closes. That placed `renderConnectorsPanel` at true
global scope. It was still reachable from `selectDrawerTab` (a wrapper-scoped
function can call a global one), so clicking the tab invoked it — but its very
first statement, `fetchJson('/api/connectors')`, referenced a name that only
exists inside the wrapper. The `ReferenceError` was thrown synchronously, before
the `.then`/`.catch` chain was attached and before `host.innerHTML` was written,
so the drawer body was never updated and the tab silently showed stale content.

Confirmed at runtime: `typeof window.renderConnectorsPanel === 'function'` while
`typeof window.fetchJson === 'undefined'` — the panel function was the only one
outside the wrapper.

## Fix

Move `connectorsSettingsJs` to sit **inside** the wrapper, next to `tableViewJs`
(which defines `selectDrawerTab`, the dispatcher that calls it). Function
declarations hoist within the wrapper, so `renderConnectorsPanel` can now see
`fetchJson`/`escapeHtml`, and `selectDrawerTab` can still call it. No change to
the panel code itself — purely a composition-order fix.

## Why existing tests missed it

`tests/unit/connectors-panel.test.ts` `eval`s `connectorsSettingsJs` in isolation
with **stubbed** `fetchJson`/`escapeHtml`, so it exercises the panel's markup and
button wiring but not the real composed-scope integration. The
`app-js-composition` test only pins length + hash, not execution. Neither could
observe the cross-module scope boundary.

## Lessons

- A module appended to the composition array is only correct if it lands on the
  right side of the wrapper boundary. New client modules that depend on shared
  helpers must be composed among the wrapped modules, not appended after them.
- Isolated-`eval` unit tests with stubbed globals cannot catch cross-module scope
  bugs. Browser-level coverage is required for "does this tab actually render."

## Regression tests

- `tests/e2e/connectors-settings.spec.ts` — opens the drawer on another tab,
  clicks the Connectors tab, and asserts the Composio panel + Jira card render
  with **no page error**. Verified to fail when the module is appended last
  (the bug) and pass when it is composed inside the wrapper (the fix).
- `tests/unit/app-js-composition.test.ts` — length/hash re-pinned after the
  composition-order change.
