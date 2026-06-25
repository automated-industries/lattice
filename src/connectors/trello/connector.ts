/**
 * The Trello connector — a {@link Connector} that talks to Trello's REST API
 * DIRECTLY over the Node global `fetch`, authenticated with the user's OWN API
 * key + token (passed as `?key=&token=` query params). No broker, no SDK, no
 * extra dependency.
 *
 * The SPI is OAuth-shaped (authorize→redirect→completeAuth); Trello uses direct
 * credentials instead, so `authorize`/`completeAuth` are not part of its flow —
 * the GUI collects the API key + token and calls {@link TrelloConnector.connect},
 * which validates them against Trello and stores them encrypted. `listChanges`
 * (sync) and `disconnect` (teardown) satisfy the SPI normally, keyed by the
 * stored connection. The schema (the eleven connected models) lives in
 * `./models.ts`; this file is the fetch/auth half.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  getAssistantCredential,
  setAssistantCredential,
  deleteAssistantCredential,
} from '../../framework/user-config.js';
import type {
  CredentialConnector,
  CredentialField,
  ConnectedModelDef,
  ExternalRecord,
  AuthorizeResult,
  ConnectionResult,
  ListChangesContext,
  ToolkitPresentation,
} from '../types.js';
import { ConnectorUnavailableError } from '../jira/connector.js';
import { TRELLO_MODELS } from './models.js';
import { TRELLO_ICON } from './icon.js';

/** Trello's REST API base. */
const API_BASE = 'https://api.trello.com/1';
/** Page size for the paged card/comment fetches (Trello caps `limit` at 1000). */
const PAGE_SIZE = 1000;
/** Single-page size for the full-list fetches (boards/lists/members/labels/…). */
const FULL_LIMIT = 1000;
/** Hard cap on pages per paged model sync — a backstop against an unbounded loop. */
const MAX_PAGES = 1000;

/** The user's Trello credentials for one connection. */
export interface TrelloCreds {
  /** Trello API key (from trello.com/power-ups/admin). */
  apiKey: string;
  /** Trello API token authorizing access for this key — a user secret. */
  token: string;
}

// --- Credential storage (machine-local, encrypted) ---------------------------
// The token is a user secret: stored only in the machine-local encrypted
// credential store, keyed by the opaque connection id, never in the registry
// table, responses, logs, or the public-export snapshot.

const credKind = (connectionId: string): string => `trello_creds:${connectionId}`;

/** Read the stored credentials for a connection, or null. */
export function getTrelloCreds(connectionId: string): TrelloCreds | null {
  const raw = getAssistantCredential(credKind(connectionId));
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<TrelloCreds>;
    if (c.apiKey && c.token) {
      return { apiKey: c.apiKey, token: c.token };
    }
  } catch {
    // Corrupt blob — treat as absent.
  }
  return null;
}

/** Persist credentials for a connection to the machine-local encrypted store. */
export function setTrelloCreds(connectionId: string, creds: TrelloCreds): void {
  setAssistantCredential(credKind(connectionId), JSON.stringify(creds));
}

/** Remove the stored credentials for a connection. */
export function clearTrelloCreds(connectionId: string): void {
  deleteAssistantCredential(credKind(connectionId));
}

// --- The Trello HTTP client seam ---------------------------------------------
// The connector programs against this minimal interface, never `fetch` directly,
// so the wire details live in one place and tests inject a fake client.

type Json = Record<string, unknown>;

/** Options for the paged card/comment fetches (Trello's `before` cursor). */
export interface TrelloPageOpts {
  /** Max rows to return this page. */
  limit: number;
  /** Return only rows older than this id (Trello returns newest-first). */
  before?: string;
}

