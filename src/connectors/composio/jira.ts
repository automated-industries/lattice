/**
 * Jira toolkit spec — the first connected toolkit.
 *
 * Defines six connected data types (projects, issues, comments, users, boards,
 * sprints) and, per model, how to fetch them via Composio actions and map the
 * raw result into normalized records. The natural key (a stable Jira id/key) is
 * each table's primary key, so re-syncs upsert idempotently.
 *
 * NOTE: the Composio action slugs and their response shapes below are the one
 * part of this feature that cannot be verified without the live Composio Jira
 * toolkit. The mappers are defensive (they unwrap common envelopes and read the
 * standard Jira REST fields), but confirm the slugs + paging against the toolkit
 * before release. Adding Gmail/Slack/Zoom later is a sibling file like this one.
 */

import type { Lattice } from '../../lattice.js';
import type { TableDefinition } from '../../types.js';
import type { ConnectedModelDef, ExternalRecord } from '../types.js';
import { registerToolkit } from './adapter.js';
import type { ToolkitSpec, ModelFetchSpec } from './adapter.js';

const PAGE_SIZE = 50;

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
      connector: 'composio',
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
comments.parent = { table: 'jira_issues', keyColumn: 'issue_key', childColumn: 'issue_key' };

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

/** All six Jira connected models, in dependency order (parents before children). */
export const JIRA_MODELS: ConnectedModelDef[] = [
  users,
  projects,
  boards,
  sprints,
  issues,
  comments,
];

// --- Fetch + map helpers ------------------------------------------------------

/** Unwrap the common Composio response envelopes to the inner Jira payload. */
function unwrap(data: unknown): Record<string, unknown> {
  let d = data as Record<string, unknown> | null;
  if (d && typeof d === 'object' && 'data' in d && d.data && typeof d.data === 'object') {
    d = d.data as Record<string, unknown>;
  }
  if (d && typeof d === 'object' && 'response_data' in d && d.response_data) {
    d = d.response_data as Record<string, unknown>;
  }
  return d ?? {};
}

/** Pull a result array from an unwrapped payload by trying known keys. */
function pickArray(payload: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  for (const k of keys) {
    if (Array.isArray(payload[k])) return payload[k] as Record<string, unknown>[];
  }
  return [];
}

/**
 * Offset-paging: compute the next cursor from the response's own
 * `startAt`/`total`/`isLast` (Jira echoes these), so `map` needs no prior cursor.
 */
function nextOffsetCursor(payload: Record<string, unknown>, fetched: number): string | null {
  if (payload.isLast === true) return null;
  const startAt = typeof payload.startAt === 'number' ? payload.startAt : 0;
  const total = typeof payload.total === 'number' ? payload.total : undefined;
  const next = startAt + (fetched || PAGE_SIZE);
  if (total !== undefined) return next < total ? String(next) : null;
  // No total provided: stop when a short (last) page comes back.
  return fetched < PAGE_SIZE ? null : String(next);
}

const str = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v as string | number | boolean);
};

/** Build an offset-paged fetch spec from an arg-builder + a per-item mapper. */
function offsetFetch(
  action: string,
  arrayKeys: string[],
  buildArgs: (startAt: number) => Record<string, unknown>,
  mapItem: (item: Record<string, unknown>) => ExternalRecord | null,
): ModelFetchSpec {
  return {
    action,
    args: (cursor) => buildArgs(Number(cursor) || 0),
    map: (data) => {
      const payload = unwrap(data);
      const items = pickArray(payload, arrayKeys);
      const records = items.map(mapItem).filter((r): r is ExternalRecord => r !== null);
      return { records, nextCursor: nextOffsetCursor(payload, items.length) };
    },
  };
}

// --- The toolkit spec ---------------------------------------------------------

