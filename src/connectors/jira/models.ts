/**
 * Jira connected data types — the six tables the Jira connector syncs.
 *
 * Pure schema: each model's Lattice {@link TableDefinition} (with a `source`
 * descriptor), its natural key (a stable Jira id/key = the primary key, so
 * re-syncs upsert idempotently), and the FK relations that derive graph edges.
 * The fetch/map logic lives in the connector ({@link JiraConnector}), which calls
 * the Jira REST/Agile API directly via `jira.js` — there is no broker.
 */

import type { Lattice } from '../../lattice.js';
import type { TableDefinition } from '../../types.js';
import type { ConnectedModelDef } from '../types.js';

/** Standard lifecycle + lineage columns every connected Jira table carries. */
function baseColumns(naturalKey: string): Record<string, string> {
  return {
    [naturalKey]: 'TEXT PRIMARY KEY',
    deleted_at: 'TEXT',
    created_at: 'TEXT',
    updated_at: 'TEXT',
  };
}

function model(
  table: string,
  modelKey: string,
  naturalKey: string,
  extraColumns: Record<string, string>,
  def: Partial<TableDefinition>,
  graphEdges?: ConnectedModelDef['graphEdges'],
): ConnectedModelDef {
  const definition: TableDefinition = {
    columns: { ...baseColumns(naturalKey), ...extraColumns },
    primaryKey: naturalKey,
    source: {
      connector: 'jira',
      toolkit: 'jira',
      model: modelKey,
      naturalKey,
      defaultVisibility: 'private',
    },
    outputFile: `connectors/jira/${table}.md`,
    ...def,
  };
  return graphEdges
    ? { model: modelKey, table, naturalKey, definition, graphEdges }
    : { model: modelKey, table, naturalKey, definition };
}

// --- The six connected data types --------------------------------------------

const projects = model(
  'jira_projects',
  'project',
  'project_key',
  {
    project_id: 'TEXT',
    name: 'TEXT',
    description: 'TEXT',
    lead_account_id: 'TEXT',
    project_type: 'TEXT',
    url: 'TEXT',
  },
  {
    description: 'Jira projects',
    render: 'default-detail',
    fts: { fields: ['name', 'description'] },
  },
);

const issues = model(
  'jira_issues',
  'issue',
  'issue_key',
  {
    issue_id: 'TEXT',
    project_key: 'TEXT',
    summary: 'TEXT',
    description: 'TEXT',
    status: 'TEXT',
    issue_type: 'TEXT',
    priority: 'TEXT',
    assignee_id: 'TEXT',
    reporter_id: 'TEXT',
    sprint_id: 'TEXT',
    labels: 'TEXT',
    url: 'TEXT',
    updated: 'TEXT',
  },
  {
    description: 'Jira issues',
    render: 'default-detail',
    fts: { fields: ['summary', 'description'] },
    relations: {
      project: {
        type: 'belongsTo',
        table: 'jira_projects',
        foreignKey: 'project_key',
        references: 'project_key',
      },
      assignee: {
        type: 'belongsTo',
        table: 'jira_users',
        foreignKey: 'assignee_id',
        references: 'account_id',
      },
      sprint: {
        type: 'belongsTo',
        table: 'jira_sprints',
        foreignKey: 'sprint_id',
        references: 'sprint_id',
      },
    },
  },
  [
    { fkColumn: 'project_key', dstTable: 'jira_projects', type: 'in_project' },
    { fkColumn: 'assignee_id', dstTable: 'jira_users', type: 'assigned_to' },
    { fkColumn: 'sprint_id', dstTable: 'jira_sprints', type: 'in_sprint' },
  ],
);

const comments = model(
  'jira_comments',
  'comment',
  'comment_id',
  {
    issue_key: 'TEXT',
    author_id: 'TEXT',
    body: 'TEXT',
  },
  {
    description: 'Jira issue comments',
    render: 'default-list',
    fts: { fields: ['body'] },
    relations: {
      issue: {
        type: 'belongsTo',
        table: 'jira_issues',
        foreignKey: 'issue_key',
        references: 'issue_key',
      },
      author: {
        type: 'belongsTo',
        table: 'jira_users',
        foreignKey: 'author_id',
        references: 'account_id',
      },
    },
  },
  [
    { fkColumn: 'issue_key', dstTable: 'jira_issues', type: 'on_issue' },
    { fkColumn: 'author_id', dstTable: 'jira_users', type: 'authored_by' },
  ],
);
// Comments come from the per-issue Jira endpoint: the sync engine iterates the
// already-synced issue keys, passes each as `parentKey`, and stamps it onto the
// comment's `issue_key` FK column.
comments.parent = {
  table: 'jira_issues',
  keyColumn: 'issue_key',
  childColumn: 'issue_key',
  // After the first sync, only re-fetch comments for issues whose `updated`
  // advanced since the last sync (adding a comment bumps the issue's updated).
  incrementalColumn: 'updated',
};

const users = model(
  'jira_users',
  'user',
  'account_id',
  {
    display_name: 'TEXT',
    email: 'TEXT',
    active: 'INTEGER',
  },
  { description: 'Jira users', render: 'default-list' },
);

const boards = model(
  'jira_boards',
  'board',
  'board_id',
  {
    name: 'TEXT',
    board_type: 'TEXT',
    project_key: 'TEXT',
  },
  {
    description: 'Jira agile boards',
    render: 'default-list',
    relations: {
      project: {
        type: 'belongsTo',
        table: 'jira_projects',
        foreignKey: 'project_key',
        references: 'project_key',
      },
    },
  },
  [{ fkColumn: 'project_key', dstTable: 'jira_projects', type: 'board_of' }],
);

const sprints = model(
  'jira_sprints',
  'sprint',
  'sprint_id',
  {
    name: 'TEXT',
    state: 'TEXT',
    board_id: 'TEXT',
    start_date: 'TEXT',
    end_date: 'TEXT',
    goal: 'TEXT',
  },
  {
    description: 'Jira sprints',
    render: 'default-list',
    relations: {
      board: {
        type: 'belongsTo',
        table: 'jira_boards',
        foreignKey: 'board_id',
        references: 'board_id',
      },
    },
  },
  [{ fkColumn: 'board_id', dstTable: 'jira_boards', type: 'in_board' }],
);
// The Jira Agile API lists sprints per board (`getAllSprints({ boardId })`), so
// sprints are a per-parent model: the sync engine iterates the already-synced
// board ids and passes each as `parentKey`, stamped onto the sprint's `board_id`.
sprints.parent = {
  table: 'jira_boards',
  keyColumn: 'board_id',
  childColumn: 'board_id',
};

/** All six Jira connected models, in dependency order (parents before children). */
export const JIRA_MODELS: ConnectedModelDef[] = [
  users,
  projects,
  boards,
  sprints,
  issues,
  comments,
];

/**
 * Define the six Jira connected tables on a live database (post-init), skipping
 * any that already exist. Called before the first sync / on connector setup.
 */
export async function defineJiraTables(db: Lattice): Promise<void> {
  for (const m of JIRA_MODELS) {
    await db.defineLate(m.table, m.definition);
  }
}
