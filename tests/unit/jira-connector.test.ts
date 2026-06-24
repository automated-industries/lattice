import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { JIRA_MODELS, defineJiraTables } from '../../src/connectors/jira/models.js';
import { JiraConnector } from '../../src/connectors/jira/connector.js';
import type { JiraClient, JiraCreds } from '../../src/connectors/jira/connector.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * 4.3 — Jira connector: defines six connected tables and fetches each model
 * directly from Jira's REST/Agile API (via a fake `JiraClient`), mapping the
 * standard REST shapes into normalized records. Credentials are loaded by the
 * injected loader; the SDK seam (`jira.js`) is never touched in tests.
 */

const CREDS: JiraCreds = { site: 'https://x.atlassian.net', email: 'a@x.com', apiToken: 'tok' };

async function collect(it: AsyncIterable<ExternalRecord>): Promise<ExternalRecord[]> {
  const out: ExternalRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

function fakeClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    myself: () => Promise.resolve({ accountId: 'me', displayName: 'Me' }),
    searchIssues: () => Promise.resolve({ issues: [] }),
    searchProjects: () => Promise.resolve({ values: [] }),
    getComments: () => Promise.resolve({ comments: [] }),
    getAllUsers: () => Promise.resolve([]),
    getAllBoards: () => Promise.resolve({ values: [] }),
    getAllSprints: () => Promise.resolve({ values: [] }),
    ...overrides,
  };
}

/** A connector wired to a fake client + a fixed creds loader. */
function connectorWith(client: JiraClient): JiraConnector {
  return new JiraConnector(
    () => Promise.resolve(client),
    () => CREDS,
  );
}

const ctx = (extra: Partial<ListChangesContext> = {}): ListChangesContext => ({
  connectionId: 'c',
  userId: 'u',
  ...extra,
});

