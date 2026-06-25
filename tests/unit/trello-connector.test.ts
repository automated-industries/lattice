import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { TRELLO_MODELS, defineTrelloTables } from '../../src/connectors/trello/models.js';
import { TrelloConnector } from '../../src/connectors/trello/connector.js';
import type { TrelloClient, TrelloCreds } from '../../src/connectors/trello/connector.js';
import type { ExternalRecord, ListChangesContext } from '../../src/connectors/types.js';

/**
 * Trello connector: defines eleven connected tables and fetches each model
 * directly from Trello's REST API (via a fake `TrelloClient`), mapping the
 * standard REST shapes into normalized records. Credentials are loaded by the
 * injected loader; the real `fetch`-backed client is never touched in tests.
 */

const CREDS: TrelloCreds = { apiKey: 'k', token: 'tok' };

async function collect(it: AsyncIterable<ExternalRecord>): Promise<ExternalRecord[]> {
  const out: ExternalRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

function fakeClient(overrides: Partial<TrelloClient> = {}): TrelloClient {
  return {
    me: () => Promise.resolve({ id: 'me', fullName: 'Me' }),
    myBoards: () => Promise.resolve([]),
    boardLists: () => Promise.resolve([]),
    boardMembers: () => Promise.resolve([]),
    boardLabels: () => Promise.resolve([]),
    boardCards: () => Promise.resolve([]),
    cardComments: () => Promise.resolve([]),
    cardMembers: () => Promise.resolve([]),
    cardLabels: () => Promise.resolve([]),
    cardChecklists: () => Promise.resolve([]),
    checklistItems: () => Promise.resolve([]),
    ...overrides,
  };
}

/** A connector wired to a fake client + a fixed creds loader. */
function connectorWith(client: TrelloClient): TrelloConnector {
  return new TrelloConnector(
    () => Promise.resolve(client),
    () => CREDS,
  );
}

const ctx = (extra: Partial<ListChangesContext> = {}): ListChangesContext => ({
  connectionId: 'c',
  userId: 'u',
  ...extra,
});

describe('Trello connector', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('defineTrelloTables creates eleven connected data types (idempotent)', async () => {
    db = new Lattice(':memory:');
    await db.init();
    await defineTrelloTables(db);
    expect(db.connectedTables().sort()).toEqual(
      [
        'trello_boards',
        'trello_members',
        'trello_board_members',
        'trello_lists',
        'trello_labels',
        'trello_cards',
        'trello_card_members',
        'trello_card_labels',
        'trello_comments',
        'trello_checklists',
        'trello_checkitems',
      ].sort(),
    );
    expect(db.getConnectedSource('trello_cards')).toMatchObject({
      toolkit: 'trello',
      model: 'card',
    });
    await defineTrelloTables(db);
    expect(db.connectedTables()).toHaveLength(11);
  });

  it('connect() validates via /members/me and returns a connection id + display name', async () => {
    const conn = connectorWith(fakeClient({ me: () => Promise.resolve({ fullName: 'Ada' }) }));
    const r = await conn.connect({ apiKey: 'k', token: 'tok' });
    expect(r.connectionId).toBeTruthy();
    expect(r.displayName).toBe('Ada');
  });

  it('connect() throws when api key or token is missing', async () => {
    const conn = connectorWith(fakeClient());
    await expect(conn.connect({ apiKey: '', token: 'tok' })).rejects.toThrow(/API key and a token/);
    await expect(conn.connect({ apiKey: 'k', token: '' })).rejects.toThrow(/API key and a token/);
  });

  it('connect() throws a clear error when /members/me fails (bad credentials)', async () => {
    const conn = connectorWith(
      fakeClient({ me: () => Promise.reject(new Error('401 Unauthorized')) }),
    );
    await expect(conn.connect({ apiKey: 'k', token: 'bad' })).rejects.toThrow(
      /Could not authenticate with Trello/,
    );
  });

  it('presentation() returns the Trello label + a data-URI icon', () => {
    const pres = connectorWith(fakeClient()).presentation('trello');
    expect(pres.label).toBe('Trello');
    expect(pres.icon).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('credentialFields() declares an apiKey + token field', () => {
    const fields = connectorWith(fakeClient()).credentialFields();
    expect(fields.map((f) => f.key)).toEqual(['apiKey', 'token']);
    expect(fields.find((f) => f.key === 'token')?.type).toBe('password');
  });

  it('listChanges(board) maps the member’s boards', async () => {
    const client = fakeClient({
      myBoards: () =>
        Promise.resolve([
          {
            id: 'b1',
            name: 'Board One',
            desc: 'a board',
            url: 'https://trello.com/b/b1',
            closed: false,
          },
        ]),
    });
    const recs = await collect(connectorWith(client).listChanges('trello', 'board', ctx()));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      id: 'b1',
      row: {
        board_id: 'b1',
        name: 'Board One',
        description: 'a board',
        url: 'https://trello.com/b/b1',
        closed: 0,
      },
    });
  });

  it('listChanges(member) fetches per board (parentKey) and stamps child_board_id', async () => {
    const client = fakeClient({
      boardMembers: () => Promise.resolve([{ id: 'm1', username: 'alice', fullName: 'Alice' }]),
    });
    const recs = await collect(
      connectorWith(client).listChanges('trello', 'member', ctx({ parentKey: 'b1' })),
    );
    expect(recs[0]).toMatchObject({
      id: 'm1',
      row: { member_id: 'm1', username: 'alice', full_name: 'Alice', child_board_id: 'b1' },
    });
    // No board parent → nothing fetched.
    expect(
      await collect(connectorWith(client).listChanges('trello', 'member', ctx())),
    ).toHaveLength(0);
  });

  it('listChanges(board_member) builds the {board}:{member} junction id', async () => {
    const client = fakeClient({
      boardMembers: () => Promise.resolve([{ id: 'm1' }, { id: 'm2' }]),
    });
    const recs = await collect(
      connectorWith(client).listChanges('trello', 'board_member', ctx({ parentKey: 'b1' })),
    );
    expect(recs.map((r) => r.id)).toEqual(['b1:m1', 'b1:m2']);
    expect(recs[0]).toMatchObject({
      row: { board_member_id: 'b1:m1', board_id: 'b1', member_id: 'm1' },
    });
  });

  it('listChanges(list) fetches per board and stamps board_id', async () => {
    const client = fakeClient({
      boardLists: () =>
        Promise.resolve([{ id: 'l1', name: 'To Do', pos: 16384, closed: false, idBoard: 'b1' }]),
    });
    const recs = await collect(
      connectorWith(client).listChanges('trello', 'list', ctx({ parentKey: 'b1' })),
    );
    expect(recs[0]).toMatchObject({
      id: 'l1',
      row: { list_id: 'l1', board_id: 'b1', name: 'To Do', pos: '16384', closed: 0 },
    });
  });

  it('listChanges(label) fetches per board and maps name + color', async () => {
    const client = fakeClient({
      boardLabels: () =>
        Promise.resolve([{ id: 'lab1', name: 'urgent', color: 'red', idBoard: 'b1' }]),
    });
    const recs = await collect(
      connectorWith(client).listChanges('trello', 'label', ctx({ parentKey: 'b1' })),
    );
    expect(recs[0]).toMatchObject({
      id: 'lab1',
      row: { label_id: 'lab1', board_id: 'b1', name: 'urgent', color: 'red' },
    });
  });

  it('listChanges(card) maps a card and stamps board_id', async () => {
    const client = fakeClient({
      boardCards: () =>
        Promise.resolve([
          {
            id: 'c1',
            name: 'Do the thing',
            desc: 'details',
            due: '2026-02-01T00:00:00.000Z',
            url: 'https://trello.com/c/c1',
            dateLastActivity: '2026-01-15T00:00:00.000Z',
            closed: false,
            idList: 'l1',
            idBoard: 'b1',
          },
        ]),
    });
    const recs = await collect(
      connectorWith(client).listChanges('trello', 'card', ctx({ parentKey: 'b1' })),
    );
    expect(recs[0]).toMatchObject({
      id: 'c1',
      row: {
        card_id: 'c1',
        board_id: 'b1',
        list_id: 'l1',
        name: 'Do the thing',
        description: 'details',
        last_activity: '2026-01-15T00:00:00.000Z',
        closed: 0,
      },
    });
  });

  it('listChanges(card) walks pages via the `before` cursor (oldest id handed off)', async () => {
    // Trello returns newest-first; a full page of PAGE_SIZE forces a follow-up
    // page whose `before` must be the oldest (last) id of the previous page.
    const PAGE = 1000;
    const firstPage = Array.from({ length: PAGE }, (_, i) => ({
      id: `card-${String(PAGE - i)}`, // newest-first: card-1000 … card-1
    }));
    const beforeSeen: (string | undefined)[] = [];
    let call = 0;
    const client = fakeClient({
      boardCards: (_id, opts) => {
        beforeSeen.push(opts.before);
        call++;
        return call === 1 ? Promise.resolve(firstPage) : Promise.resolve([{ id: 'card-0' }]);
      },
    });
    const recs = await collect(
      connectorWith(client).listChanges('trello', 'card', ctx({ parentKey: 'b1' })),
    );
    expect(call).toBe(2);
    // First call: no cursor. Second call: oldest id of page one (the last item).
    expect(beforeSeen).toEqual([undefined, 'card-1']);
    expect(recs).toHaveLength(PAGE + 1);
    expect(recs[recs.length - 1]?.id).toBe('card-0');
  });

  it('listChanges(card_member) builds the {card}:{member} junction id per card', async () => {
    const client = fakeClient({
      cardMembers: () => Promise.resolve([{ id: 'm1' }, { id: 'm2' }]),
    });
    const recs = await collect(
      connectorWith(client).listChanges('trello', 'card_member', ctx({ parentKey: 'c1' })),
    );
    expect(recs.map((r) => r.id)).toEqual(['c1:m1', 'c1:m2']);
    expect(recs[0]).toMatchObject({
      row: { card_member_id: 'c1:m1', card_id: 'c1', member_id: 'm1' },
    });
  });

  it('listChanges(card_label) builds the {card}:{label} junction id per card', async () => {
    const client = fakeClient({
      cardLabels: () => Promise.resolve([{ id: 'lab1' }]),
    });
    const recs = await collect(
      connectorWith(client).listChanges('trello', 'card_label', ctx({ parentKey: 'c1' })),
    );
    expect(recs[0]).toMatchObject({
      id: 'c1:lab1',
      row: { card_label_id: 'c1:lab1', card_id: 'c1', label_id: 'lab1' },
    });
  });

  it('listChanges(comment) fetches per card and maps body + author', async () => {
    const client = fakeClient({
      cardComments: () =>
        Promise.resolve([{ id: 'a1', memberCreator: { id: 'm1' }, data: { text: 'nice work' } }]),
    });
    const recs = await collect(
      connectorWith(client).listChanges('trello', 'comment', ctx({ parentKey: 'c1' })),
    );
    expect(recs[0]).toMatchObject({
      id: 'a1',
      row: { comment_id: 'a1', card_id: 'c1', member_id: 'm1', body: 'nice work' },
    });
  });

  it('listChanges(checklist) fetches per card and maps name', async () => {
    const client = fakeClient({
      cardChecklists: () => Promise.resolve([{ id: 'ck1', name: 'Steps', idCard: 'c1' }]),
    });
    const recs = await collect(
      connectorWith(client).listChanges('trello', 'checklist', ctx({ parentKey: 'c1' })),
    );
    expect(recs[0]).toMatchObject({
      id: 'ck1',
      row: { checklist_id: 'ck1', card_id: 'c1', name: 'Steps' },
    });
  });

  it('listChanges(checkitem) fetches per checklist and maps name + state', async () => {
    const client = fakeClient({
      checklistItems: () =>
        Promise.resolve([{ id: 'ci1', name: 'Step one', state: 'complete', idChecklist: 'ck1' }]),
    });
    const recs = await collect(
      connectorWith(client).listChanges('trello', 'checkitem', ctx({ parentKey: 'ck1' })),
    );
    expect(recs[0]).toMatchObject({
      id: 'ci1',
      row: { checkitem_id: 'ci1', checklist_id: 'ck1', name: 'Step one', state: 'complete' },
    });
  });

  it('listChanges throws when no credentials are stored for the connection', async () => {
    const conn = new TrelloConnector(
      () => Promise.resolve(fakeClient()),
      () => null,
    );
    await expect(
      collect(conn.listChanges('trello', 'board', ctx({ connectionId: 'missing' }))),
    ).rejects.toThrow(/No stored Trello credentials/);
  });

  it('listChanges throws for an unknown toolkit', async () => {
    await expect(
      collect(connectorWith(fakeClient()).listChanges('nope', 'board', ctx())),
    ).rejects.toThrow(/Unknown toolkit/);
  });

  it('models are listed parents-before-children for FK-safe sync', () => {
    const order = TRELLO_MODELS.map((m) => m.table);
    expect(order.indexOf('trello_boards')).toBeLessThan(order.indexOf('trello_lists'));
    expect(order.indexOf('trello_boards')).toBeLessThan(order.indexOf('trello_cards'));
    expect(order.indexOf('trello_boards')).toBeLessThan(order.indexOf('trello_board_members'));
    expect(order.indexOf('trello_members')).toBeLessThan(order.indexOf('trello_board_members'));
    expect(order.indexOf('trello_cards')).toBeLessThan(order.indexOf('trello_card_members'));
    expect(order.indexOf('trello_cards')).toBeLessThan(order.indexOf('trello_card_labels'));
    expect(order.indexOf('trello_cards')).toBeLessThan(order.indexOf('trello_comments'));
    expect(order.indexOf('trello_cards')).toBeLessThan(order.indexOf('trello_checklists'));
    expect(order.indexOf('trello_checklists')).toBeLessThan(order.indexOf('trello_checkitems'));
  });

  it('per-parent models declare their parent table + child column', () => {
    const byTable = new Map(TRELLO_MODELS.map((m) => [m.table, m]));
    expect(byTable.get('trello_lists')?.parent).toMatchObject({
      table: 'trello_boards',
      childColumn: 'board_id',
    });
    expect(byTable.get('trello_checkitems')?.parent).toMatchObject({
      table: 'trello_checklists',
      childColumn: 'checklist_id',
    });
    // Card-children re-fetch incrementally on last_activity.
    expect(byTable.get('trello_comments')?.parent?.incrementalColumn).toBe('last_activity');
  });
});