const fetch: Record<string, ModelFetchSpec> = {
  user: offsetFetch(
    'JIRA_GET_ALL_USERS',
    ['users', 'values'],
    (startAt) => ({ startAt, maxResults: PAGE_SIZE }),
    (u) => {
      const id = str(u.accountId ?? u.account_id);
      if (!id) return null;
      return {
        id,
        row: {
          account_id: id,
          display_name: str(u.displayName ?? u.display_name),
          email: str(u.emailAddress ?? u.email),
          active: u.active ? 1 : 0,
        },
      };
    },
  ),
  project: offsetFetch(
    'JIRA_GET_ALL_PROJECTS',
    ['values', 'projects'],
    (startAt) => ({ startAt, maxResults: PAGE_SIZE }),
    (p) => {
      const key = str(p.key ?? p.project_key);
      if (!key) return null;
      const lead = p.lead as Record<string, unknown> | undefined;
      return {
        id: key,
        row: {
          project_key: key,
          project_id: str(p.id),
          name: str(p.name),
          description: str(p.description),
          lead_account_id: str(lead?.accountId),
          project_type: str(p.projectTypeKey ?? p.project_type),
          url: str(p.self ?? p.url),
        },
      };
    },
  ),
  board: offsetFetch(
    'JIRA_GET_ALL_BOARDS',
    ['values', 'boards'],
    (startAt) => ({ startAt, maxResults: PAGE_SIZE }),
    (b) => {
      const id = str(b.id ?? b.board_id);
      if (!id) return null;
      const loc = b.location as Record<string, unknown> | undefined;
      return {
        id,
        row: {
          board_id: id,
          name: str(b.name),
          board_type: str(b.type ?? b.board_type),
          project_key: str(loc?.projectKey ?? b.project_key),
        },
      };
    },
  ),
  sprint: offsetFetch(
    'JIRA_GET_ALL_SPRINTS',
    ['values', 'sprints'],
    (startAt) => ({ startAt, maxResults: PAGE_SIZE }),
    (s) => {
      const id = str(s.id ?? s.sprint_id);
      if (!id) return null;
      return {
        id,
        row: {
          sprint_id: id,
          name: str(s.name),
          state: str(s.state),
          board_id: str(s.originBoardId ?? s.board_id),
          start_date: str(s.startDate ?? s.start_date),
          end_date: str(s.endDate ?? s.end_date),
          goal: str(s.goal),
        },
      };
    },
  ),
  issue: offsetFetch(
    'JIRA_SEARCH_FOR_ISSUES_USING_JQL',
    ['issues'],
    (startAt) => ({ jql: 'ORDER BY created ASC', startAt, maxResults: PAGE_SIZE }),
    (it) => {
      const key = str(it.key ?? it.issue_key);
      if (!key) return null;
      const f = (it.fields as Record<string, unknown> | undefined) ?? it;
      const get = (o: unknown, k: string): unknown =>
        (o as Record<string, unknown> | undefined)?.[k];
      const labels = Array.isArray(f.labels) ? JSON.stringify(f.labels) : null;
      return {
        id: key,
        row: {
          issue_key: key,
          issue_id: str(it.id),
          project_key: str(get(f.project, 'key')),
          summary: str(f.summary),
          description: typeof f.description === 'string' ? f.description : str(f.description),
          status: str(get(f.status, 'name')),
          issue_type: str(get(f.issuetype, 'name')),
          priority: str(get(f.priority, 'name')),
          assignee_id: str(get(f.assignee, 'accountId')),
          reporter_id: str(get(f.reporter, 'accountId')),
          sprint_id: str(get(f.sprint, 'id')),
          labels,
          url: str(it.self),
        },
      };
    },
  ),
  comment: {
    // Comments are fetched per-issue; the sync engine passes the issue key as
    // `parentKey`, which becomes the `issueIdOrKey` action argument.
    action: 'JIRA_GET_COMMENTS',
    args: (cursor, parentKey) => ({
      issueIdOrKey: parentKey,
      startAt: Number(cursor) || 0,
      maxResults: PAGE_SIZE,
    }),
    map: (data) => {
      const payload = unwrap(data);
      const items = pickArray(payload, ['comments', 'values']);
      const records = items
        .map((c): ExternalRecord | null => {
          const id = str(c.id ?? c.comment_id);
          if (!id) return null;
          const author = c.author as Record<string, unknown> | undefined;
          return {
            id,
            row: {
              comment_id: id,
              issue_key: str(c.issue_key ?? c.issueKey),
              author_id: str(author?.accountId),
              body: typeof c.body === 'string' ? c.body : str(c.body),
            },
          };
        })
        .filter((r): r is ExternalRecord => r !== null);
      return { records, nextCursor: nextOffsetCursor(payload, items.length) };
    },
  },
};

export const JIRA_TOOLKIT: ToolkitSpec = { toolkit: 'jira', models: JIRA_MODELS, fetch };

/** Register the Jira toolkit with the Composio connector (idempotent). */
export function registerJiraToolkit(): void {
  registerToolkit(JIRA_TOOLKIT);
}

/**
 * Define the six Jira connected tables on a live database (post-init), skipping
 * any that already exist. Called before the first sync / on connector setup.
 */
export async function defineJiraTables(db: Lattice): Promise<void> {
  for (const m of JIRA_MODELS) {
    await db.defineLate(m.table, m.definition);
  }
}