describe('Jira connector', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('defineJiraTables creates six connected data types (idempotent)', async () => {
    db = new Lattice(':memory:');
    await db.init();
    await defineJiraTables(db);
    expect(db.connectedTables().sort()).toEqual(
      [
        'jira_boards',
        'jira_comments',
        'jira_issues',
        'jira_projects',
        'jira_sprints',
        'jira_users',
      ].sort(),
    );
    expect(db.getConnectedSource('jira_issues')).toMatchObject({ toolkit: 'jira', model: 'issue' });
    await defineJiraTables(db);
    expect(db.connectedTables()).toHaveLength(6);
  });

  it('connect() validates via /myself and returns a connection id + display name', async () => {
    const conn = connectorWith(
      fakeClient({ myself: () => Promise.resolve({ displayName: 'Alice' }) }),
    );
    const r = await conn.connect(CREDS);
    expect(r.connectionId).toBeTruthy();
    expect(r.displayName).toBe('Alice');
  });

  it('connect() throws a clear error when /myself fails (bad credentials)', async () => {
    const conn = connectorWith(
      fakeClient({ myself: () => Promise.reject(new Error('401 Unauthorized')) }),
    );
    await expect(conn.connect(CREDS)).rejects.toThrow(/Could not authenticate with Jira/);
  });

  it('listChanges(issue) maps a Jira REST issue into a row', async () => {
    const client = fakeClient({
      searchIssues: () =>
        Promise.resolve({
          issues: [
            {
              id: '10001',
              key: 'PROJ-1',
              self: 'https://x.atlassian.net/rest/api/3/issue/10001',
              fields: {
                summary: 'Fix the thing',
                description: 'a description',
                project: { key: 'PROJ' },
                status: { name: 'In Progress' },
                issuetype: { name: 'Bug' },
                priority: { name: 'High' },
                assignee: { accountId: 'acc-1' },
                reporter: { accountId: 'acc-2' },
                labels: ['backend', 'urgent'],
                updated: '2026-01-01T00:00:00.000Z',
              },
            },
          ],
        }),
    });
    const recs = await collect(connectorWith(client).listChanges('jira', 'issue', ctx()));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      id: 'PROJ-1',
      row: {
        issue_key: 'PROJ-1',
        project_key: 'PROJ',
        summary: 'Fix the thing',
        status: 'In Progress',
        issue_type: 'Bug',
        priority: 'High',
        assignee_id: 'acc-1',
        reporter_id: 'acc-2',
        labels: '["backend","urgent"]',
      },
    });
  });

  it('listChanges(issue) requests an explicit fields list (the enhanced search returns IDs only otherwise)', async () => {
    let captured: { fields?: string[] } | undefined;
    const client = fakeClient({
      searchIssues: (a) => {
        captured = a;
        return Promise.resolve({ issues: [] });
      },
    });
    await collect(connectorWith(client).listChanges('jira', 'issue', ctx()));
    expect(captured?.fields).toBeDefined();
    expect(captured?.fields).toContain('summary');
    expect(captured?.fields).toContain('updated');
  });

  it('listChanges(issue) follows nextPageToken across pages', async () => {
    let calls = 0;
    const client = fakeClient({
      searchIssues: (a) => {
        calls++;
        return a.nextPageToken
          ? Promise.resolve({ issues: [{ key: 'A-2', fields: {} }] })
          : Promise.resolve({ issues: [{ key: 'A-1', fields: {} }], nextPageToken: 'tok2' });
      },
    });
    const recs = await collect(connectorWith(client).listChanges('jira', 'issue', ctx()));
    expect(recs.map((r) => r.id)).toEqual(['A-1', 'A-2']);
    expect(calls).toBe(2);
  });

  it('listChanges maps projects, users, and boards (offset paging)', async () => {
    const proj = await collect(
      connectorWith(
        fakeClient({
          searchProjects: () =>
            Promise.resolve({
              values: [{ id: '1', key: 'PROJ', name: 'Project X', lead: { accountId: 'acc-9' } }],
              total: 1,
            }),
        }),
      ).listChanges('jira', 'project', ctx()),
    );
    expect(proj[0]).toMatchObject({
      id: 'PROJ',
      row: { project_key: 'PROJ', name: 'Project X', lead_account_id: 'acc-9' },
    });

    const usr = await collect(
      connectorWith(
        fakeClient({
          getAllUsers: () =>
            Promise.resolve([
              { accountId: 'acc-1', displayName: 'Alice', emailAddress: 'a@x.com', active: true },
            ]),
        }),
      ).listChanges('jira', 'user', ctx()),
    );
    expect(usr[0]).toMatchObject({
      id: 'acc-1',
      row: { account_id: 'acc-1', display_name: 'Alice', email: 'a@x.com', active: 1 },
    });

    const brd = await collect(
      connectorWith(
        fakeClient({
          getAllBoards: () =>
            Promise.resolve({
              values: [{ id: 5, name: 'Board A', type: 'scrum', location: { projectKey: 'PROJ' } }],
              isLast: true,
            }),
        }),
      ).listChanges('jira', 'board', ctx()),
    );
    expect(brd[0]).toMatchObject({
      id: '5',
      row: { board_id: '5', name: 'Board A', board_type: 'scrum', project_key: 'PROJ' },
    });
  });

  it('listChanges(sprint) fetches per board (parentKey) and stamps board_id', async () => {
    const client = fakeClient({
      getAllSprints: () =>
        Promise.resolve({ values: [{ id: 7, name: 'Sprint 1', state: 'active' }], isLast: true }),
    });
    const recs = await collect(
      connectorWith(client).listChanges('jira', 'sprint', ctx({ parentKey: '5' })),
    );
    expect(recs[0]).toMatchObject({
      id: '7',
      row: { sprint_id: '7', name: 'Sprint 1', state: 'active', board_id: '5' },
    });
    // No board parent → nothing fetched.
    expect(await collect(connectorWith(client).listChanges('jira', 'sprint', ctx()))).toHaveLength(
      0,
    );
  });

  it('listChanges(comment) fetches per issue (parentKey) and stamps issue_key', async () => {
    const client = fakeClient({
      getComments: () =>
        Promise.resolve({
          comments: [{ id: '900', author: { accountId: 'acc-1' }, body: 'a comment' }],
          total: 1,
        }),
    });
    const recs = await collect(
      connectorWith(client).listChanges('jira', 'comment', ctx({ parentKey: 'PROJ-1' })),
    );
    expect(recs[0]).toMatchObject({
      id: '900',
      row: { comment_id: '900', author_id: 'acc-1', body: 'a comment', issue_key: 'PROJ-1' },
    });
  });

  it('listChanges throws when no credentials are stored for the connection', async () => {
    const conn = new JiraConnector(
      () => Promise.resolve(fakeClient()),
      () => null,
    );
    await expect(
      collect(conn.listChanges('jira', 'user', ctx({ connectionId: 'missing' }))),
    ).rejects.toThrow(/No stored Jira credentials/);
  });

  it('models are listed parents-before-children for FK-safe sync', () => {
    const order = JIRA_MODELS.map((m) => m.table);
    expect(order.indexOf('jira_users')).toBeLessThan(order.indexOf('jira_issues'));
    expect(order.indexOf('jira_projects')).toBeLessThan(order.indexOf('jira_issues'));
    expect(order.indexOf('jira_issues')).toBeLessThan(order.indexOf('jira_comments'));
    expect(order.indexOf('jira_boards')).toBeLessThan(order.indexOf('jira_sprints'));
  });
});
