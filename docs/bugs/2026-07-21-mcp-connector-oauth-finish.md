# MCP connector OAuth "finish" fails with a swallowed, unlogged exception

- **Date:** 2026-07-21
- **Area:** GUI — MCP connector OAuth callback (`/api/connectors/oauth/callback`)
- **Severity:** High (blocks MCP connectors on affected setups; the failure is undiagnosable because the exception is never logged)

## Symptom

Connecting a workspace to an MCP connector (e.g. Atlassian Jira MCP) fails at the OAuth callback:
the browser authorization succeeds and redirects back with `code`+`state`, but the server-side finish
throws and the browser shows `Failed to finish connecting. Check the Lattice logs and try again.` No
connector is persisted (`__lattice_connectors` stays empty).

## Two coupled defects

### 5a — the exception was swallowed (diagnosability)

The 500 page says "check the Lattice logs," but the callback's `catch` wrote **nothing** — no
`console.error`, no stack, no log line. Every MCP-connect finish failure was a black box, confirmed by
capturing the app's full stdout/stderr across a failed attempt (only the startup banner + a benign
auto-update warning appeared).

### 5b — DCR client reuse against a changing loopback `redirect_uri` (functional)

The root cause was isolated by driving the **same** built-in connector directly from the SDK against
the same server, which **succeeds** end-to-end (`beginConnect` → `completeConnect` → `introspect`).
The only differences from the failing desktop run were a **fresh** dynamic-registration (DCR) client
bound to a **stable** loopback `redirect_uri`, versus the desktop's **reused** DCR client bound to an
**earlier ephemeral callback port**. A desktop app serves the loopback callback on a new ephemeral
port each launch; a strict authorization server (Atlassian matches `redirect_uri` exactly) then
rejects the reused client's stale `redirect_uri` with `invalid_grant` — which 5a rendered opaque.

## Fix

- **5a — log it.** The callback `catch` now writes the error message + stack + `cause` to stderr
  first, before any cleanup that could itself throw and hide the original.
- **Classify actionable OAuth errors.** `connectFailureHint()` maps common causes (used/expired code,
  `redirect_uri` mismatch, client rejected, timeout) to a curated 422 message so the UI shows the real
  reason; unknown causes fall to the now-logged 500.
- **5b — re-register on redirect change.** `LatticeOAuthProvider.clientInformation()` discards a
  stored DCR client whose recorded `redirect_uri` no longer matches the one about to be presented, so
  the SDK re-registers with the **current** `redirect_uri` instead of reusing a client the server will
  reject. `saveClientInformation()` records the bound `redirect_uri` even when the DCR response omits
  it. A no-op when the port is stable.

Further hardening the report suggests — a fixed callback port / RFC 8252 port-agnostic loopback
matching, and explicit timeouts around MCP `initialize`/introspect with cleanup of a token that has no
`__lattice_connectors` row — is a follow-up; 5a's logging now makes the exact remaining failure mode
observable in the field.

## Lessons learned

- "Check the logs" is a lie if the catch swallows the error. Log before you cleanup.
- A stored OAuth client is bound to the `redirect_uri` it registered with; an app whose loopback port
  changes must re-register, not reuse.

## Regression tests

- `tests/unit/connectors-routes.test.ts` — `connectFailureHint` classifies used/expired-code,
  redirect mismatch, client-rejected, and timeout as actionable; returns null (→ logged 500) for an
  unknown cause.
- `tests/unit/mcp-connectors.test.ts` — a stored DCR client is discarded when the loopback port
  changes (reused when it's stable), and `saveClientInformation` records the `redirect_uri` even when
  the response omits it.
