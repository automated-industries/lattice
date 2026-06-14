import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type pg from 'pg';
import { isPostgresUrl } from '../cloud/url.js';

// Lazy-load `pg` via createRequire so the static graph the bundler sees
// does NOT pull pg into dist/cli.js. v1.13.8 shipped with a top-level
// `import pg from 'pg'` here, which tsup happily inlined into the ESM
// CLI bundle. pg's CommonJS internals (`require('events')`, the native
// pg-native binding shims, etc.) then crashed at first import on every
// `lattice gui` boot, even for SQLite-only users who never construct
// a RealtimeBroker. v1.13.9 mirrors the postgres.ts approach: types are
// type-only (erased at compile time), the runtime symbol is fetched from
// the consumer's node_modules at the moment the broker connects.
//
// Defence-in-depth: tsup.config.ts also lists `pg` in the CLI build's
// `external` array so a future regression that re-introduces a static
// import still keeps pg out of the bundle.
type PgClientCtor = new (config: { connectionString: string }) => pg.Client;
type PgModule = { Client: PgClientCtor };

let _pgModule: PgModule | null = null;
function loadPg(): PgModule {
  if (_pgModule) return _pgModule;
  const importMetaUrl = (import.meta as { url?: string }).url;
  const requireFromHere = importMetaUrl
    ? createRequire(importMetaUrl)
    : // CJS fallback — Node provides `require` on every CJS module scope.
      require;
  try {
    _pgModule = requireFromHere('pg') as PgModule;
    return _pgModule;
  } catch (err) {
    throw new Error(
      "RealtimeBroker requires 'pg'. Install with: npm install pg\n" +
        'Underlying error: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Realtime broker for the GUI server.
 *
 * Holds one dedicated `pg.Client` per active Postgres-backed Lattice
 * (pooled clients can't keep a LISTEN open across releases). Forwards
 * every `NOTIFY lattice_changes` payload to subscribers via an
 * EventEmitter, so multiple browser tabs can share one upstream channel.
 *
 * The trigger that emits the NOTIFY is installed by the cloud RLS layer
 * (`installCloudRls` in `src/cloud/rls.ts`), which fires `pg_notify` on
 * every insert into `__lattice_changes`.
 *
 * Lifecycle:
 *   - `start()` opens the pg client, runs LISTEN, attaches handlers.
 *   - `subscribe(handler)` returns an unsubscribe function. Multiple
 *     handlers may register; each receives every payload until
 *     unsubscribed or the broker stops.
 *   - On pg error / 'end', the broker transitions to disconnected and
 *     reconnects with exponential backoff (1s → 2s → 5s → 10s, capped).
 *   - `stop()` closes the client and emits a terminal 'stopped' state.
 *
 * SQLite databases have no LISTEN/NOTIFY equivalent. Callers should
 * skip broker creation entirely when `dialect !== 'postgres'`.
 */

export type RealtimeState = 'connecting' | 'connected' | 'disconnected' | 'stopped';

export interface RealtimePayload {
  seq: number;
  team_id: string;
  table_name: string | null;
  pk: string | null;
  op: string;
  owner_user_id: string | null;
  created_at: string;
  /** True edit time recorded by the originating client (null on legacy rows). */
  client_ts: string | null;
}

export type RealtimeStateHandler = (state: RealtimeState) => void;
export type RealtimePayloadHandler = (payload: RealtimePayload) => void;

const CHANNEL = 'lattice_changes';
const BACKOFF_MS = [1000, 2000, 5000, 10000];

export class RealtimeBroker {
  private readonly url: string;
  private readonly emitter = new EventEmitter();
  private client: pg.Client | null = null;
  private currentState: RealtimeState = 'connecting';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;

  constructor(connectionUrl: string) {
    if (!isPostgresUrl(connectionUrl)) {
      throw new Error(`RealtimeBroker: connectionUrl must be a postgres:// URL`);
    }
    this.url = connectionUrl;
    // Avoid 'MaxListenersExceeded' warnings — multiple browser tabs each
    // attach two listeners (payload + state). 64 is generous; consumers
    // unsubscribe on close.
    this.emitter.setMaxListeners(64);
  }

  state(): RealtimeState {
    return this.currentState;
  }

  /** Open the pg client + LISTEN. Idempotent if called while already connected. */
  async start(): Promise<void> {
    if (this.client || this.stopped) return;
    await this.openClient();
  }

  private async openClient(): Promise<void> {
    if (this.stopped) return;
    this.setState('connecting');
    const pgMod = loadPg();
    const client = new pgMod.Client({ connectionString: this.url });
    // pg's 'error' on a Client (vs Pool) fires on async errors after
    // connect; the connect() promise rejects on initial failures.
    client.on('error', (err) => {
      this.handleClientError(err);
    });
    client.on('end', () => {
      this.handleClientEnd();
    });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL) return;
      const payload = parsePayload(msg.payload);
      if (payload) this.emitter.emit('payload', payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      this.reconnectAttempt = 0;
      this.setState('connected');
    } catch (err) {
      // Initial connect failed — schedule a retry. Don't surface the
      // raw URL in the log (it carries credentials).
      console.warn('[realtime] LISTEN connect failed:', (err as Error).message);
      try {
        await client.end();
      } catch {
        // ignore
      }
      this.scheduleReconnect();
    }
  }

  private handleClientError(err: Error): void {
    console.warn('[realtime] pg client error:', err.message);
    // The 'end' event follows; transition there.
  }

  private handleClientEnd(): void {
    if (this.stopped) {
      this.setState('stopped');
      return;
    }
    this.client = null;
    this.setState('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)] ?? 10000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openClient();
    }, delay);
  }

  private setState(state: RealtimeState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.emitter.emit('state', state);
  }

  /** Subscribe to NOTIFY payloads. Returns an unsubscribe function. */
  subscribePayload(handler: RealtimePayloadHandler): () => void {
    this.emitter.on('payload', handler);
    return () => this.emitter.off('payload', handler);
  }

  /** Subscribe to connection-state transitions. Returns an unsubscribe function. */
  subscribeState(handler: RealtimeStateHandler): () => void {
    this.emitter.on('state', handler);
    return () => this.emitter.off('state', handler);
  }

  /** Close the client + cancel any pending reconnect. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
    this.setState('stopped');
    this.emitter.removeAllListeners();
  }
}

function parsePayload(raw: string | undefined): RealtimePayload | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj.seq !== 'number' || typeof obj.op !== 'string') return null;
    return {
      seq: obj.seq,
      team_id: typeof obj.team_id === 'string' ? obj.team_id : '',
      table_name: typeof obj.table_name === 'string' ? obj.table_name : null,
      pk: typeof obj.pk === 'string' ? obj.pk : null,
      op: obj.op,
      owner_user_id: typeof obj.owner_user_id === 'string' ? obj.owner_user_id : null,
      created_at: typeof obj.created_at === 'string' ? obj.created_at : '',
      client_ts: typeof obj.client_ts === 'string' ? obj.client_ts : null,
    };
  } catch {
    return null;
  }
}
