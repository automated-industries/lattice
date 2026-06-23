import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { JIRA_TOOLKIT, JIRA_MODELS, defineJiraTables } from '../../src/connectors/composio/jira.js';

/**
 * 4.3 — Jira toolkit: defines six connected tables and maps Composio action
 * results (standard Jira REST shapes) into normalized records.
 */
describe('Jira toolkit', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('defineJiraTables creates six connected data types', async () => {
    db = new Lattice(':memory:');
    await db.init();
    await defineJiraTables(db);
    const connected = db.connectedTables().sort();
    expect(connected).toEqual(
      [
        'jira_boards',
        'jira_comments',
        'jira_issues',
        'jira_projects',
        'jira_sprints',
        'jira_users',
      ].sort(),
    );
    // each carries a jira source descriptor
    expect(db.getConnectedSource('jira_issues')).toMatchObject({ toolkit: 'jira', model: 'issue' });
    // and is idempotent
    await defineJiraTables(db);
    expect(db.connectedTables()).toHaveLength(6);
  });

  it('maps an issue search response (Jira REST shape) into a row', () => {
    const data = {
      startAt: 0,
      maxResults: 50,
      total: 1,
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
          },
        },
      ],
    };
    const { records, nextCursor } = JIRA_TOOLKIT.fetch.issue!.map(data);
    expect(nextCursor).toBeNull(); // total reached
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
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

  it('computes a next cursor when more pages remain', () => {
    const data = {
      startAt: 0,
      maxResults: 50,
      total: 120,
      issues: Array.from({ length: 50 }, (_, i) => ({ key: `PROJ-${i}`, fields: {} })),
    };
    const { records, nextCursor } = JIRA_TOOLKIT.fetch.issue!.map(data);
    expect(records).toHaveLength(50);
    expect(nextCursor).toBe('50');
  });

  it('maps projects, users, boards, sprints, and comments', () => {
    const proj = JIRA_TOOLKIT.fetch.project!.map({
      values: [{ id: '1', key: 'PROJ', name: 'Project X', lead: { accountId: 'acc-9' } }],
      total: 1,
      startAt: 0,
    });
    expect(proj.records[0]).toMatchObject({
      id: 'PROJ',
      row: { project_key: 'PROJ', name: 'Project X', lead_account_id: 'acc-9' },
    });

    const usr = JIRA_TOOLKIT.fetch.user!.map({
      values: [{ accountId: 'acc-1', displayName: 'Alice', emailAddress: 'a@x.com', active: true }],
    });
    expect(usr.records[0]).toMatchObject({
      id: 'acc-1',
      row: { account_id: 'acc-1', display_name: 'Alice', email: 'a@x.com', active: 1 },
    });

    const brd = JIRA_TOOLKIT.fetch.board!.map({
      values: [{ id: 5, name: 'Board A', type: 'scrum', location: { projectKey: 'PROJ' } }],
      isLast: true,
    });
    expect(brd.records[0]).toMatchObject({
      id: '5',
      row: { board_id: '5', name: 'Board A', board_type: 'scrum', project_key: 'PROJ' },
    });
    expect(brd.nextCursor).toBeNull();

    const spr = JIRA_TOOLKIT.fetch.sprint!.map({
      values: [{ id: 7, name: 'Sprint 1', state: 'active', originBoardId: 5 }],
      isLast: true,
    });
    expect(spr.records[0]).toMatchObject({
      id: '7',
      row: { sprint_id: '7', name: 'Sprint 1', state: 'active', board_id: '5' },
    });

    const cmt = JIRA_TOOLKIT.fetch.comment!.map({
      comments: [
        { id: '900', author: { accountId: 'acc-1' }, body: 'a comment', issueKey: 'PROJ-1' },
      ],
      total: 1,
      startAt: 0,
    });
    expect(cmt.records[0]).toMatchObject({
      id: '900',
      row: { comment_id: '900', author_id: 'acc-1', body: 'a comment', issue_key: 'PROJ-1' },
    });
  });

  it('models are listed parents-before-children for FK-safe sync', () => {
    const order = JIRA_MODELS.map((m) => m.table);
    // issues reference projects/users/sprints; comments reference issues/users
    expect(order.indexOf('jira_users')).toBeLessThan(order.indexOf('jira_issues'));
    expect(order.indexOf('jira_projects')).toBeLessThan(order.indexOf('jira_issues'));
    expect(order.indexOf('jira_issues')).toBeLessThan(order.indexOf('jira_comments'));
  });
});
