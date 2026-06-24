/**
 * The Jira connector — a {@link Connector} that talks to Jira Cloud's REST + Agile
 * APIs DIRECTLY via the optional `jira.js` dependency, authenticated with the
 * user's OWN Atlassian credentials (site URL + email + API token, HTTP Basic).
 * No broker, no extra API key.
 *
 * The SPI is OAuth-shaped (authorize→redirect→completeAuth); Jira uses direct
 * credentials instead, so `authorize`/`completeAuth` are not part of its flow —
 * the GUI collects credentials and calls {@link JiraConnector.connect}, which
 * validates them against Jira and stores them encrypted. `listChanges` (sync) and
 * `disconnect` (teardown) satisfy the SPI normally, keyed by the stored
 * connection. The schema (the six connected models) lives in `./models.ts`; this
 * file is the fetch/auth half.
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
import { JIRA_MODELS } from './models.js';
import { JIRA_ICON } from './icon.js';

/** Page size for every paged Jira fetch. */
const PAGE_SIZE = 50;
/** Hard cap on pages per model sync — a backstop against an unbounded fetch loop. */
const MAX_PAGES = 1000;

/** The user's Atlassian credentials for one Jira connection. */
export interface JiraCreds {
  /** Site base URL, e.g. `https://your-domain.atlassian.net`. */
  site: string;
  /** Atlassian account email (the Basic-auth username). */
  email: string;
  /** Atlassian API token (the Basic-auth password) — a user secret. */
  apiToken: string;
}

/** Thrown when the connector is used but its prerequisites are missing. */
export class ConnectorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorUnavailableError';
  }
}

// --- Credential storage (machine-local, encrypted) ---------------------------
// The API token is a user secret: stored only in the machine-local encrypted
// credential store, keyed by the opaque connection id, never in the registry
// table, responses, logs, or the public-export snapshot.

const credKind = (connectionId: string): string => `jira_creds:${connectionId}`;

/** Read the stored credentials for a connection, or null. */
export function getJiraCreds(connectionId: string): JiraCreds | null {
  const raw = getAssistantCredential(credKind(connectionId));
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<JiraCreds>;
    if (c.site && c.email && c.apiToken) {
      return { site: c.site, email: c.email, apiToken: c.apiToken };
    }
  } catch {
    // Corrupt blob — treat as absent.
  }
  return null;
}

/** Persist credentials for a connection to the machine-local encrypted store. */
export function setJiraCreds(connectionId: string, creds: JiraCreds): void {
  setAssistantCredential(credKind(connectionId), JSON.stringify(creds));
}

/** Remove the stored credentials for a connection. */
export function clearJiraCreds(connectionId: string): void {
  deleteAssistantCredential(credKind(connectionId));
}

// --- The jira.js client seam -------------------------------------------------
// The connector programs against this minimal interface, never `jira.js`
// directly, so a renamed SDK method touches only `loadJiraClient`, and tests
// inject a fake client. `jira.js` is an OPTIONAL dependency, lazy-loaded.

type Json = Record<string, unknown>;

/** The minimal Jira surface the connector depends on (all calls return raw REST shapes). */
export interface JiraClient {
  /** Validate the credentials + return the authenticated account (`GET /myself`). */
  myself(): Promise<Json>;
  searchIssues(args: {
    jql: string;
    nextPageToken?: string;
    maxResults: number;
    fields?: string[];
  }): Promise<{ issues: Json[]; nextPageToken?: string }>;
  searchProjects(args: {
    startAt: number;
    maxResults: number;
  }): Promise<{ values: Json[]; total?: number; isLast?: boolean }>;
  getComments(args: {
    issueIdOrKey: string;
    startAt: number;
    maxResults: number;
  }): Promise<{ comments: Json[]; total?: number }>;
  getAllUsers(args: { startAt: number; maxResults: number }): Promise<Json[]>;
  getAllBoards(args: {
    startAt: number;
    maxResults: number;
  }): Promise<{ values: Json[]; total?: number; isLast?: boolean }>;
  getAllSprints(args: {
    boardId: number;
    startAt: number;
    maxResults: number;
  }): Promise<{ values: Json[]; total?: number; isLast?: boolean }>;
}

