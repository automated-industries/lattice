# Connectors

Connectors sync data from external systems into Lattice as **connected data
types** — tables whose rows are ingested from a source rather than authored
locally. They make external data first-class Lattice data: queryable, full-text
searchable, rendered to context, linked on the graph, and ACL-scoped on a cloud.

A _connector_ talks to one external product (a _toolkit_) and exposes its object
types as connected data types. The built-in connector is **Jira**, which talks to
Jira Cloud's REST + Agile APIs directly via [`jira.js`](https://github.com/MrRefactoring/jira.js)
using your own Atlassian credentials — there is no broker service and no extra
API key. Adding another source (Gmail, Slack, …) is a new `Connector`
implementation, not changes to the core.

> `jira.js` is an **optional dependency**. The package compiles and runs without
> it; it is loaded lazily and a clear error is thrown only when the Jira connector
> is actually used. Install it to use the connector: `npm install jira.js`.

## Concepts

| Concept                 | Meaning                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Connector**           | An implementation of the fetch/auth SPI (e.g. the Jira connector).                                                     |
| **Toolkit**             | An external product a connector serves (e.g. `jira`).                                                                  |
| **Connected data type** | A Lattice table with a `source` descriptor — its rows are synced from a toolkit model.                                 |
| **Connector instance**  | A registered connection (`__lattice_connectors` row): which toolkit, the per-member connection handle, and sync state. |

A connected table's **natural key is its primary key** (a stable external id), so
re-syncs upsert idempotently. Every row carries connector lineage:
`_source_connector_id` and `_source_model` (immutable) plus `_source_synced_at`.

## Credentials

The Jira connector authenticates as **you**, with an Atlassian **API token**
(HTTP Basic auth: your account email + the token). Create one at
<https://id.atlassian.com/manage-profile/security/api-tokens>. Lattice validates
the credentials against Jira on connect (`GET /myself`) and stores them in the
**machine-local encrypted credential store** — they never leave the machine
except to call the Jira API directly, and they are never written to the registry,
logs, or any rendered context.

## Using the GUI

Open **Settings → Connectors**, fill in your Jira **site URL**
(`https://your-domain.atlassian.net`), **account email**, and **API token**, then
**Connect**. The credentials are validated and the initial sync runs. Each
connected toolkit shows its status + last-synced time with **Refresh** and
**Disconnect** buttons, and connected data types get a "Connected" badge in the
Objects list.

## Quick start (programmatic)

```typescript
import {
  JiraConnector,
  createConnector,
  syncConnector,
  syncIfStale,
  disconnectConnector,
} from 'latticesql';

const connector = new JiraConnector();

// Validate + store the member's Atlassian credentials, returning a connection handle:
const { connectionId, displayName } = await connector.connect({
  site: 'https://your-domain.atlassian.net',
  email: 'you@example.com',
  apiToken: process.env.JIRA_API_TOKEN!,
});

const connectorId = await createConnector(db, {
  connector: 'jira',
  toolkit: 'jira',
  displayName: displayName ?? 'jira',
  connectionRef: connectionId,
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
full table to diff. Per-parent models iterate the parent's already-synced keys
(comments are fetched per issue; sprints per board).

## Disconnecting

```typescript
await disconnectConnector(db, connector, connectorId, { outputDir });
```

Soft-deletes every ingested row (children before parents), prunes rendered
context files, marks the connector `disconnected` (use `{ mode: 'hard' }` to also
remove the registry row), and drops the stored credentials. Soft-deleted rows
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

Because each member connects with their own Atlassian credentials, the data a
member syncs is already scoped to what they can see in the source — per-user
auth, not a shared admin credential. Derived enrichment over connected rows
inherits the source's visibility automatically: write it through
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
| `jira_sprints`  | sprint id   | fetched per board; edge → board                               |

## Adding a connector

Implement the `Connector` SPI and point the GUI/registry at it. The SPI is small:

- `connector` / `toolkits()` / `models(toolkit)` — identity + the connected
  `ConnectedModelDef`s (table schema, natural key, FK relations → graph edges).
- `listChanges(toolkit, model, ctx)` — an async iterable of normalized
  `ExternalRecord`s for one model, **paged and bounded** (per-parent models read
  `ctx.parentKey`).
- `disconnect(connectionRef)` — revoke / drop the stored connection.
- `authorize` / `completeAuth` — for an OAuth-redirect source. A
  credential-based connector (like Jira) instead exposes a `connect(creds)`
  method that validates + stores the credentials and returns a connection handle;
  the GUI route calls it when the connector supports it.

The sync engine, graph wiring, teardown, and ACL all work from the model
descriptors — no further code is required.

```

```
