/**
 * The capability manifest: what Lattice can do, and how to do it WITHOUT a server.
 *
 * Lattice's promise is that the browser app is one client and never a requirement.
 * That promise is easy to state and easy to lose: a feature gets built where it is
 * first needed — inside a request handler — and from then on the only way to reach
 * it is to start a server and send yourself an HTTP request. Nothing fails, no test
 * goes red, and the feature is simply unavailable to a script, a command, or a
 * background job. It is a gap that only shows up when somebody tries.
 *
 * This file is the answer to "which of them can I actually do headlessly?". Each
 * entry names a capability and the exported function that performs it, so a caller
 * can go from "the app can do X" to a working call without reading route code.
 *
 * It is SHIPPED SOURCE rather than a test fixture. A manifest kept over in the
 * tests would read as a testing artifact and drift the moment somebody moved a
 * symbol; here it sits beside the code it describes, changes in the same commit,
 * and ships in the build. It is not currently re-exported from the package entry
 * point — the entry point publishes the capabilities themselves, not the catalogue
 * of them — so today its readers are this repo and anyone reading the source.
 *
 * The shape deliberately mirrors the assistant's function registry: declarations
 * only, no handlers, so the manifest stays decoupled from what it describes and can
 * be checked mechanically. Three things are verified on every run, in
 * `tests/unit/mutating-route-census.test.ts`:
 *
 *   1. every `library` symbol is really exported by the module named, and really
 *      re-exported from `src/index.ts` — a claim that a capability is reachable
 *      from a library call is worthless if the symbol is not on the public surface;
 *   2. every `library` module is free of HTTP — otherwise "headless" is a fiction
 *      and importing it drags a server into the caller's process;
 *   3. every `cli` verb really exists in the command dispatcher, and every `ai`
 *      name really exists in the function registry.
 *
 * That test also walks every route that handles a mutating request and requires each
 * one to say which entry here covers it — or to declare, in writing, that it has no
 * headless equivalent yet. So this manifest cannot quietly fall behind the routes:
 * adding a way to change something without adding a way to do it headlessly fails
 * the build.
 *
 * WHAT AN ENTRY CLAIMS, stated precisely, because a vague bar makes the manifest
 * a comfort rather than a fact. An entry means: the named exported function
 * PERFORMS the operation. What stays behind in the route is request parsing,
 * validation, response shaping, and bookkeeping a direct caller does not need. It
 * does NOT mean "you could reassemble this from three exports if you read the
 * handler first" — that is a gap, and a gap is recorded as debt against the route,
 * never dressed up as an entry here.
 */

/** Where a capability's implementation lives: `<path under src/>#<exported symbol>`. */
export type LibraryRef = `${string}.ts#${string}`;

/** Coarse grouping — the surface of the product a capability belongs to. */
export type CapabilityArea =
  | 'row'
  | 'history'
  | 'schema'
  | 'computed-table'
  | 'data-model'
  | 'cloud'
  | 'workspace'
  | 'database'
  | 'account'
  | 'user'
  | 'ingest'
  | 'source-root'
  | 'import'
  | 'connector'
  | 'model'
  | 'voice'
  | 'question'
  | 'analytics'
  | 'app';

export interface Capability {
  /** Stable identifier, `<area>.<operation>` in kebab-case. */
  id: string;
  /** One line: what performing this capability does. */
  summary: string;
  /** The exported function that performs it, as `<module>#<symbol>`. */
  library: LibraryRef;
  /** The command verb that reaches it, when one does. */
  cli?: string;
  /** The assistant tool name that reaches it, when one does. */
  ai?: string;
}