/** The minimal Trello surface the connector depends on (all calls return raw REST shapes). */
export interface TrelloClient {
  /** Validate the credentials + return the authenticated member (`GET /members/me`). */
  me(): Promise<Json>;
  /** The authenticated member's boards (`GET /members/me/boards`). */
  myBoards(): Promise<Json[]>;
  /** A board's lists (`GET /boards/{id}/lists`). */
  boardLists(boardId: string): Promise<Json[]>;
  /** A board's members (`GET /boards/{id}/members`). */
  boardMembers(boardId: string): Promise<Json[]>;
  /** A board's labels (`GET /boards/{id}/labels`). */
  boardLabels(boardId: string): Promise<Json[]>;
  /** A board's cards, paged newest-first via `before` (`GET /boards/{id}/cards`). */
  boardCards(boardId: string, opts: TrelloPageOpts): Promise<Json[]>;
  /** A card's `commentCard` actions, paged via `before` (`GET /cards/{id}/actions`). */
  cardComments(cardId: string, opts: TrelloPageOpts): Promise<Json[]>;
  /** A card's assigned members (`GET /cards/{id}/members`). */
  cardMembers(cardId: string): Promise<Json[]>;
  /** A card's applied labels (`GET /cards/{id}/labels`). */
  cardLabels(cardId: string): Promise<Json[]>;
  /** A card's checklists (`GET /cards/{id}/checklists`). */
  cardChecklists(cardId: string): Promise<Json[]>;
  /** A checklist's items (`GET /checklists/{id}/checkItems`). */
  checklistItems(checklistId: string): Promise<Json[]>;
}

/** Append the key/token auth params to a query string. */
function authParams(creds: TrelloCreds, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({ key: creds.apiKey, token: creds.token, ...extra });
  return p.toString();
}

/**
 * Issue one Trello GET and return the parsed JSON, throwing loudly on a non-2xx
 * response (never a silent fallback) so a failed sync surfaces the real reason.
 */
