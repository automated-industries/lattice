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
  | 'user'
  | 'import'
  | 'connector'
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
    summary: 'Reverse one specific audit entry, whenever it happened.',
    library: 'gui/mutations.ts#revertEntry',
    ai: 'revert',
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
    id: 'user.identity',
    summary: 'Write the machine-local identity (display name + email) writes are attributed to.',
    library: 'framework/user-config.ts#writeIdentity',
  },
  {
    id: 'user.preferences',
    summary: 'Write the machine-local preference store.',
    library: 'framework/user-config.ts#writePreferences',
  },

  // ── Import + connectors ─────────────────────────────────────────────────
  {
    id: 'import.materialize',
    summary: 'Turn an inferred schema and its records into tables, rows, and junctions.',
    library: 'import/materialize.ts#materializeImport',
    ai: 'import_spreadsheet',
  },
  {
    id: 'connector.sync',
    summary: 'Pull the current state of one connected source into its mirrored tables.',
    library: 'connectors/sync.ts#syncConnector',
  },
  {
    id: 'connector.sync-stale',
    summary: 'Sync every connected source whose data is older than the staleness window.',
    library: 'connectors/sync.ts#syncStaleConnectors',
  },
  {
    id: 'connector.disconnect',
    summary: 'Disconnect a source and tear down what it created.',
    library: 'connectors/teardown.ts#disconnectConnector',
  },

  // ── The app itself ──────────────────────────────────────────────────────
  {
    id: 'app.self-update',
    // Scoped deliberately to what the named function really does: it reads the
    // installed version out of the current project's node_modules and runs an
    // install of the newer one. A PACKAGED app cannot be updated this way — it
    // has no node_modules to install into and cannot overwrite its own running
    // binary — so this entry does not cover that surface, and the routes that
    // drive the packaged installer are recorded as gaps rather than pointed here.
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