interface JiraSdkClient {
  myself: { getCurrentUser(): Promise<Json> };
  issueSearch: {
    searchForIssuesUsingJqlEnhancedSearch(p: {
      jql: string;
      nextPageToken?: string;
      maxResults: number;
      fields?: string[];
    }): Promise<{ issues?: Json[]; nextPageToken?: string }>;
  };
  projects: {
    searchProjects(p: {
      startAt: number;
      maxResults: number;
    }): Promise<{ values?: Json[]; total?: number; isLast?: boolean }>;
  };
  issueComments: {
    getComments(p: {
      issueIdOrKey: string;
      startAt: number;
      maxResults: number;
    }): Promise<{ comments?: Json[]; total?: number }>;
  };
  users: { getAllUsers(p: { startAt: number; maxResults: number }): Promise<Json[]> };
}
interface JiraAgileClient {
  board: {
    getAllBoards(p: {
      startAt: number;
      maxResults: number;
    }): Promise<{ values?: Json[]; total?: number; isLast?: boolean }>;
    getAllSprints(p: {
      boardId: number;
      startAt: number;
      maxResults: number;
    }): Promise<{ values?: Json[]; total?: number; isLast?: boolean }>;
  };
}
type JiraCtor = new (cfg: {
  host: string;
  authentication: { basic: { email: string; apiToken: string } };
}) => JiraSdkClient;
type JiraAgileCtor = new (cfg: {
  host: string;
  authentication: { basic: { email: string; apiToken: string } };
}) => JiraAgileClient;

/**
 * Build a {@link JiraClient} from `jira.js` (lazy-imported) + the user's creds.
 * Throws {@link ConnectorUnavailableError} if the optional dependency is absent.
 * The dynamic import uses non-literal specifiers so TypeScript does not statically
 * resolve `jira.js` — it need not be installed to compile latticesql.
 */
export async function loadJiraClient(creds: JiraCreds): Promise<JiraClient> {
  let v3mod: { Version3Client: JiraCtor };
  let agilemod: { AgileClient: JiraAgileCtor };
  try {
    const v3spec = 'jira.js/version3';
    const agilespec = 'jira.js/agile';
    v3mod = (await import(v3spec as string)) as unknown as { Version3Client: JiraCtor };
    agilemod = (await import(agilespec as string)) as unknown as { AgileClient: JiraAgileCtor };
  } catch {
    throw new ConnectorUnavailableError(
      'The Jira connector requires the optional dependency "jira.js". ' +
        'Install it with `npm install jira.js` to use connectors.',
    );
  }
  const authentication = { basic: { email: creds.email, apiToken: creds.apiToken } };
  const v3 = new v3mod.Version3Client({ host: creds.site, authentication });
  const agile = new agilemod.AgileClient({ host: creds.site, authentication });

  // Normalize a values-paged response, omitting absent optionals (exactOptionalPropertyTypes).
  const paged = (r: { values?: Json[]; total?: number; isLast?: boolean }) => {
    const out: { values: Json[]; total?: number; isLast?: boolean } = { values: r.values ?? [] };
    if (r.total !== undefined) out.total = r.total;
    if (r.isLast !== undefined) out.isLast = r.isLast;
    return out;
  };

  return {
    myself: () => v3.myself.getCurrentUser(),
    searchIssues: async (a) => {
      const r = await v3.issueSearch.searchForIssuesUsingJqlEnhancedSearch(a);
      const out: { issues: Json[]; nextPageToken?: string } = { issues: r.issues ?? [] };
      if (r.nextPageToken !== undefined) out.nextPageToken = r.nextPageToken;
      return out;
    },
    searchProjects: async (a) => paged(await v3.projects.searchProjects(a)),
    getComments: async (a) => {
      const r = await v3.issueComments.getComments(a);
      const out: { comments: Json[]; total?: number } = { comments: r.comments ?? [] };
      if (r.total !== undefined) out.total = r.total;
      return out;
    },
    getAllUsers: (a) => v3.users.getAllUsers(a),
    getAllBoards: async (a) => paged(await agile.board.getAllBoards(a)),
    getAllSprints: async (a) => paged(await agile.board.getAllSprints(a)),
  };
}

