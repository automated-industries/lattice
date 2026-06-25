import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { createConnector } from '../../src/connectors/registry.js';
import { syncConnector } from '../../src/connectors/sync.js';
import type { Connector, ConnectedModelDef, ExternalRecord } from '../../src/connectors/types.js';

/**
 * 4.3 — incremental per-parent sync. After the first sync, a per-parent model
 * whose parent declares an `incrementalColumn` only re-fetches children of
 * parents changed since the last sync, and skips pruning (the seen set is then
 * partial, so unchanged parents' children must not be soft-deleted).
 */

function def(
  table: string,
  key: string,
  cols: Record<string, string>,
): ConnectedModelDef['definition'] {
  return {
    columns: { [key]: 'TEXT PRIMARY KEY', deleted_at: 'TEXT', ...cols },
    primaryKey: key,
    source: { connector: 'fake', toolkit: 'demo', model: table, naturalKey: key },
    render: () => '',
    outputFile: `${table}.md`,
  };
}

const MODELS: ConnectedModelDef[] = [
  {
    model: 'task',
    table: 'demo_tasks',
    naturalKey: 'tid',
    definition: def('demo_tasks', 'tid', { title: 'TEXT', updated: 'TEXT' }),
  },
  {
    model: 'comment',
    table: 'demo_comments',
    naturalKey: 'cid',
    definition: def('demo_comments', 'cid', { task_id: 'TEXT', body: 'TEXT' }),
    parent: {
      table: 'demo_tasks',
      keyColumn: 'tid',
      childColumn: 'task_id',
      incrementalColumn: 'updated',
    },
  },
];

const OLD = '2000-01-01T00:00:00.000Z';
const NEW = '2099-01-01T00:00:00.000Z';

class FakeConnector implements Connector {
  readonly connector = 'fake';
  tasks: ExternalRecord[] = [];
  commentsByTask: Record<string, ExternalRecord[]> = {};
  commentFetchParents: string[] = [];
  toolkits() {
    return ['demo'];
  }
  models() {
    return MODELS;
  }
  async authorize() {
    return { redirectUrl: '' };
  }
  async completeAuth() {
    return { connectionId: '' };
  }
  async disconnect() {}
  async *listChanges(
    _t: string,
    model: string,
    ctx: { parentKey?: string },
  ): AsyncIterable<ExternalRecord> {
    if (model === 'task') {
      yield* this.tasks;
    } else if (model === 'comment') {
      this.commentFetchParents.push(ctx.parentKey ?? '');
      yield* this.commentsByTask[ctx.parentKey ?? ''] ?? [];
    }
  }
}

describe('incremental per-parent sync (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('fetches all parents first, then only changed parents; skips prune when incremental', async () => {
    db = new Lattice(':memory:');
    await db.init();
    const fake = new FakeConnector();
    fake.tasks = [
      { id: 'T1', row: { tid: 'T1', title: 'a', updated: OLD } },
      { id: 'T2', row: { tid: 'T2', title: 'b', updated: OLD } },
    ];
    fake.commentsByTask = {
      T1: [{ id: 'C1', row: { cid: 'C1', body: 'on t1' } }],
      T2: [{ id: 'C2', row: { cid: 'C2', body: 'on t2' } }],
    };
    const id = await createConnector(db, {
      connector: 'fake',
      toolkit: 'demo',
      connectionRef: 'conn',
      connectedBy: 'u1',
    });

    // First sync: no prior lastSyncAt → full crawl of comments for every task.
    await syncConnector(db, fake, id);
    expect(fake.commentFetchParents.sort()).toEqual(['T1', 'T2']);
    expect((await db.query('demo_comments', {})).length).toBe(2);

    // Second sync: only T2 changed (updated in the future); T1 stays old.
    fake.commentFetchParents = [];
    fake.tasks = [
      { id: 'T1', row: { tid: 'T1', title: 'a', updated: OLD } },
      { id: 'T2', row: { tid: 'T2', title: 'b', updated: NEW } },
    ];
    const res = await syncConnector(db, fake, id);
    // Only T2's comments were re-fetched.
    expect(fake.commentFetchParents).toEqual(['T2']);
    // Prune was skipped for the incremental comment pass — C1 (T1's comment,
    // never re-fetched) must NOT be soft-deleted.
    expect(res.softDeleted.demo_comments ?? 0).toBe(0);
    const liveComments = await db.query('demo_comments', {
      filters: [{ col: 'deleted_at', op: 'isNull' }],
    });
    expect(liveComments.map((r) => r.cid).sort()).toEqual(['C1', 'C2']);
  });
});