export const CAPABILITIES: readonly Capability[] = [
  // ── Rows ────────────────────────────────────────────────────────────────
  {
    id: 'row.create',
    summary: 'Insert a row, audited and reversible from version history.',
    library: 'gui/mutations.ts#createRow',
    ai: 'create_row',
  },
  {
    id: 'row.update',
    summary: 'Change fields on an existing row, audited and reversible.',
    library: 'gui/mutations.ts#updateRow',
    ai: 'update_row',
  },
  {
    id: 'row.delete',
    summary: 'Remove a row (soft by default, hard on request), audited and reversible.',
    library: 'gui/mutations.ts#deleteRow',
    ai: 'delete_row',
  },
  {
    id: 'row.link',
    summary:
      'Link or unlink two rows across a junction table (see also unlinkRows in the same module).',
    library: 'gui/mutations.ts#linkRows',
    ai: 'link',
  },
  {
    id: 'row.preview-changes',
    summary: 'Resolve what a bulk write would select and change, before making it.',
    library: 'gui/change-preview.ts#previewRowChanges',
  },

  // ── History ─────────────────────────────────────────────────────────────
  {
    id: 'history.undo',
    summary: "Reverse the most recent write in this session's audit stack.",
    library: 'gui/mutations.ts#undoLast',
    ai: 'undo',
  },
  {
    id: 'history.redo',
    summary: 'Re-apply the write that was most recently undone.',
    library: 'gui/mutations.ts#redoLast',
    ai: 'redo',
  },
  {
    id: 'history.undo-group',
    summary: 'Reverse every write sharing one operation group, all or nothing.',
    library: 'gui/mutations.ts#undoGroup',
  },
  {
    id: 'history.revert',
    // Row entries. A SCHEMA entry is reversed by `history.revert-schema` below,
    // and this function says so rather than pretending: handed one, it refuses
    // unless its context carries the schema handler. Stated here because the
    // one-line summary reads as "any entry", and the difference is not a detail
    // — it is the difference between a script that can undo what it just did and
    // one that can undo half of it.
    summary: 'Reverse one specific row-level audit entry, whenever it happened.',
    library: 'gui/mutations.ts#revertEntry',
    ai: 'revert',
  },
  {
    id: 'history.revert-schema',
    // The counterpart, and a separate entry because it is a separate shape: it
    // rewrites the workspace file, may run rename DDL, and hands back the
    // workspace the change left behind — which can be a NEW live workspace, and
    // is the reason it cannot simply live behind the row-level revert. Never a
    // physical drop: deletes here are soft, so reverting one restores the object
    // with its rows rather than an empty shell.
    summary:
      'Reverse — or re-apply — one recorded schema change, and hand back the workspace it left behind.',
    library: 'gui/lifecycle.ts#applySchemaConfig',
  },

  // ── Schema ──────────────────────────────────────────────────────────────
  {
    id: 'schema.create-table',
    summary: 'Create a user table live — DDL, config, context, and a revertible audit op.',
    library: 'gui/schema-ops.ts#createUserEntity',
    ai: 'create_entity',
  },
  {
    id: 'schema.create-junction',
    summary: 'Create a many-to-many junction between two existing tables.',
    library: 'gui/schema-ops.ts#createUserJunction',
    ai: 'create_relationship',
  },
  {
    id: 'schema.delete-table',
    summary:
      'Soft-delete a table so it can still be reverted (see removeInboundLinks for its links).',
    library: 'gui/schema-ops.ts#softDeleteUserEntity',
    ai: 'delete_entity',
  },
  {
    id: 'schema.rename-table',
    summary: 'Rename a table, carrying its column policy and cloud access rules with the name.',
    library: 'gui/schema-ops.ts#renameUserEntity',
    ai: 'rename_entity',
  },
  {
    id: 'schema.add-column',
    summary: 'Add a scalar column live — ALTER, config, cloud masking view, and audit.',
    library: 'gui/schema-ops.ts#addUserColumn',
    ai: 'add_column',
  },
  {
    id: 'schema.rename-column',
    summary: 'Rename a column, carrying its policy across.',
    library: 'gui/schema-ops.ts#renameUserColumn',
    ai: 'rename_column',
  },
  {
    id: 'schema.add-link',
    // The WHOLE link, not the column and not the relation. A link is both: a
    // foreign-key column plus the belongsTo declared over it, added together and
    // recorded as one reversible op, so history undoes it in one step. Pointing
    // this entry at either half alone would be the "reassemble it from three
    // exports" claim the manifest's own bar rules out — and the halves fail in
    // opposite, silent ways: a column nothing reads, or a relation pointing at a
    // column that is not there.
    //
    // The OWNER-ONLY rule on a shared database travels with it too, and had to:
    // this writes the owner's workspace file and adds a column every member then
    // carries, neither of which row security covers, and the library routes a
    // member's ALTER through an owner-side helper rather than refusing it. A gate
    // that had stayed in the request handler would mean the browser refuses what
    // this command performs. It is raised as a tagged failure, so each caller
    // decides what it means on its own transport.
    summary:
      'Nest one table inside another: add the foreign-key column, declare the relation over it, and record the pair as one reversible change — owner-only on a shared database.',
    library: 'gui/schema-ops.ts#addUserLink',
    cli: 'schema',
  },
  {
    id: 'schema.remove-link',
    summary:
      'Un-nest a table: hide the foreign-key field and its relation, keeping the column and its values so the change reverts — owner-only on a shared database.',
    library: 'gui/schema-ops.ts#removeUserLink',
    cli: 'schema',
  },
  {
    id: 'schema.set-column-meta',
    // Masking and defining are one entry because they are one operation: on a
    // shared database the secret flag MASKS the column through the audience view,
    // and the stored flag is what redacts it from the assistant. A caller handed
    // only the metadata write would record "masked" while every member's
    // connection still read the value.
    summary:
      "Write a column's definition, mark it secret, or both — masking it on a shared database before the flag is stored.",
    library: 'gui/schema-ops.ts#setColumnMeta',
    cli: 'schema',
  },
  {
    id: 'schema.set-table-meta',
    // Scoped to what the named function really does: the browsable presentation
    // row (icon + description) that the interface and the assistant read. Writing
    // a definition to the workspace CONFIGURATION as well — which is what the
    // data-model profiler consults — is `setTableDefinition`, a different and
    // larger write, and this entry does not claim it.
    summary: "Set a table's icon and its browsable one-line description.",
    library: 'gui/column-descriptions.ts#upsertTableMeta',
  },
  {
    id: 'schema.merge-tables',
    summary: 'Move every row of one table into another and retire the emptied source, reversibly.',
    library: 'gui/schema-ops.ts#aiDeleteEntity',
    ai: 'delete_entity',
  },
  {
    id: 'schema.purge',
    summary: 'Physically drop an already soft-deleted table (irreversible — reclaims space).',
    library: 'gui/schema-ops.ts#purgeUserEntity',
  },

  // ── Computed tables ─────────────────────────────────────────────────────
  {
    id: 'computed-table.create',
    summary: 'Register a live read-only projection over existing tables.',
    library: 'gui/computed-ops.ts#createComputedTable',
    ai: 'create_computed_table',
  },
  {
    id: 'computed-table.update',
    summary: "Change a computed table's definition and recompile it.",
    library: 'gui/computed-ops.ts#updateComputedTable',
    ai: 'update_computed_table',
  },
  {
    id: 'computed-table.delete',
    summary: 'Unregister a computed table.',
    library: 'gui/computed-ops.ts#deleteComputedTable',
  },
  {
    id: 'computed-table.preview',
    summary: 'Run a proposed computed-table definition and return its rows without committing.',
    library: 'gui/computed-ops.ts#previewComputedTable',
    ai: 'preview_computed_table',
  },
  {
    id: 'computed-table.refresh',
    summary: "Recompute a computed table's model-filled fields.",
    library: 'gui/computed-ops.ts#refreshComputedTable',
    ai: 'refresh_computed_table',
  },

  // ── Data-model planner ──────────────────────────────────────────────────
  {
    id: 'data-model.apply',
    summary: 'Apply one planner proposal (rename, extract dimension, retype) reversibly.',
    library: 'gui/planner/apply.ts#applyPlanOp',
  },
  {
    id: 'data-model.dismiss',
    summary: 'Durably dismiss a planner proposal so it is never re-surfaced.',
    library: 'gui/planner/plan-state.ts#recordDismissal',
  },

  // ── Cloud ───────────────────────────────────────────────────────────────
  {
    id: 'cloud.status',
    summary:
      'Report where the connected role stands on a cloud and what is left unprotected, changing nothing.',
    library: 'cloud/status.ts#cloudStatus',
    cli: 'cloud',
  },
  {
    id: 'cloud.secure',
    summary: 'Install row-level security and the member role model on a cloud database.',
    library: 'cloud/setup.ts#secureCloud',
    cli: 'cloud',
  },
  {
    id: 'cloud.probe',
    summary:
      'Check whether a connection string reaches a usable cloud, without connecting for real.',
    library: 'framework/cloud-connect.ts#probeCloud',
    cli: 'cloud',
  },
  {
    id: 'cloud.migrate',
    // Deliberately the WHOLE move, not the copy. The copy has been a library
    // call for a long time; what only a request handler could do was the last
    // mile — repoint the config, update the registry, retire the local file —
    // which is also the half where a partial failure loses data. Pointing this
    // entry at the copy alone would have been the "reassemble it from three
    // exports" claim the manifest's own bar rules out.
    summary:
      'Move a local workspace onto a shared database: copy it in, secure it, and cut this workspace over — all of it or none of it.',
    library: 'cloud/migrate.ts#migrateWorkspaceToCloud',
    cli: 'cloud',
  },
  {
    id: 'cloud.cutover',
    summary: 'Repoint an existing workspace at an already-populated shared database, reversibly.',
    library: 'cloud/migrate.ts#cutOverWorkspaceToCloud',
  },
  {
    id: 'cloud.join',
    summary:
      'Join a cloud with a scoped credential: probe it, then register and activate it as a workspace.',
    library: 'cloud/join.ts#joinCloud',
  },
  {
    id: 'cloud.redeem-invite',
    summary: 'Redeem an email-bound invite token and join the cloud it points at.',
    library: 'cloud/join.ts#redeemCloudInvite',
    cli: 'cloud',
  },
  {
    id: 'cloud.list-members',
    summary: 'List who is on this cloud — the owner, joined members, and pending invites.',
    library: 'cloud/member-directory.ts#listCloudMembers',
    cli: 'cloud',
  },
  {
    id: 'cloud.invite-member',
    summary:
      'Provision a scoped member role and mint the email-bound token that carries its credential.',
    library: 'cloud/membership.ts#inviteMember',
    cli: 'cloud',
  },
  {
    id: 'cloud.remove-member',
    summary: "Revoke a member's role so their credentials stop working, and close their invites.",
    library: 'cloud/membership.ts#removeMember',
    cli: 'cloud',
  },
  {
    id: 'cloud.row-visibility',
    summary: "Set who can see one row, carrying a newly-shared dashboard's data with it.",
    library: 'cloud/sharing.ts#shareRow',
    cli: 'cloud',
  },
  {
    id: 'cloud.row-grant',
    summary: 'Give one person access to one row, or take it away.',
    library: 'cloud/sharing.ts#grantRowAccess',
    cli: 'cloud',
  },
  {
    id: 'cloud.row-grant-batch',
    summary: "Settle a whole row's audience at once — grant several people, revoke several others.",
    library: 'cloud/sharing.ts#batchRowAccess',
  },
  {
    id: 'cloud.table-default-visibility',
    summary: 'Set the default row visibility new rows in a table get.',
    library: 'cloud/table-policy.ts#setTableDefaultVisibility',
  },
  {
    id: 'cloud.table-never-share',
    summary: 'Mark a table as never shareable, whatever a row says.',
    library: 'cloud/table-policy.ts#setTableNeverShare',
  },
  {
    id: 'cloud.setting',
    summary: 'Read or write a workspace-wide cloud setting (system prompt, logo, and the rest).',
    library: 'cloud/settings.ts#setCloudSetting',
  },
  {
    id: 'cloud.file-storage',
    // The whole configuration, not the store write. A caller handed only the
    // setter would have to re-derive the owner gate, re-derive the merge that
    // stops a partial update erasing the stored secret, and remember to install
    // the in-database presigner — and forgetting the last one leaves every
    // keyless member unable to open a single file, with nothing saying why.
    summary:
      'Point a shared workspace at an object store for its file bytes, and open the in-database presigner so every member can read them.',
    library: 'ops/cloud-storage.ts#configureCloudFileStorage',
  },

  // ── Workspaces + user config ────────────────────────────────────────────
  {
    id: 'workspace.create',
    summary: 'Register a new workspace and scaffold its directory tree, config, and database.',
    library: 'framework/workspace.ts#addWorkspace',
    cli: 'workspace',
  },
  {
    id: 'workspace.create-cloud',
    summary:
      'Register a reachable cloud database as its own workspace, rolling back a half-made one.',
    library: 'framework/cloud-workspace.ts#createCloudWorkspace',
  },
  {
    id: 'workspace.point-at-database',
    summary:
      'Point a workspace at a different database — store the credential, rewrite the config line, and hand back the way back.',
    library: 'framework/db-pointer.ts#pointConfigAtDatabase',
  },
  {
    id: 'workspace.set-active',
    summary:
      'Point the registry at a workspace, so every later open without an explicit id resolves to it.',
    library: 'framework/workspace.ts#setActiveWorkspace',
  },
  {
    id: 'workspace.delete',
    // The WHOLE removal — the registry record AND the files that record owned, in
    // the order that makes the second one correct. Pointing this entry at the
    // registry call alone would be the "reassemble it from three exports" claim
    // the manifest's own bar rules out, and would leave the machine holding a
    // working credential for a shared database its operator was told it had been
    // disconnected from. Which files go is decided per kind, so a workspace whose
    // files were only ever pointed at keeps them.
    summary:
      'Remove a workspace: drop its registry record and take the files it owned — and, for a shared one, the credentials this machine kept in order to reconnect.',
    library: 'ops/workspace-lifecycle.ts#deleteWorkspace',
    cli: 'workspace',
  },
  {
    id: 'workspace.rename',
    // Both writes, because a name that lives in two places has to agree in both.
    // Writing only the configuration leaves the switcher showing the old label
    // forever, which reads as a rename that silently did not happen.
    summary:
      'Rename a workspace: write the name into its own configuration and into the registry record that lists it, reporting whether there was a record to update.',
    library: 'ops/workspace-config.ts#renameWorkspace',
    cli: 'workspace',
  },

  // ── The databases inside a workspace ────────────────────────────────────
  //
  // A workspace holds a SET of databases and opens one at a time. Adding and
  // removing them existed only inside request handlers, so standing a workspace up
  // the way a project expects — or tearing down the one a test made — needed a
  // browser and somebody clicking. The two rules that make a delete safe lived
  // there too, which meant no other caller could inherit them.
  {
    id: 'database.create',
    summary: 'Scaffold a new, empty database beside the others in a workspace.',
    library: 'ops/databases.ts#createDatabase',
    cli: 'database',
  },
  {
    id: 'database.delete',
    // The whole delete, including the two refusals: a target outside the set is
    // rejected rather than unlinked, and the last database in a workspace is kept.
    // Pointing this entry at the unlink helper alone would hand a caller the
    // destructive half with neither safeguard attached.
    summary:
      'Permanently remove one database from a workspace — its config and its local store — refusing anything outside the set, and the last one left.',
    library: 'ops/databases.ts#deleteDatabase',
    cli: 'database',
  },
  {
    id: 'database.test-connection',
    summary:
      'Check whether a local path or a set of Postgres credentials reaches a usable database, reporting the driver’s own reason when it does not.',
    library: 'ops/workspace-config.ts#testDatabaseConnection',
  },

  // ── The account ─────────────────────────────────────────────────────────
  //
  // Signing in looks like the one thing that could never leave a browser, and
  // that impression is what kept all of this inside request handlers. Only the
  // approval page needs a person and a browser, and that page belongs to the
  // account service, not to us. Everything on either side of it — asking for a
  // request, finishing one with the code that approval produced, signing out,
  // pulling invited workspaces down, administering a hosted one — is an ordinary
  // call, and a machine with no display can now make every one of them.
  {
    id: 'account.status',
    summary:
      'Report whether this machine is signed in, as whom, and whether an account service exists at all.',
    library: 'ops/account.ts#readAccountStatus',
    cli: 'account',
  },
  {
    id: 'account.signin-start',
    summary:
      'Start a sign-in and return the URL to approve, remembering the half of the handshake this machine keeps.',
    library: 'ops/account.ts#startAccountSignIn',
    cli: 'account',
  },
  {
    id: 'account.signin-complete',
    // The WHOLE completion, including adopting the account email as this
    // machine's identity where none was set. Pointing this entry at the bare
    // exchange call would be the "reassemble it from three exports" claim the
    // manifest's own bar rules out — and would leave a signed-in machine whose
    // writes are attributed to nobody.
    summary:
      'Finish a sign-in with the approved one-time code: store the session and adopt its identity.',
    library: 'ops/account.ts#completeAccountSignIn',
    cli: 'account',
  },
  {
    id: 'account.signout',
    summary:
      'Sign this machine out and revoke its account-side access, reporting whether the service confirmed it.',
    library: 'ops/account.ts#signOutAccount',
    cli: 'account',
  },
  {
    id: 'account.sync-memberships',
    summary:
      'Materialize every active membership this machine does not hold yet as a workspace, and report revoked ones.',
    library: 'ops/account.ts#syncAccountMemberships',
    cli: 'account',
  },
  {
    id: 'account.list-members',
    summary: 'List who is on this hosted workspace, including invites nobody has accepted yet.',
    library: 'ops/account.ts#listManagedMembers',
    cli: 'account',
  },
  {
    id: 'account.invite-member',
    summary: 'Invite somebody to this hosted workspace by email, through its workspace manager.',
    library: 'ops/account.ts#inviteToManagedWorkspace',
    cli: 'account',
  },
  {
    id: 'account.remove-member',
    summary: 'Remove somebody from this hosted workspace, through its workspace manager.',
    library: 'ops/account.ts#revokeManagedMembership',
    cli: 'account',
  },
  {
    id: 'account.create-workspace',
    summary: 'Create another hosted workspace on this account, through its workspace manager.',
    library: 'ops/account.ts#createManagedWorkspace',
    cli: 'account',
  },

  {
    id: 'user.identity',
    summary: 'Write the machine-local identity (display name + email) writes are attributed to.',
    library: 'framework/user-config.ts#writeIdentity',
  },
  {
    id: 'user.preferences',
    summary: 'Write the machine-local preference store.',
    library: 'framework/user-config.ts#writePreferences',
  },

  // ── Bringing documents in ───────────────────────────────────────────────
  //
  // Every one of these was a request handler, which meant a browser and a
  // drag-and-drop were the only way to get a document into a workspace — for the
  // operation whose most natural caller is a script: a folder of contracts, a
  // nightly export, a pipeline handed a file by something else. The one part
  // that genuinely needs a person is CHOOSING the path, and a caller that
  // already knows the path does not need to be asked.
  {
    id: 'ingest.path',
    // The WHOLE ingest of one named file, not the read: extract, describe,
    // deduplicate, import the data inside it, and link it to the records it is
    // about. Pointing this entry at the extraction alone would be the
    // "reassemble it from three exports" claim the manifest's own bar rules out.
    summary:
      'Bring in one document named by its path — read it, describe it, and link it to the records it is about.',
    library: 'ops/ingest-file.ts#ingestPath',
    cli: 'ingest',
  },
  {
    id: 'ingest.bytes',
    summary:
      'Bring in a document from bytes the caller already holds — no path, no filesystem — through the same pipeline.',
    library: 'ops/ingest-file.ts#ingestBytes',
  },
  {
    id: 'ingest.text',
    summary:
      'Keep a block of text as a document, reading the page at the other end when the text is a web address.',
    library: 'ops/ingest-file.ts#ingestText',
    cli: 'ingest',
    ai: 'ingest_text',
  },
  {
    id: 'source-root.add',
    summary:
      'Register a folder or file on this machine as a source of the workspace, and bring in what is there.',
    library: 'ops/source-roots.ts#addSourceRoot',
    cli: 'ingest',
  },
  {
    id: 'source-root.remove',
    summary:
      'Stop treating a registered folder as a source. The documents already ingested from it are kept.',
    library: 'ops/source-roots.ts#removeSourceRoot',
    cli: 'ingest',
  },
  {
    id: 'source-root.ingest-folder',
    summary:
      'Walk a registered folder and ingest its files — bounded on depth, on files collected, and on files brought in.',
    library: 'ops/source-roots.ts#ingestSourceFolder',
    cli: 'ingest',
  },

  // ── Import + connectors ─────────────────────────────────────────────────
  {
    id: 'import.read-source',
    summary:
      'Read a structured file into records — spreadsheet, CSV, JSON, or a document with tables in it.',
    library: 'ops/import-apply.ts#readImportSource',
    cli: 'import',
  },
  {
    id: 'import.apply',
    // The WHOLE apply, not the materialize inside it. A caller that only
    // materialized would have to infer the schema, match it against what the
    // workspace already holds, split an over-large workbook per sheet, and
    // re-derive the date rule that stops a re-import overwriting the last one —
    // which is exactly the "reassemble it yourself" claim the bar above rules out.
    summary:
      'Turn a source that has been read into tables, rows, and relationships — inference, snapshot dating, and all.',
    library: 'ops/import-apply.ts#applyImport',
    cli: 'import',
  },
  {
    id: 'import.materialize',
    summary: 'Turn an inferred schema and its records into tables, rows, and junctions.',
    library: 'import/materialize.ts#materializeImport',
    ai: 'import_spreadsheet',
  },
  {
    id: 'connector.connect',
    // The WHOLE connect, including the half that cannot be automated — and saying
    // so is the point. A source that connects with credentials, or an MCP server
    // that is open or local, connects outright from this one call. One that needs
    // a person's approval gets the URL to approve back instead of a pretence, and
    // `connector.complete-authorization` finishes it. Pointing this entry at the
    // validation alone would be the "reassemble it from three exports" claim the
    // manifest's own bar rules out.
    summary:
      'Connect an external source: validate it, record it, define and secure its tables, and run the first sync.',
    library: 'ops/connect-source.ts#connectSource',
  },
  {
    id: 'connector.complete-authorization',
    summary:
      'Finish an authorization a person approved elsewhere: record the connection, define its tables, and sync it.',
    library: 'ops/connect-source.ts#completeMcpConnection',
  },
  {
    id: 'connector.connect-database',
    summary:
      'Attach an external Postgres database as a source: introspect its schema, register it, and import its tables.',
    library: 'ops/connect-source.ts#connectDatabaseSource',
    cli: 'connector',
  },
  {
    id: 'connector.reconnect-database',
    summary:
      'Re-point an attached database at edited credentials and re-sync it, keeping its imported tables where they are.',
    library: 'ops/connect-source.ts#reconnectDatabaseSource',
    cli: 'connector',
  },
  {
    id: 'connector.sync',
    summary: 'Pull the current state of one connected source into its mirrored tables.',
    library: 'connectors/sync.ts#syncConnector',
    cli: 'connector',
  },
  {
    id: 'connector.sync-stale',
    summary: 'Sync every connected source whose data is older than the staleness window.',
    library: 'connectors/sync.ts#syncStaleConnectors',
  },
  {
    id: 'connector.refresh-all',
    // The whole pass, not the sync inside it. A caller that only synced would
    // leave a connection made before the current table layout stranded on the old
    // one forever, and would skip securing tables a member's session created on a
    // shared database — two one-time repairs that used to happen only because
    // somebody opened the app.
    summary:
      'Bring every stale source up to date, repairing any that predate the current table layout first.',
    library: 'ops/connect-source.ts#refreshStaleSources',
    cli: 'connector',
  },
  {
    id: 'connector.disconnect',
    summary: 'Disconnect a source and tear down what it created.',
    library: 'connectors/teardown.ts#disconnectConnector',
    cli: 'connector',
  },

  // ── Which model answers ─────────────────────────────────────────────────
  //
  // Every one of these was a request handler, which made a browser the only way
  // to point a machine at a model — the FIRST thing anyone has to do, and the
  // one step a server with no display could not take. They are machine-local
  // writes: nothing about them ever needed a request.
  {
    id: 'model.status',
    summary:
      'Report how this machine reaches a model — which credentials exist, which backend is active, and what is blocking a turn.',
    library: 'ops/ai-config.ts#readModelStatus',
    cli: 'model',
  },
  {
    id: 'model.connect-endpoint',
    // The WHOLE connect, including the verify-and-revert: a bad edit putting back
    // the working configuration it replaced is the half that makes this safe to
    // run unattended, and pointing this entry at the bare setter would be exactly
    // the "reassemble it yourself" claim the manifest's own bar rules out.
    summary:
      'Connect an OpenAI-compatible endpoint as the assistant backend, verifying it answers before keeping it.',
    library: 'ops/ai-config.ts#connectModelEndpoint',
    cli: 'model',
  },
  {
    id: 'model.disconnect-endpoint',
    summary: 'Forget the OpenAI-compatible endpoint and fall back to Claude.',
    library: 'ops/ai-config.ts#disconnectModelEndpoint',
    cli: 'model',
  },
  {
    id: 'model.connect-account',
    summary:
      "Activate the signed-in account's hosted model by minting a scoped, short-lived proxy credential from its session.",
    library: 'ops/ai-config.ts#connectAccountModel',
    cli: 'model',
  },
  {
    id: 'model.disconnect-account',
    summary: "Stop using the account's hosted model and fall back to Claude.",
    library: 'ops/ai-config.ts#disconnectAccountModel',
    cli: 'model',
  },
  {
    id: 'model.select',
    summary:
      'Choose which already-configured backend answers turns, refusing one that has nothing stored.',
    library: 'ops/ai-config.ts#selectModelProvider',
    cli: 'model',
  },
  {
    id: 'model.test',
    summary: 'Ask the active backend to answer one trivial prompt, and report what happened.',
    library: 'ops/ai-config.ts#testModelProvider',
    cli: 'model',
  },
  {
    id: 'model.set-key',
    summary:
      "Save a speech credential machine-level, retiring any legacy copy left in a workspace's secrets.",
    library: 'ops/ai-config.ts#setAssistantApiKey',
    cli: 'model',
  },
  {
    id: 'model.clear-key',
    summary:
      'Clear a speech credential and suppress the environment fallback, so it stays cleared across restarts.',
    library: 'ops/ai-config.ts#clearAssistantApiKey',
    cli: 'model',
  },
  {
    id: 'model.disconnect-subscription',
    summary: 'Disconnect the linked Claude subscription and clear any standing auth warning.',
    library: 'ops/ai-config.ts#disconnectClaudeSubscription',
    cli: 'model',
  },
  {
    id: 'subscription.signin-start',
    // Connecting a subscription looked like the one backend a browser had to own,
    // and the reason was a cookie rather than the flow: the verifier was kept in
    // the browser session, which bound the exchange to the process that started
    // it. Kept in the machine-local store instead, the two legs are two ordinary
    // calls that need not even run on the same machine.
    summary:
      'Begin connecting a Claude subscription: remember this attempt and return the URL to approve.',
    library: 'ops/subscription.ts#startSubscriptionSignIn',
    cli: 'model',
  },
  {
    id: 'subscription.signin-complete',
    // The WHOLE completion: checking the returned code against the attempt in
    // progress, redeeming it, storing the token machine-level, and clearing any
    // standing reconnect warning. Pointing this at the bare exchange call would be
    // the "reassemble it from three exports" claim the manifest's own bar rules
    // out — and would leave a redeemed token nothing had stored.
    summary:
      'Finish connecting a Claude subscription with the approved one-time code, and store the token.',
    library: 'ops/subscription.ts#completeSubscriptionSignIn',
    cli: 'model',
  },
  {
    id: 'voice.transcribe',
    summary:
      'Turn a recording into text using whichever speech credential this machine has, from bytes rather than an upload.',
    library: 'ops/voice.ts#transcribeRecording',
  },

  // ── The clarification queue ─────────────────────────────────────────────
  //
  // When an automated step is confident enough not to drop a guess but not
  // confident enough to act on it, it stops and asks. Both verbs that drain the
  // queue lived in request handlers, so anything running without a browser could
  // be stopped indefinitely by one question nobody was able to reach — and every
  // step waiting behind it stopped with it.
  {
    id: 'question.answer',
    // The whole answer: run the action the question was deferring, persist a
    // free-form reply onto whatever it was about, and only then mark it answered.
    // The ordering is part of the operation — a caller that stamped the status
    // itself would resolve questions whose effects never ran.
    summary:
      'Answer a pending clarifying question: run the action it was holding, keep what the reply says, and resolve it.',
    library: 'gui/questions.ts#answerQuestion',
    cli: 'questions',
  },
  {
    id: 'question.dismiss',
    summary: 'Drop a pending clarifying question without acting on it.',
    library: 'gui/questions.ts#dismissQuestion',
    cli: 'questions',
  },

  // ── Analytics ───────────────────────────────────────────────────────────
  {
    id: 'analytics.query',
    // Deliberately the guarded runner and not a raw query. Every protection the
    // browser surface has — single SELECT only, refused credential/conversation/
    // bookkeeping tables, a read-only transaction on Postgres, a server-side row
    // cap — is inside this function, so reaching it from a script is the same
    // narrow surface rather than a wider one that happens to be easier to call.
    summary:
      'Run one read-only analytical query under the dashboard guardrails, capped and scoped to the connected role.',
    library: 'gui/dashboard-sql.ts#runDashboardSql',
  },

  // ── The app itself ──────────────────────────────────────────────────────
  {
    id: 'app.assistant-turn',
    // The WHOLE turn, not the model call. Deciding which tables the assistant may
    // touch, wiring the primitives it may call, saving the reference material the
    // message carried, running the tool loop, and stopping with an answer — all of
    // it, from one call. What the chat route keeps is transport: the immediate
    // acknowledgement, the socket the browser listens on, the per-workspace queue,
    // the stop registry, and storing the conversation so a reload can replay it.
    // None of that is something a script, a command, or a job needs — it already
    // holds the answer as a value and owns the abort handle for the turn it started.
    summary:
      'Run one assistant turn to completion — its tools, its writes, and its answer — with no browser and no server.',
    library: 'ops/assistant-turn.ts#runAssistantTurn',
    cli: 'ask',
  },
  {
    id: 'app.check-update',
    // Reports; never installs. Both halves together, because either alone is
    // useless: a version with no install context says a release exists but not
    // whether this machine can move to it, and the context with no version says
    // how it would upgrade but not whether there is anything to upgrade to. A
    // registry that could not be answered is reported AS unanswered rather than
    // collapsing into the same "nothing newer" a current copy produces.
    summary:
      'Report whether a newer version is published and what this copy could do about it, without installing anything.',
    library: 'ops/update.ts#checkForNewerVersion',
    cli: 'update',
  },
  {
    id: 'app.self-update',
    // Scoped deliberately to what the named function really does: it reads the
    // installed version out of the current project's node_modules and runs an
    // install of the newer one. A PACKAGED app cannot be updated this way — it
    // has no node_modules to install into and cannot overwrite its own running
    // binary — so this entry does not cover that surface. Replacing a running
    // packaged app is the shell's own business, and the route that drives its
    // installer says so rather than pointing here.
    summary: 'Check npm for a newer latticesql and install it into the current install.',
    library: 'auto-update.ts#autoUpdate',
    cli: 'update',
  },
];

/** Look up a capability by id. Returns undefined for an unknown id. */
export function capability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/** Split a `library` reference into its module path and symbol name. */
export function splitLibraryRef(ref: LibraryRef): { module: string; symbol: string } {
  const at = ref.indexOf('#');
  return { module: ref.slice(0, at), symbol: ref.slice(at + 1) };
}