// --- Field mapping (raw Jira REST → normalized rows) -------------------------

const str = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v as string | number | boolean);
};
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' ? (v as Json) : undefined;

function mapUser(u: Json): ExternalRecord | null {
  const id = str(u.accountId);
  if (!id) return null;
  return {
    id,
    row: {
      account_id: id,
      display_name: str(u.displayName),
      email: str(u.emailAddress),
      active: u.active ? 1 : 0,
    },
  };
}

function mapProject(p: Json): ExternalRecord | null {
  const key = str(p.key);
  if (!key) return null;
  return {
    id: key,
    row: {
      project_key: key,
      project_id: str(p.id),
      name: str(p.name),
      description: str(p.description),
      lead_account_id: str(obj(p.lead)?.accountId),
      project_type: str(p.projectTypeKey),
      url: str(p.self),
    },
  };
}

function mapBoard(b: Json): ExternalRecord | null {
  const id = str(b.id);
  if (!id) return null;
  return {
    id,
    row: {
      board_id: id,
      name: str(b.name),
      board_type: str(b.type),
      project_key: str(obj(b.location)?.projectKey),
    },
  };
}

function mapSprint(s: Json, boardId: string): ExternalRecord | null {
  const id = str(s.id);
  if (!id) return null;
  return {
    id,
    row: {
      sprint_id: id,
      name: str(s.name),
      state: str(s.state),
      board_id: str(s.originBoardId) ?? boardId,
      start_date: str(s.startDate),
      end_date: str(s.endDate),
      goal: str(s.goal),
    },
  };
}

function mapIssue(it: Json): ExternalRecord | null {
  const key = str(it.key);
  if (!key) return null;
  const f = obj(it.fields) ?? {};
  const labels = Array.isArray(f.labels) ? JSON.stringify(f.labels) : null;
  return {
    id: key,
    row: {
      issue_key: key,
      issue_id: str(it.id),
      project_key: str(obj(f.project)?.key),
      summary: str(f.summary),
      // v3 returns rich-text (ADF) objects for description/comment bodies; store
      // the raw value (string if plain, JSON otherwise). Plain-text extraction is
      // a future enhancement.
      description: str(f.description),
      status: str(obj(f.status)?.name),
      issue_type: str(obj(f.issuetype)?.name),
      priority: str(obj(f.priority)?.name),
      assignee_id: str(obj(f.assignee)?.accountId),
      reporter_id: str(obj(f.reporter)?.accountId),
      // Sprint membership is an instance-specific custom field on the issue; not
      // reliably resolvable without per-instance field discovery. Left null —
      // sprints still sync per-board, so the sprint table is populated.
      sprint_id: null,
      labels,
      url: str(it.self),
      updated: str(f.updated),
    },
  };
}

function mapComment(c: Json, issueKey: string): ExternalRecord | null {
  const id = str(c.id);
  if (!id) return null;
  return {
    id,
    row: {
      comment_id: id,
      issue_key: issueKey,
      author_id: str(obj(c.author)?.accountId),
      body: str(c.body),
    },
  };
}

/** A bounded query (the enhanced JQL search requires a search restriction, not just ORDER BY). */
const ALL_ISSUES_JQL = 'created >= "1970-01-01" ORDER BY created ASC';
// The enhanced JQL search (`/rest/api/3/search/jql`) returns IDs ONLY unless an
// explicit `fields` list is requested — so ask for exactly the fields mapIssue
// reads, or every issue column would come back null.
const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'reporter',
  'labels',
  'project',
  'updated',
];

export class JiraConnector implements CredentialConnector {
  readonly connector = 'jira';

  /**
   * @param clientFactory builds a {@link JiraClient} from creds (default: the lazy
   * `jira.js` loader; tests inject a fake).
   * @param credsLoader resolves a connection id to its stored creds (default: the
   * machine-local store; tests inject a fake).
   */
  constructor(
    private readonly clientFactory: (creds: JiraCreds) => Promise<JiraClient> = loadJiraClient,
    private readonly credsLoader: (connectionId: string) => JiraCreds | null = getJiraCreds,
  ) {}

