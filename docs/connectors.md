# MCP Connectors

Connectors sync data from external systems into Lattice as **connected data
types** — tables whose rows are ingested from a source rather than authored
locally. Every connector is an **MCP connection**: Lattice runs as a local
[Model Context Protocol](https://modelcontextprotocol.io) client and talks to
the server directly from your machine. There is no provider-specific connector
code and no broker — a provider is just another MCP server URL.

## Connecting a server (GUI)

Open **Configure → MCP Connectors**. Every connection you have lives in this
tab: name (the server's self-reported name from the MCP handshake), URL, status,
last sync, and per-server **Refresh** / **Disconnect** / **Reconnect** actions.

To add one, paste the server's URL into **Add an MCP connector** and click
**Connect**:

- **Open servers** (no auth) connect and sync immediately.
- **OAuth servers** open the provider's own sign-in in your browser. Approve it
  and return to Lattice — the connection completes on a loopback callback and
  the first sync runs.
- **Servers that require a pre-registered OAuth client** (no dynamic
  registration and no client-ID-metadata-document support) get a clear prompt:
  the form reveals **client ID / client secret** fields for the credentials the
  provider issued you, then the same OAuth sign-in runs with them.

Each added server is its own connection — connect as many as you like,
side by side. **Disconnect** soft-deletes the synced rows (recoverable), prunes
their rendered context, revokes the stored tokens, and keeps the server URL so
**Reconnect** can re-run the sign-in without re-entering anything.

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
  nothing is proxied through any Lattice-hosted service.
- OAuth tokens live only in the machine-local encrypted credential store
  (AES-256-GCM under a machine-local master key). They never enter the
  workspace database, API responses, or logs.

Self-hosters can point `LATTICE_MCP_CLIENT_METADATA_URL` at their own document;
setting it to an empty string disables the mechanism entirely (dynamic
registration and manual client entry still work).

## What gets synced

The connector introspects the server and pulls its readable content into one
connected table, **`mcp_items`**:

| column    | meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `item_id` | natural key (`<tool>:<id>` for items, `resource:<uri>` for resources) |
| `kind`    | `item` (from a read tool) or `resource` (from `resources/list`)       |
| `tool`    | the MCP tool that produced an item                                    |
| `server`  | the server's hostname — items from different servers stay apart       |
| `title`   | best-effort title                                                     |
| `summary` | best-effort description/snippet                                       |
| `data`    | the raw JSON payload (for resources: `{ uri, mimeType }`)             |

Discovery calls the server's `tools/list`, invokes each **no-argument read
tool** (bounded per tool; obviously write-shaped tools are never called), and
then lists the server's advertised **resources** — its "available files" — via
the standard `resources/list`. Rows are full Lattice rows: queryable, full-text
searchable, rendered to context, per-member `private` by default, and stamped
with immutable lineage (`_source_connector_id`, `_source_model`). A re-sync
upserts on the natural key and soft-deletes rows that vanished from the source.

Freshness is pull-based — there is no background scheduler. Syncs run on
connect, on **Refresh**, and on GUI load when the last sync is older than an
hour.

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
  the server supports neither CIMD nor dynamic registration. The GUI's add form
  reveals client ID/secret fields; create an OAuth client in the provider's
  admin console and paste its credentials.
- **The browser shows a provider error at sign-in** — the provider's
  authorization server could not validate the client. If you overrode
  `LATTICE_MCP_CLIENT_METADATA_URL`, make sure that URL is publicly reachable
  and serves JSON.
- **"Sign-in didn't complete"** — the loopback callback never arrived (browser
  closed mid-flow, or the sign-in was abandoned). Click Connect again.
- **A server connects but syncs nothing** — it may expose only tools that
  require arguments (skipped in introspective mode) and no resources. The
  connection is still valid; data arrives when the server offers no-argument
  read tools or resources.
