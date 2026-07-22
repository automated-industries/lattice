# MCP Connectors

Connectors sync data from external systems into Lattice as **connected data
types** — tables whose rows are ingested from a source rather than authored
locally. Every connector is an **MCP connection**: Lattice runs as a local
[Model Context Protocol](https://modelcontextprotocol.io) client and talks to
the server directly from your machine. There is no provider-specific connector
code and no broker — a provider is just another MCP server URL, and the same
introspective engine turns whatever that server exposes into typed tables.

## Connecting a server (GUI)

Open **Configure → MCP Connectors**. This tab has two parts: a **catalog** of
services you can connect with one click, and the classic **paste-a-URL** field
for any server not in the catalog. Every connection you already have is listed
here too — name (the server's self-reported name from the MCP handshake), URL,
status, last sync, and per-server **Refresh** / **Disconnect** / **Reconnect**
actions.

### The catalog

The catalog shows a **curated flagship set** — one card per well-known service,
each with its own icon and a short note about what it needs to connect — plus a
**browse more** section populated from the public MCP registry. Picking a card
pre-fills the connect flow with that service's pinned server URL and requested
OAuth scopes, so you don't have to look them up. There is no bespoke code behind
a card: a card is pure metadata that posts its URL to the same generic connect
flow a pasted URL uses.

Cards fall into two connect styles depending on what the provider's
authorization server supports:

- **One-click** — for providers that support dynamic client registration (or a
  client-ID metadata document). Click the card, approve the provider's sign-in
  in your browser, and the first sync runs. No credentials to obtain.
- **Guided connect** — for providers that require a **pre-registered OAuth
  client**. The card's Connect reveals **client ID / client secret** fields;
  create an OAuth client in the provider's admin console, paste its credentials,
  and the same OAuth sign-in runs with them. The card's note and help link point
  you at the provider's setup docs.

The "browse more" registry data is metadata only, and it is fetched in the
background — the catalog is never blocked on (or failed by) a slow or
unreachable registry. If a fetch fails, the last-good list (or the curated set
alone) is shown. Set **`LATTICE_MCP_CATALOG=off`** to skip the registry entirely
and show only the curated flagship cards.

### Paste any server URL

To add a server that isn't in the catalog, paste its URL into **Add an MCP
connector** and click **Connect** — this path is unchanged:

- **Open servers** (no auth) connect and sync immediately.
- **OAuth servers** open the provider's own sign-in in your browser. Approve it
  and return to Lattice — the connection completes on a loopback callback and
  the first sync runs.
- **Servers that require a pre-registered OAuth client** (no dynamic
  registration and no client-ID-metadata-document support) get a clear prompt:
  the form reveals **client ID / client secret** fields for the credentials the
  provider issued you, then the same OAuth sign-in runs with them.

Each added server is its own connection — connect as many as you like, side by
side. Every connection's synced tables **group under their own header** in the
data sidebar, so two servers never blur together. **Disconnect** soft-deletes
the synced rows (recoverable), prunes their rendered context, revokes the stored
tokens, and keeps the server URL so **Reconnect** can re-run the sign-in without
re-entering anything.

## How OAuth client identity works

Lattice identifies itself to a provider's authorization server using the first
mechanism the server supports, in this order:

1. **A stored client** — either from a previous dynamic registration or the
   client ID you entered by hand.
2. **Client-ID metadata document (CIMD)** — the modern MCP mechanism: the
   client_id IS a stable HTTPS URL pointing at a static JSON document that
   describes the app (name, redirect URIs, grant types). Lattice's document is
   hosted at `https://latticedesktop.com/oauth/client-metadata.json`.
3. **Dynamic client registration** (RFC 7591), for servers that offer a
   registration endpoint.

Every flow is a PKCE (S256) authorization-code flow for a public client; tokens
are refreshed automatically.

### The privacy model

The hosted metadata document is **static app identity, not a data plane**:

- It is the same fixed file for every Lattice install, contains **zero user
  data**, and is never written.
- Only the **provider's authorization server** fetches it (to answer "who is
  this client asking for access?"). Your machine and your browser never touch
  the hosting domain during the flow.
- MCP traffic flows **directly** between your local Lattice and the MCP server —
  nothing is proxied through any Lattice-hosted service. This holds for catalog
  connections too: the catalog supplies only the URL and scopes; the connection
  itself is still machine-to-server.
- OAuth tokens live only in the machine-local encrypted credential store
  (AES-256-GCM under a machine-local master key). They never enter the
  workspace database, API responses, or logs.

Self-hosters can point `LATTICE_MCP_CLIENT_METADATA_URL` at their own document;
setting it to an empty string disables the mechanism entirely (dynamic
registration and manual client entry still work).

## What gets synced

The connector introspects the server and pulls its readable content into
**typed tables — one per record kind**, namespaced per connection as
`mcp_<server>_<kind>` (for example, a payroll server's `list_deduction_types`
tool becomes a `mcp_<server>_deduction_types` table). Because the tables are
namespaced by connection, two servers that expose the same kind never collide,
and every connection's tables auto-group under their own header in the GUI.

Each typed table carries:

| column        | meaning                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| natural key   | the record's stable id field (`id`/`key`/`uid`/`slug`…), or a synthesized content key when the record has no stable id |
| typed columns | one column per scalar field discovered on the record, with an inferred SQL type (TEXT / INTEGER / REAL)                |
| `data`        | a JSON overflow column holding the raw record — every nested or unmodeled field is preserved here, nothing is lost     |
| `deleted_at`  | lifecycle column; a re-sync soft-deletes rows that vanished from the source                                            |

Rows are full Lattice rows: queryable, full-text searchable (on the record's
main text fields), rendered to context, per-member `private` by default, and
stamped with immutable source lineage. A re-sync upserts on the natural key and
soft-deletes rows that disappeared from the source.

### The adaptive schema engine

Lattice does not need a hand-written schema for a server. At connect time — and
again on later syncs — it works out each record kind and its columns:

- **Declared output schema first.** If a read tool advertises an `outputSchema`,
  Lattice compiles the table's columns straight from that contract — no call
  needed, and it's correct even for an empty account.
- **Sampling otherwise.** When a tool declares no output schema, Lattice calls
  it once (bounded) and infers typed columns from the returned records. Scalar
  fields become typed columns; nested fields stay in the `data` overflow.
- **Resources as their own table.** The server's advertised resources — its
  "available files," via the standard `resources/list` — are modeled as an
  additional typed table keyed by URI.
- **Two-phase reads for argument-requiring tools.** A useful read tool that
  needs an argument the sampler can't guess (a workspace id, a channel, a cloud
  id) isn't skipped. Lattice runs it in two phases: an argument-free _discovery_
  tool's rows supply the argument for the dependent tool, which then fans out
  once per discovered parent row. Where an argument comes from a fixed set, a
  schema default, or a value you supply once at connect time, that source is
  used instead. An argument that genuinely can't be resolved is surfaced — the
  tool is recorded as unresolved, never silently dropped.

Only read-shaped tools are ever called: tools that look like writes (create,
update, delete, send, …) are never invoked, and per-tool and per-sync item caps
keep a chatty server from flooding the local database.

### Re-adapting when the server changes

The schema isn't frozen at connect time. On the stale/refresh cadence, each sync
re-discovers the live server and **additively migrates** the connection's tables:

- New record kinds the server started exposing become new tables.
- New fields on an existing kind become new columns.
- A kind that **vanished** from the server is **frozen**, not deleted — its
  table and rows are kept exactly as they were, and syncing simply stops writing
  to it. Data is never destroyed because a server changed its tool surface.

Freshness is pull-based — there is no background scheduler. Syncs run on connect,
on **Refresh**, and on GUI load when the last sync is older than an hour.

## Library API

The same engine is a library surface:

```typescript
import {
  genericConnector,
  createConnector,
  syncConnector,
  syncIfStale,
  disconnectConnector,
} from 'latticesql';

const connector = genericConnector();

// GUI-less flows drive beginConnect/completeConnect (OAuth) or connect a local
// stdio server; the registry + sync engine are shared with the GUI routes:
const connectorId = await createConnector(db, {
  connector: 'mcp',
  toolkit: 'mcp',
  displayName: 'My MCP server',
  connectionRef: connectionId,
  connectedBy: 'user-123',
});
await syncConnector(db, connector, connectorId);
await syncIfStale(db, connector, connectorId); // re-sync when stale (1h)
await disconnectConnector(db, connector, connectorId); // soft teardown
```

Library consumers embedding a specific provider can use
`introspectiveConnector(spec)` (the same engine pre-pointed at a fixed endpoint
with its own table name) or `SimpleMcpConnector` (hand-typed models + per-model
tool bindings) — see `src/connectors/types.ts` for the SPI.

On a cloud workspace, the owner's `enableConnectorRls(db, connector, 'mcp')`
scopes connected rows per member (private by default).

> `@modelcontextprotocol/sdk` is an **optional dependency**. The package
> compiles and runs without it; it is loaded lazily and a clear error is thrown
> only when an MCP connector is actually used. Install it to use connectors:
> `npm install @modelcontextprotocol/sdk`.

## Security

- **SSRF guard**: every HTTP hop — the server URL, redirects, and each
  OAuth-discovered endpoint — is DNS-resolved and re-validated against a
  private/loopback/link-local/metadata-address blocklist before it is fetched.
- **Token storage**: machine-local encrypted file, never the shared DB.
- **Error hygiene**: sync errors surfaced in the GUI are sanitized so a raw DB
  constraint error can never echo another member's data.

## Troubleshooting

- **"Incompatible auth server: does not support dynamic client registration"** —
  the server supports neither CIMD nor dynamic registration. The connect form
  reveals client ID/secret fields; create an OAuth client in the provider's
  admin console and paste its credentials. (Catalog cards for these providers
  already use the guided-connect path.)
- **The browser shows a provider error at sign-in** — the provider's
  authorization server could not validate the client. If you overrode
  `LATTICE_MCP_CLIENT_METADATA_URL`, make sure that URL is publicly reachable
  and serves JSON.
- **"Sign-in didn't complete"** — the loopback callback never arrived (browser
  closed mid-flow, or the sign-in was abandoned). Click Connect again.
- **A server connects but syncs nothing** — it may expose only tools whose
  required arguments couldn't be resolved, and no resources. The connection is
  still valid; data arrives once the server offers a discoverable read path or
  you supply the missing connection value at connect time.
- **A table stopped updating but still has rows** — the server stopped exposing
  that kind, so it's frozen. The historical rows are kept intact; the table
  resumes syncing if the server exposes the kind again.
- **The catalog only shows a handful of cards** — the registry "browse more"
  fetch may be disabled (`LATTICE_MCP_CATALOG=off`) or temporarily unreachable.
  The curated flagship cards and the paste-a-URL path always work.