  toolkits(): string[] {
    return ['jira'];
  }

  models(toolkit: string): ConnectedModelDef[] {
    if (toolkit !== 'jira') {
      throw new Error(`Unknown toolkit "${toolkit}" — the Jira connector serves only "jira".`);
    }
    return JIRA_MODELS;
  }

  presentation(toolkit: string): ToolkitPresentation {
    if (toolkit !== 'jira') {
      throw new Error(`Unknown toolkit "${toolkit}" — the Jira connector serves only "jira".`);
    }
    return { label: 'Jira', icon: JIRA_ICON };
  }

  credentialFields(): CredentialField[] {
    return [
      {
        key: 'site',
        label: 'Site URL',
        type: 'text',
        placeholder: 'https://your-domain.atlassian.net',
        required: true,
      },
      { key: 'email', label: 'Email', type: 'text', required: true },
      { key: 'token', label: 'API token', type: 'password', required: true },
    ];
  }

  helpUrl(): string {
    return 'https://id.atlassian.com/manage-profile/security/api-tokens';
  }

  /**
   * Jira authenticates with direct credentials, not an OAuth redirect. The GUI
   * collects the site/email/token and calls {@link connect}; these SPI methods are
   * therefore not part of the Jira flow and throw a clear, actionable error.
   */
  authorize(_userId: string, _toolkit: string): Promise<AuthorizeResult> {
    return Promise.reject(
      new Error(
        'Jira connects with your Atlassian site URL, email, and API token — not OAuth. ' +
          'Submit them on the Connectors settings page (no redirect).',
      ),
    );
  }

  completeAuth(_userId: string, _toolkit: string): Promise<ConnectionResult> {
    return Promise.reject(
      new Error('Jira has no OAuth step to complete — use the credential connect form.'),
    );
  }

  /**
   * Validate Atlassian credentials against Jira (`GET /myself`) and, on success,
   * store them encrypted under a fresh connection id. Reads the submitted
   * `site` / `email` / `token` values (the wire key stays `token`; it maps to the
   * internal `apiToken`). Returns the connection id (recorded in the registry by
   * the caller) and the validated account display name (for the UI). Throws a
   * clear, actionable error if the inputs are missing, the site isn't a URL, or
   * the credentials are invalid.
   */
  async connect(creds: Record<string, string>): Promise<{
    connectionId: string;
    displayName: string | null;
  }> {
    const site = (creds.site ?? '').trim().replace(/\/+$/, '');
    const email = (creds.email ?? '').trim();
    const apiToken = (creds.token ?? '').trim();
    if (!site || !email || !apiToken) {
      throw new ConnectorUnavailableError('site, email, and token are all required.');
    }
    if (!/^https?:\/\//i.test(site)) {
      throw new ConnectorUnavailableError(
        'site must be a full URL, e.g. https://your-domain.atlassian.net',
      );
    }
    const resolved: JiraCreds = { site, email, apiToken };
    const client = await this.clientFactory(resolved);
    let me: Json;
    try {
      me = await client.myself();
    } catch (e) {
      throw new Error(
        `Could not authenticate with Jira at ${site}: ${(e as Error).message}. ` +
          'Check the site URL, email, and API token.',
      );
    }
    const connectionId = uuidv4();
    setJiraCreds(connectionId, resolved);
    return { connectionId, displayName: str(me.displayName) };
  }

