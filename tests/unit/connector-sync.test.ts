import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { createConnector, getConnector } from '../../src/connectors/registry.js';
import { syncConnector, syncIfStale } from '../../src/connectors/sync.js';
import type {
  Connector,
  ConnectedModelDef,
  ExternalRecord,
  ListChangesContext,
} from '../../src/connectors/types.js';

/**
 * 4.3 — sync engine end-to-end (SQLite) with a fake connector: idempotent upsert
 * + lineage stamping, per-parent fetch, vanished-row pruning, graph edges,
 * staleness throttling, and loud failure recording.
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
    model: 'project',
    table: 'demo_projects',
    naturalKey: 'pid',
    definition: def('demo_projects', 'pid', { name: 'TEXT' }),
  },
  {
    model: 'task',
    table: 'demo_tasks',
    naturalKey: 'tid',
    definition: def('demo_tasks', 'tid', { title: 'TEXT', pid: 'TEXT' }),
    graphEdges: [{ fkColumn: 'pid', dstTable: 'demo_projects', type: 'in_project' }],
  },
  {
    model: 'comment',
    table: 'demo_comments',
    naturalKey: 'cid',
    definition: def('demo_comments', 'cid', { task_id: 'TEXT', body: 'TEXT' }),
    parent: { table: 'demo_tasks', keyColumn: 'tid', childColumn: 'task_id' },
  },
];

class FakeConnector implements Connector {
  readonly connector = 'fake';
  projects: ExternalRecord[] = [];
  tasks: ExternalRecord[] = [];
  commentsByTask: Record<string, ExternalRecord[]> = {};
  throwOn: string | null = null;

  toolkits(): string[] {
    return ['demo'];
  }
  models(): ConnectedModelDef[] {
    return MODELS;
  }
  async authorize(): Promise<{ redirectUrl: string }> {
    return { redirectUrl: '' };
  }
  async completeAuth(): Promise<{ connectionId: string }> {
    return { connectionId: '' };
  }
  async disconnect(): Promise<void> {}

  async *listChanges(
    _toolkit: string,
    model: string,
    ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    if (this.throwOn === model) throw new Error(`boom on ${model}`);
    if (model === 'project') yield* this.projects;
    else if (model === 'task') yield* this.tasks;
    else if (model === 'comment') yield* this.commentsByTask[ctx.parentKey ?? ''] ?? [];
  }
}

describe('connector sync (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(): Promise<{ db: Lattice; fake: FakeConnector; id: string }> {
    db = new Lattice(':memory:');
    await db.init();
    const fake = new FakeConnector();
    fake.projects = [{ id: 'P1', row: { pid: 'P1', name: 'Alpha' } }];
    fake.tasks = [
      { id: 'T1', row: { tid: 'T1', title: 'do x', pid: 'P1' } },
      { id: 'T2', row: { tid: 'T2', title: 'do y', pid: 'P1' } },
    ];
    fake.commentsByTask = {
      T1: [{ id: 'C1', row: { cid: 'C1', body: 'hi' } }],
      T2: [],
    };
    const id = await createConnector(db, {
      connector: 'fake',
      toolkit: 'demo',
      composioConnectionId: 'conn',
      connectedBy: 'u1',
    });
    return { db, fake, id };
  }

  it('ingests records, stamps lineage, fetches comments per task, derives edges', async () => {
    const { db, fake, id } = await setup();
    const res = await syncConnector(db, fake, id);
    expect(res.upserted).toEqual({ demo_projects: 1, demo_tasks: 2, demo_comments: 1 });
    expect(res.edges).toBe(2); // T1->P1, T2->P1

    const t1 = await db.get('demo_tasks', 'T1');
    expect(t1).toMatchObject({ tid: 'T1', title: 'do x', pid: 'P1' });
    expect(t1!._source_connector_id).toBe(id);
    expect(t1!._source_model).toBe('task');
    expect(typeof t1!._source_synced_at).toBe('string');

    // comment was fetched under its parent task and stamped with task_id
    const c1 = await db.get('demo_comments', 'C1');
    expect(c1).toMatchObject({ cid: 'C1', body: 'hi', task_id: 'T1' });

    // connector marked connected with a sync timestamp
    expect((await getConnector(db, id))?.status).toBe('connected');
    expect((await getConnector(db, id))?.lastSyncAt).toBeTruthy();
  });

  it('is idempotent and SOFT-deletes (not hard-deletes) rows that vanish', async () => {
    const { db, fake, id } = await setup();
    await syncConnector(db, fake, id);
    // T2 disappears from the source
    fake.tasks = [{ id: 'T1', row: { tid: 'T1', title: 'do x (edited)', pid: 'P1' } }];
    const res = await syncConnector(db, fake, id);
    expect(res.upserted.demo_tasks).toBe(1);
    expect(res.softDeleted.demo_tasks).toBe(1);
    expect((await db.get('demo_tasks', 'T1'))!.title).toBe('do x (edited)');
    // Live reads (render/search/GUI filter deleted_at) show only T1...
    const liveRows = await db.query('demo_tasks', {
      filters: [{ col: 'deleted_at', op: 'isNull' }],
    });
    expect(liveRows.map((r) => r.tid)).toEqual(['T1']);
    // ...but T2 is SOFT-deleted: still physically present with deleted_at set (recoverable).
    const t2 = (await db.query('demo_tasks', {})).find((r) => r.tid === 'T2');
    expect(t2).toBeDefined();
    expect(t2!.deleted_at).toBeTruthy();
  });

  it('resurrects a soft-deleted row when it reappears in the source', async () => {
    const { db, fake, id } = await setup();
    const liveTasks = () =>
      db.query('demo_tasks', { filters: [{ col: 'deleted_at', op: 'isNull' }] });
    await syncConnector(db, fake, id); // T1, T2 live
    fake.tasks = [{ id: 'T1', row: { tid: 'T1', title: 'do x', pid: 'P1' } }]; // T2 vanishes
    await syncConnector(db, fake, id); // T2 soft-deleted
    expect((await liveTasks()).map((r) => r.tid)).not.toContain('T2');
    // T2 comes back
    fake.tasks = [
      { id: 'T1', row: { tid: 'T1', title: 'do x', pid: 'P1' } },
      { id: 'T2', row: { tid: 'T2', title: 'back again', pid: 'P1' } },
    ];
    await syncConnector(db, fake, id);
    const t2 = (await liveTasks()).find((r) => r.tid === 'T2');
    expect(t2).toBeDefined(); // resurrected (deleted_at cleared on conflict)
    expect(t2!.title).toBe('back again');
    expect(t2!.deleted_at).toBeNull();
  });

  it('does NOT prune when a sync returns zero rows (guards against a wipe on an empty/failed fetch)', async () => {
    const { db, fake, id } = await setup();
    await syncConnector(db, fake, id);
    // A bad sync: the source returns nothing (shape drift / auth / transient).
    fake.tasks = [];
    fake.projects = [];
    const res = await syncConnector(db, fake, id);
    expect(res.softDeleted.demo_tasks).toBe(0); // skipped, not wiped
    // Existing rows survive (live).
    const liveTasks = await db.query('demo_tasks', {
      filters: [{ col: 'deleted_at', op: 'isNull' }],
    });
    expect(liveTasks.length).toBe(2);
  });

  it('syncIfStale skips a fresh connector and runs a stale one', async () => {
    const { db, fake, id } = await setup();
    await syncConnector(db, fake, id);
    // fresh → null
    expect(await syncIfStale(db, fake, id, 3_600_000)).toBeNull();
    // zero window → treated as stale → runs
    const r = await syncIfStale(db, fake, id, 0);
    expect(r).not.toBeNull();
  });

  it('records and rethrows a fetch failure (loud, not swallowed)', async () => {
    const { db, fake, id } = await setup();
    fake.throwOn = 'task';
    await expect(syncConnector(db, fake, id)).rejects.toThrow(/boom on task/);
    const rec = await getConnector(db, id);
    expect(rec?.status).toBe('error');
    expect(rec?.lastError).toMatch(/boom on task/);
  });
});