async function trelloGet(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Trello API ${String(res.status)} ${res.statusText} for ${url.split('?')[0] ?? url}` +
        (detail ? `: ${detail.slice(0, 200)}` : ''),
    );
  }
  return res.json();
}

/** Coerce an unknown JSON body to an array of objects (Trello list endpoints). */
function asArray(v: unknown): Json[] {
  return Array.isArray(v) ? (v as Json[]) : [];
}

/**
 * Build a {@link TrelloClient} that talks to Trello over the Node global `fetch`,
 * authenticated with the user's API key + token. No SDK, no extra dependency.
 */
export function loadTrelloClient(creds: TrelloCreds): Promise<TrelloClient> {
  const get = (path: string, extra: Record<string, string> = {}): Promise<unknown> =>
    trelloGet(`${API_BASE}${path}?${authParams(creds, extra)}`);

  const client: TrelloClient = {
    me: () => get('/members/me') as Promise<Json>,
    myBoards: async () => asArray(await get('/members/me/boards')),
    boardLists: async (id) =>
      asArray(await get(`/boards/${id}/lists`, { limit: String(FULL_LIMIT) })),
    boardMembers: async (id) => asArray(await get(`/boards/${id}/members`)),
    boardLabels: async (id) =>
      asArray(await get(`/boards/${id}/labels`, { limit: String(FULL_LIMIT) })),
    boardCards: async (id, opts) => {
      const extra: Record<string, string> = { limit: String(opts.limit) };
      if (opts.before) extra.before = opts.before;
      return asArray(await get(`/boards/${id}/cards`, extra));
    },
    cardComments: async (id, opts) => {
      const extra: Record<string, string> = {
        filter: 'commentCard',
        limit: String(opts.limit),
      };
      if (opts.before) extra.before = opts.before;
      return asArray(await get(`/cards/${id}/actions`, extra));
    },
    cardMembers: async (id) => asArray(await get(`/cards/${id}/members`)),
    cardLabels: async (id) => asArray(await get(`/cards/${id}/labels`)),
    cardChecklists: async (id) => asArray(await get(`/cards/${id}/checklists`)),
    checklistItems: async (id) => asArray(await get(`/checklists/${id}/checkItems`)),
  };
  return Promise.resolve(client);
}

// --- Field mapping (raw Trello REST → normalized rows) ------------------------

const str = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v as string | number | boolean);
};
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' ? (v as Json) : undefined;

function mapBoard(b: Json): ExternalRecord | null {
  const id = str(b.id);
  if (!id) return null;
  return {
    id,
    row: {
      board_id: id,
      name: str(b.name),
      description: str(b.desc),
      url: str(b.url),
      closed: b.closed ? 1 : 0,
    },
  };
}

function mapMember(m: Json, boardId: string): ExternalRecord | null {
  const id = str(m.id);
  if (!id) return null;
  return {
    id,
    row: {
      member_id: id,
      username: str(m.username),
      full_name: str(m.fullName),
      child_board_id: boardId,
    },
  };
}

function mapBoardMember(m: Json, boardId: string): ExternalRecord | null {
  const memberId = str(m.id);
  if (!memberId) return null;
  return {
    id: `${boardId}:${memberId}`,
    row: {
      board_member_id: `${boardId}:${memberId}`,
      board_id: boardId,
      member_id: memberId,
    },
  };
}

function mapList(l: Json, boardId: string): ExternalRecord | null {
  const id = str(l.id);
  if (!id) return null;
  return {
    id,
    row: {
      list_id: id,
      board_id: str(l.idBoard) ?? boardId,
      name: str(l.name),
      pos: str(l.pos),
      closed: l.closed ? 1 : 0,
    },
  };
}

function mapLabel(l: Json, boardId: string): ExternalRecord | null {
  const id = str(l.id);
  if (!id) return null;
  return {
    id,
    row: {
      label_id: id,
      board_id: str(l.idBoard) ?? boardId,
      name: str(l.name),
      color: str(l.color),
    },
  };
}

function mapCard(c: Json, boardId: string): ExternalRecord | null {
  const id = str(c.id);
  if (!id) return null;
  return {
    id,
    row: {
      card_id: id,
      board_id: str(c.idBoard) ?? boardId,
      list_id: str(c.idList),
      name: str(c.name),
      description: str(c.desc),
      due: str(c.due),
      url: str(c.url),
      last_activity: str(c.dateLastActivity),
      closed: c.closed ? 1 : 0,
    },
  };
}

function mapCardMember(memberId: unknown, cardId: string): ExternalRecord | null {
  const id = str(memberId);
  if (!id) return null;
  return {
    id: `${cardId}:${id}`,
    row: {
      card_member_id: `${cardId}:${id}`,
      card_id: cardId,
      member_id: id,
    },
  };
}

function mapCardLabel(labelId: unknown, cardId: string): ExternalRecord | null {
  const id = str(labelId);
  if (!id) return null;
  return {
    id: `${cardId}:${id}`,
    row: {
      card_label_id: `${cardId}:${id}`,
      card_id: cardId,
      label_id: id,
    },
  };
}

function mapComment(a: Json, cardId: string): ExternalRecord | null {
  const id = str(a.id);
  if (!id) return null;
  return {
    id,
    row: {
      comment_id: id,
      card_id: cardId,
      member_id: str(obj(a.memberCreator)?.id ?? obj(a.idMemberCreator)),
      body: str(obj(a.data)?.text),
    },
  };
}

function mapChecklist(c: Json, cardId: string): ExternalRecord | null {
  const id = str(c.id);
  if (!id) return null;
  return {
    id,
    row: {
      checklist_id: id,
      card_id: str(c.idCard) ?? cardId,
      name: str(c.name),
    },
  };
}

function mapCheckitem(i: Json, checklistId: string): ExternalRecord | null {
  const id = str(i.id);
  if (!id) return null;
  return {
    id,
    row: {
      checkitem_id: id,
      checklist_id: str(i.idChecklist) ?? checklistId,
      name: str(i.name),
      state: str(i.state),
    },
  };
}

export class TrelloConnector implements CredentialConnector {
  readonly connector = 'trello';

  /**
   * @param clientFactory builds a {@link TrelloClient} from creds (default: the
   * real `fetch`-backed client; tests inject a fake).
   * @param credsLoader resolves a connection id to its stored creds (default: the
   * machine-local store; tests inject a fake).
   */
  constructor(
    private readonly clientFactory: (
      creds: TrelloCreds,
    ) => Promise<TrelloClient> = loadTrelloClient,
    private readonly credsLoader: (connectionId: string) => TrelloCreds | null = getTrelloCreds,
  ) {}

  toolkits(): string[] {
    return ['trello'];
  }

  models(toolkit: string): ConnectedModelDef[] {
    if (toolkit !== 'trello') {
      throw new Error(`Unknown toolkit "${toolkit}" — the Trello connector serves only "trello".`);
    }
    return TRELLO_MODELS;
  }

  presentation(toolkit: string): ToolkitPresentation {
    if (toolkit !== 'trello') {
      throw new Error(`Unknown toolkit "${toolkit}" — the Trello connector serves only "trello".`);
    }
    return { label: 'Trello', icon: TRELLO_ICON };
  }

  credentialFields(): CredentialField[] {
    return [
      { key: 'apiKey', label: 'API key', type: 'text', required: true },
      { key: 'token', label: 'Token', type: 'password', required: true },
    ];
  }

  helpUrl(): string {
    return 'https://trello.com/power-ups/admin';
  }

  /**
   * Trello authenticates with a direct API key + token, not an OAuth redirect.
   * The GUI collects them and calls {@link connect}; these SPI methods are
   * therefore not part of the Trello flow and reject with a clear error.
   */
  authorize(_userId: string, _toolkit: string): Promise<AuthorizeResult> {
    return Promise.reject(
      new Error(
        'Trello uses an API key + token, not OAuth. ' +
          'Submit them on the Connectors settings page (no redirect).',
      ),
    );
  }

  completeAuth(_userId: string, _toolkit: string): Promise<ConnectionResult> {
    return Promise.reject(
      new Error('Trello has no OAuth step to complete — use the credential connect form.'),
    );
  }

  /**
   * Validate Trello credentials (`GET /members/me`) and, on success, store them
   * encrypted under a fresh connection id. Returns the connection id (recorded in
   * the registry by the caller) and the validated member's full name (for the
   * UI). Throws if the credentials are invalid or absent.
   */
  async connect(creds: Record<string, string>): Promise<{
    connectionId: string;
    displayName: string | null;
  }> {
    const apiKey = (creds.apiKey ?? '').trim();
    const token = (creds.token ?? '').trim();
    if (!apiKey || !token) {
      throw new ConnectorUnavailableError('Trello requires both an API key and a token.');
    }
    const resolved: TrelloCreds = { apiKey, token };
    const client = await this.clientFactory(resolved);
    let me: Json;
    try {
      me = await client.me();
    } catch (e) {
      throw new Error(
        `Could not authenticate with Trello: ${(e as Error).message}. ` +
          'Check the API key and token.',
      );
    }
    const connectionId = uuidv4();
    setTrelloCreds(connectionId, resolved);
    return { connectionId, displayName: str(me.fullName) };
  }

  async *listChanges(
    toolkit: string,
    model: string,
    ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    if (toolkit !== 'trello') {
      throw new Error(`Unknown toolkit "${toolkit}" — the Trello connector serves only "trello".`);
    }
    const creds = this.credsLoader(ctx.connectionId);
    if (!creds) {
      throw new ConnectorUnavailableError(
        `No stored Trello credentials for connection "${ctx.connectionId}" — reconnect Trello.`,
      );
    }
    const client = await this.clientFactory(creds);

    switch (model) {
      case 'board': {
        for (const b of await client.myBoards()) {
          const rec = mapBoard(b);
          if (rec) yield rec;
        }
        return;
      }
      case 'member': {
        const boardId = ctx.parentKey;
        if (!boardId) return;
        for (const m of await client.boardMembers(boardId)) {
          const rec = mapMember(m, boardId);
          if (rec) yield rec;
        }
        return;
      }
      case 'board_member': {
        const boardId = ctx.parentKey;
        if (!boardId) return;
        for (const m of await client.boardMembers(boardId)) {
          const rec = mapBoardMember(m, boardId);
          if (rec) yield rec;
        }
        return;
      }
      case 'list': {
        const boardId = ctx.parentKey;
        if (!boardId) return;
        for (const l of await client.boardLists(boardId)) {
          const rec = mapList(l, boardId);
          if (rec) yield rec;
        }
        return;
      }
      case 'label': {
        const boardId = ctx.parentKey;
        if (!boardId) return;
        for (const l of await client.boardLabels(boardId)) {
          const rec = mapLabel(l, boardId);
          if (rec) yield rec;
        }
        return;
      }
      case 'card': {
        const boardId = ctx.parentKey;
        if (!boardId) return;
        yield* this.pageBefore(
          model,
          (before) =>
            client.boardCards(
              boardId,
              before ? { limit: PAGE_SIZE, before } : { limit: PAGE_SIZE },
            ),
          (c) => mapCard(c, boardId),
        );
        return;
      }
      case 'card_member': {
        const cardId = ctx.parentKey;
        if (!cardId) return;
        for (const m of await client.cardMembers(cardId)) {
          const rec = mapCardMember(m.id, cardId);
          if (rec) yield rec;
        }
        return;
      }
      case 'card_label': {
        const cardId = ctx.parentKey;
        if (!cardId) return;
        for (const l of await client.cardLabels(cardId)) {
          const rec = mapCardLabel(l.id, cardId);
          if (rec) yield rec;
        }
        return;
      }
      case 'comment': {
        const cardId = ctx.parentKey;
        if (!cardId) return;
        yield* this.pageBefore(
          model,
          (before) =>
            client.cardComments(
              cardId,
              before ? { limit: PAGE_SIZE, before } : { limit: PAGE_SIZE },
            ),
          (a) => mapComment(a, cardId),
        );
        return;
      }
      case 'checklist': {
        const cardId = ctx.parentKey;
        if (!cardId) return;
        for (const c of await client.cardChecklists(cardId)) {
          const rec = mapChecklist(c, cardId);
          if (rec) yield rec;
        }
        return;
      }
      case 'checkitem': {
        const checklistId = ctx.parentKey;
        if (!checklistId) return;
        for (const i of await client.checklistItems(checklistId)) {
          const rec = mapCheckitem(i, checklistId);
          if (rec) yield rec;
        }
        return;
      }
      default:
        throw new Error(`Trello connector has no fetch for model "${model}".`);
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    // A Trello token has no remote session this connector revokes — just drop the
    // stored creds. (The user can revoke the token from their Trello account.)
    clearTrelloCreds(connectionId);
    return Promise.resolve();
  }

  /**
   * Cursor-paged fetch for Trello's newest-first list endpoints: pass the oldest
   * id seen on the previous page as `before` to walk backwards. Stops on a short
   * page; throws past {@link MAX_PAGES} to avoid an unbounded loop.
   */
  private async *pageBefore(
    model: string,
    fetchPage: (before: string | undefined) => Promise<Json[]>,
    map: (item: Json) => ExternalRecord | null,
  ): AsyncIterable<ExternalRecord> {
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const items = await fetchPage(before);
      if (items.length === 0) return;
      let oldestId: string | undefined;
      for (const it of items) {
        const rec = map(it);
        if (rec) yield rec;
        const rawId = str(it.id);
        if (rawId) oldestId = rawId; // Trello returns newest-first; last seen = oldest.
      }
      // A short page means there's nothing older; stop. Without a usable cursor we
      // also stop rather than risk re-fetching the same page forever.
      if (items.length < PAGE_SIZE || !oldestId || oldestId === before) return;
      before = oldestId;
    }
    throw new Error(
      `Trello ${model} fetch exceeded ${String(MAX_PAGES)} pages — aborting to avoid an unbounded loop.`,
    );
  }
}