  async *listChanges(
    toolkit: string,
    model: string,
    ctx: ListChangesContext,
  ): AsyncIterable<ExternalRecord> {
    if (toolkit !== 'jira') {
      throw new Error(`Unknown toolkit "${toolkit}" — the Jira connector serves only "jira".`);
    }
    const creds = this.credsLoader(ctx.connectionId);
    if (!creds) {
      throw new ConnectorUnavailableError(
        `No stored Jira credentials for connection "${ctx.connectionId}" — reconnect Jira.`,
      );
    }
    const client = await this.clientFactory(creds);

    switch (model) {
      case 'user':
        yield* this.pageOffset(
          model,
          async (startAt) => ({
            items: await client.getAllUsers({ startAt, maxResults: PAGE_SIZE }),
          }),
          mapUser,
        );
        return;
      case 'project':
        yield* this.pageOffset(
          model,
          (startAt) => client.searchProjects({ startAt, maxResults: PAGE_SIZE }),
          mapProject,
        );
        return;
      case 'board':
        yield* this.pageOffset(
          model,
          (startAt) => client.getAllBoards({ startAt, maxResults: PAGE_SIZE }),
          mapBoard,
        );
        return;
      case 'sprint': {
        const boardId = Number(ctx.parentKey);
        if (!ctx.parentKey || Number.isNaN(boardId)) return; // no/invalid board → nothing
        yield* this.pageOffset(
          model,
          (startAt) => client.getAllSprints({ boardId, startAt, maxResults: PAGE_SIZE }),
          (s) => mapSprint(s, String(ctx.parentKey)),
        );
        return;
      }
      case 'issue':
        yield* this.pageToken(
          model,
          async (token) => {
            const args: {
              jql: string;
              nextPageToken?: string;
              maxResults: number;
              fields: string[];
            } = {
              jql: ALL_ISSUES_JQL,
              maxResults: PAGE_SIZE,
              fields: ISSUE_FIELDS,
            };
            if (token) args.nextPageToken = token;
            const r = await client.searchIssues(args);
            const out: { items: Json[]; nextPageToken?: string } = { items: r.issues };
            if (r.nextPageToken !== undefined) out.nextPageToken = r.nextPageToken;
            return out;
          },
          mapIssue,
        );
        return;
      case 'comment': {
        const issueKey = ctx.parentKey;
        if (!issueKey) return;
        yield* this.pageOffset(
          model,
          (startAt) =>
            client.getComments({ issueIdOrKey: issueKey, startAt, maxResults: PAGE_SIZE }),
          (c) => mapComment(c, issueKey),
          'comments',
        );
        return;
      }
      default:
        throw new Error(`Jira connector has no fetch for model "${model}".`);
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    // An API token has no remote session to revoke — just drop the stored creds.
    clearJiraCreds(connectionId);
    return Promise.resolve();
  }

  /** Offset-paged fetch (startAt/total/isLast). Stops on isLast, exhausted total, or a short page. */
  private async *pageOffset(
    model: string,
    fetchPage: (startAt: number) => Promise<{
      items?: Json[];
      values?: Json[];
      comments?: Json[];
      total?: number;
      isLast?: boolean;
    }>,
    map: (item: Json) => ExternalRecord | null,
    label = model,
  ): AsyncIterable<ExternalRecord> {
    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await fetchPage(startAt);
      const items = r.items ?? r.values ?? r.comments ?? [];
      for (const it of items) {
        const rec = map(it);
        if (rec) yield rec;
      }
      if (r.isLast === true || items.length === 0) return;
      const next = startAt + items.length;
      if (r.total !== undefined ? next >= r.total : items.length < PAGE_SIZE) return;
      startAt = next;
    }
    throw new Error(
      `Jira ${label} fetch exceeded ${String(MAX_PAGES)} pages — aborting to avoid an unbounded loop.`,
    );
  }

  /** Token-paged fetch (nextPageToken) — the enhanced JQL issue search. */
  private async *pageToken(
    model: string,
    fetchPage: (token: string | undefined) => Promise<{ items: Json[]; nextPageToken?: string }>,
    map: (item: Json) => ExternalRecord | null,
  ): AsyncIterable<ExternalRecord> {
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await fetchPage(token);
      for (const it of r.items) {
        const rec = map(it);
        if (rec) yield rec;
      }
      if (!r.nextPageToken) return;
      token = r.nextPageToken;
    }
    throw new Error(
      `Jira ${model} fetch exceeded ${String(MAX_PAGES)} pages — aborting to avoid an unbounded loop.`,
    );
  }
}
