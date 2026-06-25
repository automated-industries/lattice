/**
 * Trello connected data types — the eleven tables the Trello connector syncs.
 *
 * Pure schema: each model's Lattice {@link TableDefinition} (with a `source`
 * descriptor), its natural key (a stable Trello id = the primary key, so re-syncs
 * upsert idempotently), and the FK relations that derive graph edges. The
 * fetch/map logic lives in the connector ({@link TrelloConnector}), which calls
 * the Trello REST API directly over the Node global `fetch` — there is no broker
 * and no SDK dependency.
 *
 * Trello's members-on-a-board and members/labels-on-a-card relationships are
 * many-to-many, and `graphEdges` derives one edge per single FK column. So those
 * relationships are modeled as junction tables (`trello_board_members`,
 * `trello_card_members`, `trello_card_labels`) whose composite-key rows each
 * carry the two FK columns that produce real graph edges. A flat
 * `trello_members` identity table holds member profiles (Trello has no global
 * member list, so members are discovered per board).
 */

import type { Lattice } from '../../lattice.js';
import type { TableDefinition } from '../../types.js';
import type { ConnectedModelDef } from '../types.js';

/** Standard lifecycle + lineage columns every connected Trello table carries. */
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
      connector: 'trello',
      toolkit: 'trello',
      model: modelKey,
      naturalKey,
      defaultVisibility: 'private',
    },
    outputFile: `connectors/trello/${table}.md`,
    ...def,
  };
  return graphEdges
    ? { model: modelKey, table, naturalKey, definition, graphEdges }
    : { model: modelKey, table, naturalKey, definition };
}

// --- The eleven connected data types (parents before children) ---------------

// 1. Boards — the top-level fetch (`GET /members/me/boards`).
const boards = model(
  'trello_boards',
  'board',
  'board_id',
  {
    name: 'TEXT',
    description: 'TEXT',
    url: 'TEXT',
    closed: 'INTEGER',
  },
  {
    description: 'Trello boards',
    render: 'default-detail',
    fts: { fields: ['name', 'description'] },
  },
);

// 2. Members — a flat identity table. Trello has no global member list, so
// members are discovered per board; each row stamps the last board it was seen
// on (a benign last-seen pointer, NOT a relationship edge — the real board↔member
// edges live in the junction table below).
const members = model(
  'trello_members',
  'member',
  'member_id',
  {
    username: 'TEXT',
    full_name: 'TEXT',
    child_board_id: 'TEXT',
  },
  { description: 'Trello members', render: 'default-list' },
);
// Fetched per board (`GET /boards/{id}/members`); the sync engine iterates synced
// board ids and stamps each onto `child_board_id` (last-seen, no edge).
members.parent = {
  table: 'trello_boards',
  keyColumn: 'board_id',
  childColumn: 'child_board_id',
};

// 3. Board↔member junction — carries the real board membership edges (M2M).
const boardMembers = model(
  'trello_board_members',
  'board_member',
  'board_member_id',
  {
    board_id: 'TEXT',
    member_id: 'TEXT',
  },
  {
    description: 'Trello board memberships',
    render: 'default-list',
    relations: {
      board: {
        type: 'belongsTo',
        table: 'trello_boards',
        foreignKey: 'board_id',
        references: 'board_id',
      },
      member: {
        type: 'belongsTo',
        table: 'trello_members',
        foreignKey: 'member_id',
        references: 'member_id',
      },
    },
  },
  [
    { fkColumn: 'board_id', dstTable: 'trello_boards', type: 'board_of' },
    { fkColumn: 'member_id', dstTable: 'trello_members', type: 'member_is' },
  ],
);
// Fetched per board; the composite id is `{board}:{member}`, stamped board_id.
boardMembers.parent = {
  table: 'trello_boards',
  keyColumn: 'board_id',
  childColumn: 'board_id',
};

// 4. Lists — columns on a board.
const lists = model(
  'trello_lists',
  'list',
  'list_id',
  {
    board_id: 'TEXT',
    name: 'TEXT',
    pos: 'TEXT',
    closed: 'INTEGER',
  },
  {
    description: 'Trello lists',
    render: 'default-list',
    relations: {
      board: {
        type: 'belongsTo',
        table: 'trello_boards',
        foreignKey: 'board_id',
        references: 'board_id',
      },
    },
  },
  [{ fkColumn: 'board_id', dstTable: 'trello_boards', type: 'in_board' }],
);
lists.parent = {
  table: 'trello_boards',
  keyColumn: 'board_id',
  childColumn: 'board_id',
};

// 5. Labels — defined on a board, applied to cards.
const labels = model(
  'trello_labels',
  'label',
  'label_id',
  {
    board_id: 'TEXT',
    name: 'TEXT',
    color: 'TEXT',
  },
  {
    description: 'Trello labels',
    render: 'default-list',
    fts: { fields: ['name'] },
    relations: {
      board: {
        type: 'belongsTo',
        table: 'trello_boards',
        foreignKey: 'board_id',
        references: 'board_id',
      },
    },
  },
  [{ fkColumn: 'board_id', dstTable: 'trello_boards', type: 'on_board' }],
);
labels.parent = {
  table: 'trello_boards',
  keyColumn: 'board_id',
  childColumn: 'board_id',
};

