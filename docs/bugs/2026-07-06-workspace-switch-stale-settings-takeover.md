# Switching workspaces left the Settings / Version-history takeover showing the old workspace

**Date:** 2026-07-06
**Area:** GUI client — workspace switch routing (`src/gui/app/modules/search.ts`)
**Severity:** stale/misleading data (a workspace-scoped panel kept showing the previous workspace)

## Symptom

With the **Settings** drawer open (Workspace tab — the workspace name, database
connection, and data model), switching to a different workspace from the topbar
dropdown updated the topbar (it now named the new workspace) but the Settings panel
kept showing the **previous** workspace's data — the topbar named workspace B while the
Workspace Settings display name still showed workspace A. The same happened for any open
takeover: **Version history** kept showing the old workspace's history.

## Root cause

`reloadEverything()` is the single canonical workspace-switch path. To keep the user
in the same section across a switch it computes a `switchTarget` hash from the current
route and navigates there (or soft-re-renders if already on it). The mapping handled
Analytics / Graph / Tables / Objects but had **no case for `#/settings/*`**, so a
settings or version-history route fell through to the `#/folders` default.

The Settings drawer and Version history are **takeover overlays** that the route
dispatcher (re)renders from the hash: `#/settings/database → openSettingsDrawer('database')`,
etc. By routing the switch to `#/folders`, `reloadEverything()` both (a) failed to
re-invoke `openSettingsDrawer` for the new workspace and (b) never closed the drawer —
so the overlay stayed on screen still populated with the previous workspace's
`renderDatabaseSettings` / `renderHistory` output. The panel content is workspace-
specific (name, DB connection, data model, history), so it read as another workspace's
data leaking into the current view.

## Fix

Add a `#/settings/*` case to the `switchTarget` computation that **preserves the exact
route** (`cur`). When the target equals the current hash, `reloadEverything()` takes its
existing "already on target → `renderRoute({ soft: true })`" branch, which re-dispatches
the settings route → `openSettingsDrawer(section)` → `selectDrawerTab` → re-renders the
drawer body (`renderDatabaseSettings` / `renderLatticeSettings` / `renderUserConfig` /
`renderHistory`) against the now-active new workspace. The takeover stays open and shows
the new workspace's data. Version history (`#/settings/history`) is covered by the same
prefix.

## Lessons learned

- A "keep the user in the same section on switch" mapping must account for **every**
  routed surface, including overlay takeovers — not just the main content sections. A
  route that isn't in the mapping silently falls to the default and strands whatever
  overlay was open.
- Overlays that render workspace-scoped data are a cross-workspace-leak risk on switch,
  the same class as the Outputs-markdown leak: the switch path must refresh (or close)
  every workspace-scoped surface, not only the ones rendered into `#content`.

## Regression tests

- `tests/unit/outputs-workspace-switch.test.ts` — "a switch while a Settings /
  Version-history takeover is open re-renders it for the new workspace": drives the real
  `reloadEverything()` in jsdom with `location.hash = '#/settings/database'` and asserts
  the hash is **preserved** (not reset to `#/folders`) and `renderRoute({ soft: true })`
  is called (which re-renders the drawer for the new workspace). Fails before the fix
  (`#/folders`), passes after.
