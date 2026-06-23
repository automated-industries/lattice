# Connectors

Connectors sync data from external systems into Lattice as **connected data
types** — tables whose rows are ingested from a source rather than authored
locally. They make external data first-class Lattice data: queryable, full-text
searchable, rendered to context, linked on the graph, and ACL-scoped on a cloud.

Lattice ships no per-SaaS API clients of its own. A _connector_ wraps an
integration provider and exposes one or more _toolkits_ (external products). The
built-in connector wraps [Composio](https://composio.dev); the first toolkit is
**Jira**. Adding Gmail, Slack, Zoom, etc. is a new toolkit spec, not new core
code.

> `@composio/core` is an **optional dependency**. The package compiles and runs
> without it; it is loaded lazily and a clear error is thrown only when a
> connector is actually used. Install it to use connectors:
> `npm install @composio/core`.

## Concepts

| Concept                 | Meaning                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Connector**           | An implementation of the fetch/auth SPI (e.g. the Composio connector).                                           |
| **Toolkit**             | An external product a connector serves (e.g. `jira`).                                                            |
| **Connected data type** | A Lattice table with a `source` descriptor — its rows are synced from a toolkit model.                           |
| **Connector instance**  | A registered connection (`__lattice_connectors` row): which toolkit, the per-member auth handle, and sync state. |

A connected table's **natural key is its primary key** (a stable external id), so
re-syncs upsert idempotently. Every row carries connector lineage:
`_source_connector_id` and `_source_model` (immutable) plus `_source_synced_at`.

## Using the GUI

Open **Settings → Connectors**, paste your Composio API key, then **Connect** a
toolkit (Jira). The connect flow opens the Composio OAuth page in a new tab; click
**Finish connecting** when you return and the initial sync runs. Each connected
toolkit shows its status + last-synced time with **Refresh** and **Disconnect**
buttons, and connected data types get a "Connected" badge in the Objects list.

## Quick start (programmatic)

```typescript
import {
  ComposioConnector,
  createConnector,
  syncConnector,
  syncIfStale,
  disconnectConnector,
  setComposioApiKey,
} from 'latticesql';

setComposioApiKey(process.env.COMPOSIO_API_KEY!);
const connector = new ComposioConnector();

// Authorize a member (OAuth via Composio), then finalize the connection:
const { redirectUrl } = await connector.authorize('user-123', 'jira');
// → send the user to redirectUrl; after they return:
const { connectionId } = await connector.completeAuth('user-123', 'jira');

const connectorId = await createConnector(db, {
  connector: 'composio',
  toolkit: 'jira',
  composioConnectionId: connectionId,
  connectedBy: 'user-123',
});

await syncConnector(db, connector, connectorId); // defines the tables + ingests
```

## Sync model

- **`syncConnector(db, connector, connectorId)`** — full sync: paginated +
  bounded fetch per model, idempotent upsert with lineage stamping, soft-delete
  of rows that vanished from the source, and graph-edge derivation from FK
  columns. Records the outcome on the connector; an external-sync failure is
  re-thrown (never swallowed).
- **`syncIfStale(db, connector, connectorId, maxAgeMs?)`** — no-op if the last
  sync is within `maxAgeMs` (default 1 hour). Call it on app load.
- **`syncStaleConnectors(db, connector, maxAgeMs?)`** — sync every stale
  connector this implementation serves. The GUI calls this on load, so connected
  data refreshes hourly **without a scheduler**. Manual refresh forces a sync.

Reads done by the sync engine are bounded and column-projected — it never scans a
full table to diff. Per-parent models (e.g. comments, fetched per issue) iterate
the parent's already-synced keys.

## Disconnecting

```typescript
await disconnectConnector(db, connector, connectorId, { outputDir });
```

Soft-deletes every ingested row (children before parents), prunes rendered
context files, marks the connector `disconnected` (use `{ mode: 'hard' }` to also
remove the registry row), and revokes the backend connection. Soft-deleted rows
drop out of the rendered context, full-text search, and the GUI listings (all of
which filter `deleted_at IS NULL`), and their graph edges are removed — so the
data is no longer available to the agent while remaining physically present and
restorable.

## Cloud ACL

On a cloud (Postgres) workspace, the **owner** scopes connected data per member:

```typescript
await enableConnectorRls(db, connector, 'jira');
```

This enables Row-Level Security on the registry and the toolkit's connected
tables and applies each type's default visibility — `private` (visible only to
the connecting member) or `everyone` (shared with the team). It is a no-op on
SQLite, a non-cloud Postgres, or for a non-owner role.

Because each member authorizes their own account, the data a member syncs is
already scoped to what they can see in the source — per-user OAuth, not a shared
admin credential. Derived enrichment over connected rows inherits the source's
visibility automatically: write it through
`db.observe(table, pk, { changeKind: 'derived', sourceRef: [connectedRowId] })`,
and the source-gated fold hides it from a viewer who can't see the source.

## The Jira toolkit

Connecting Jira creates six connected data types:

| Table           | Natural key | Notes                                                         |
| --------------- | ----------- | ------------------------------------------------------------- |
| `jira_projects` | project key | FTS on name/description                                       |
| `jira_issues`   | issue key   | FTS on summary/description; edges → project, assignee, sprint |
| `jira_comments` | comment id  | fetched per issue; edges → issue, author                      |
| `jira_users`    | account id  |                                                               |
| `jira_boards`   | board id    | edge → project                                                |
| `jira_sprints`  | sprint id   | edge → board                                                  |

## Adding a toolkit or connector

Implement the `Connector` SPI (`authorize` / `completeAuth` / `listChanges` /
`disconnect`) or, for a new Composio toolkit, register a `ToolkitSpec` describing
its connected models and, per model, the Composio action to call, how to page it,
and how to map the result into normalized records:

```typescript
import { registerToolkit } from 'latticesql';

registerToolkit({
  toolkit: 'gmail',
  models: [
    /* ConnectedModelDef[] */
  ],
  fetch: {
    message: {
      action: 'GMAIL_FETCH_MESSAGES',
      args: (cursor) => ({ pageToken: cursor }),
      map: (data) => ({ records: /* … */ [], nextCursor: /* … */ null }),
    },
  },
});
```

The sync engine, graph wiring, teardown, and ACL all work from the model
descriptors — no further code is required.