// 6. Cards — the high-volume model; paged via `before=<oldest-id-seen>`.
const cards = model(
  'trello_cards',
  'card',
  'card_id',
  {
    board_id: 'TEXT',
    list_id: 'TEXT',
    name: 'TEXT',
    description: 'TEXT',
    due: 'TEXT',
    url: 'TEXT',
    last_activity: 'TEXT',
    closed: 'INTEGER',
  },
  {
    description: 'Trello cards',
    render: 'default-detail',
    fts: { fields: ['name', 'description'] },
    relations: {
      board: {
        type: 'belongsTo',
        table: 'trello_boards',
        foreignKey: 'board_id',
        references: 'board_id',
      },
      list: {
        type: 'belongsTo',
        table: 'trello_lists',
        foreignKey: 'list_id',
        references: 'list_id',
      },
    },
  },
  [
    { fkColumn: 'board_id', dstTable: 'trello_boards', type: 'in_board' },
    { fkColumn: 'list_id', dstTable: 'trello_lists', type: 'in_list' },
  ],
);
cards.parent = {
  table: 'trello_boards',
  keyColumn: 'board_id',
  childColumn: 'board_id',
};

// 7. Card↔member junction — assignment edges (M2M).
const cardMembers = model(
  'trello_card_members',
  'card_member',
  'card_member_id',
  {
    card_id: 'TEXT',
    member_id: 'TEXT',
  },
  {
    description: 'Trello card assignments',
    render: 'default-list',
    relations: {
      card: {
        type: 'belongsTo',
        table: 'trello_cards',
        foreignKey: 'card_id',
        references: 'card_id',
      },
      member: {
        type: 'belongsTo',
        table: 'trello_members',
        foreignKey: 'member_id',
        references: 'member_id',
      },
    },
  },
  [{ fkColumn: 'member_id', dstTable: 'trello_members', type: 'assigned_to' }],
);
// Fetched per card; the composite id is `{card}:{member}`, stamped card_id. Only
// re-fetch cards whose activity advanced since the last sync.
cardMembers.parent = {
  table: 'trello_cards',
  keyColumn: 'card_id',
  childColumn: 'card_id',
  incrementalColumn: 'last_activity',
};

// 8. Card↔label junction — label-applied edges (M2M).
const cardLabels = model(
  'trello_card_labels',
  'card_label',
  'card_label_id',
  {
    card_id: 'TEXT',
    label_id: 'TEXT',
  },
  {
    description: 'Trello card labels',
    render: 'default-list',
    relations: {
      card: {
        type: 'belongsTo',
        table: 'trello_cards',
        foreignKey: 'card_id',
        references: 'card_id',
      },
      label: {
        type: 'belongsTo',
        table: 'trello_labels',
        foreignKey: 'label_id',
        references: 'label_id',
      },
    },
  },
  [{ fkColumn: 'label_id', dstTable: 'trello_labels', type: 'has_label' }],
);
cardLabels.parent = {
  table: 'trello_cards',
  keyColumn: 'card_id',
  childColumn: 'card_id',
  incrementalColumn: 'last_activity',
};

// 9. Comments — `commentCard` actions on a card; paged via `before`.
const comments = model(
  'trello_comments',
  'comment',
  'comment_id',
  {
    card_id: 'TEXT',
    member_id: 'TEXT',
    body: 'TEXT',
  },
  {
    description: 'Trello card comments',
    render: 'default-list',
    fts: { fields: ['body'] },
    relations: {
      card: {
        type: 'belongsTo',
        table: 'trello_cards',
        foreignKey: 'card_id',
        references: 'card_id',
      },
      author: {
        type: 'belongsTo',
        table: 'trello_members',
        foreignKey: 'member_id',
        references: 'member_id',
      },
    },
  },
  [
    { fkColumn: 'card_id', dstTable: 'trello_cards', type: 'on_card' },
    { fkColumn: 'member_id', dstTable: 'trello_members', type: 'authored_by' },
  ],
);
comments.parent = {
  table: 'trello_cards',
  keyColumn: 'card_id',
  childColumn: 'card_id',
  incrementalColumn: 'last_activity',
};

// 10. Checklists — on a card.
const checklists = model(
  'trello_checklists',
  'checklist',
  'checklist_id',
  {
    card_id: 'TEXT',
    name: 'TEXT',
  },
  {
    description: 'Trello checklists',
    render: 'default-list',
    fts: { fields: ['name'] },
    relations: {
      card: {
        type: 'belongsTo',
        table: 'trello_cards',
        foreignKey: 'card_id',
        references: 'card_id',
      },
    },
  },
  [{ fkColumn: 'card_id', dstTable: 'trello_cards', type: 'on_card' }],
);
checklists.parent = {
  table: 'trello_cards',
  keyColumn: 'card_id',
  childColumn: 'card_id',
};

// 11. Check-items — entries within a checklist.
const checkitems = model(
  'trello_checkitems',
  'checkitem',
  'checkitem_id',
  {
    checklist_id: 'TEXT',
    name: 'TEXT',
    state: 'TEXT',
  },
  {
    description: 'Trello checklist items',
    render: 'default-list',
    fts: { fields: ['name'] },
    relations: {
      checklist: {
        type: 'belongsTo',
        table: 'trello_checklists',
        foreignKey: 'checklist_id',
        references: 'checklist_id',
      },
    },
  },
  [{ fkColumn: 'checklist_id', dstTable: 'trello_checklists', type: 'in_checklist' }],
);
checkitems.parent = {
  table: 'trello_checklists',
  keyColumn: 'checklist_id',
  childColumn: 'checklist_id',
};

/** All eleven Trello connected models, in dependency order (parents before children). */
export const TRELLO_MODELS: ConnectedModelDef[] = [
  boards,
  members,
  boardMembers,
  lists,
  labels,
  cards,
  cardMembers,
  cardLabels,
  comments,
  checklists,
  checkitems,
];

/**
 * Define the eleven Trello connected tables on a live database (post-init),
 * skipping any that already exist. Called before the first sync / on connector
 * setup.
 */
export async function defineTrelloTables(db: Lattice): Promise<void> {
  for (const m of TRELLO_MODELS) {
    await db.defineLate(m.table, m.definition);
  }
}
