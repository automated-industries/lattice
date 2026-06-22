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
type PgClientCtor = new (config: { connectionString: string; keepAlive?: boolean }) => pg.Client;
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

/**
 * One change envelope, mirroring EXACTLY the `json_build_object` the
 * `lattice_notify_change` trigger emits (see `src/cloud/rls.ts`):
 * `{ seq, table_name, pk, op, owner_role, created_at }`. The pre-3.2 shape read
 * `team_id` / `owner_user_id` / `client_ts` — none of which the trigger emits —
 * and dropped `owner_role`, which it DOES, so "last edited by" never resolved.
 * `op` is `'upsert' | 'delete'` (the `__lattice_changes.op` CHECK domain).
 */
export interface RealtimePayload {
  seq: number;
  table_name: string | null;
  pk: string | null;
  op: string;
  /** The Postgres login role that made the change (the editor). */
  owner_role: string | null;
  created_at: string;
  /**
   * Pre-delete visibility snapshot — present on `delete` events only. The row's
   * ownership record is removed by the delete, so the live fan-out gate decides a
   * delete event's per-recipient visibility from this snapshot instead of the
   * (now-gone) `__lattice_owners` row. Absent on `upsert`, and absent on a legacy
   * delete emitted before the snapshot columns existed (→ the gate fails closed).
   */
  del_owner_role?: string | null;
  del_visibility?: string | null;
  del_grantees?: string[] | null;
}

export type RealtimeStateHandler = (state: RealtimeState) => void;
export type RealtimePayloadHandler = (payload: RealtimePayload) => void;

const CHANNEL = 'lattice_changes';
const BACKOFF_MS = [1000, 2000, 5000, 10000];
/** Max missed changes replayed on reconnect (#4.4). Bounded so a long gap can't
 *  stream the whole change table; a larger gap is reconciled by a client refetch. */
const CATCHUP_LIMIT = 500;
/**
 * Backstop liveness-poll interval. A transaction-mode pooler / managed-Postgres
 * proxy (e.g. AWS RDS Proxy) can silently drop a LISTEN registration WITHOUT
 * closing the socket — no 'error', no 'end' — so the broker sits in `connected`,
 * receiving zero NOTIFYs, forever. This periodic poll re-runs the same bounded,
 * visibility-gated `lattice_changes_since` query the reconnect catch-up uses, so a
 * silently-dead LISTEN still DELIVERS the missed changes (detect + recover in one).
 * It SUPPLEMENTS the 'end'-driven reconnect and deliberately does NOT force a
 * reconnect (re-acquiring another silently-dead LISTEN under such a pooler buys
 * nothing). `deliver()` is at-least-once and the SSE consumers refetch-on-notify
 * (idempotent), and `lattice_changes_since` filters `seq > cursor` against the
 * monotonic `lastSeq`, so the poll never re-delivers a row the LISTEN advanced
 * past. 0 disables the watchdog. */
const DEFAULT_WATCHDOG_MS = 20_000;

/**
 * Cap on the graceful `client.end()` during {@link RealtimeBroker.stop}. pg's
 * `end()` awaits the server's close acknowledgement, which never arrives on a
 * wedged / half-open pooler connection (the same silently-dead LISTEN the
 * watchdog exists for). An unbounded await there froze workspace switches — the
 * GUI awaits `stop()` while tearing the previous workspace down. On timeout the
 * underlying socket is force-destroyed so the connection is released (not
 * leaked) and `stop()` always returns promptly.
 */
const DEFAULT_STOP_END_MS = 2000;

export class RealtimeBroker {
  private readonly url: string;
  private readonly emitter = new EventEmitter();
  private client: pg.Client | null = null;
  private currentState: RealtimeState = 'connecting';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  /** Highest change seq delivered so far — the catch-up cursor (#4.4). */
  private lastSeq = 0;
  /** True once an initial connection has succeeded, so a later open is a RECONNECT
   *  (and should catch up the gap) rather than the first connect (REST seeds it). */
  private hasConnected = false;
  /** Backstop liveness-poll interval (ms); 0 disables. See DEFAULT_WATCHDOG_MS. */
  private readonly watchdogIntervalMs: number;
  private watchdogTimer: NodeJS.Timeout | null = null;
  /** Overlap guard — a slow poll must not start a second concurrent query. */
  private watchdogInFlight = false;
  /** Test seam: build the pg client. Defaults to the real `pg` Client; a test can
   *  inject a fake so the watchdog/reconnect lifecycle is exercised without a DB. */
  private readonly clientFactory: ((url: string) => pg.Client) | null;
  /** Cap on the graceful end() in stop() before the socket is force-destroyed. */
  private readonly stopEndTimeoutMs: number;

  constructor(
    connectionUrl: string,
    opts: {
      watchdogIntervalMs?: number;
      clientFactory?: (url: string) => pg.Client;
      stopEndTimeoutMs?: number;
    } = {},
  ) {
    if (!isPostgresUrl(connectionUrl)) {
      throw new Error(`RealtimeBroker: connectionUrl must be a postgres:// URL`);
    }
    this.url = connectionUrl;
    this.watchdogIntervalMs = opts.watchdogIntervalMs ?? DEFAULT_WATCHDOG_MS;
    this.clientFactory = opts.clientFactory ?? null;
    this.stopEndTimeoutMs = opts.stopEndTimeoutMs ?? DEFAULT_STOP_END_MS;
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

  /** Build the pg client. keepAlive surfaces a genuinely dead TCP connection faster
   *  (half-open socket → 'end' → reconnect); cheap defense-in-depth, NOT sufficient
   *  alone for a pooler that drops LISTEN without closing the socket (that's the
   *  watchdog poll's job). A test may inject a fake via the clientFactory seam. */
  private makeClient(): pg.Client {
    if (this.clientFactory) return this.clientFactory(this.url);
    const pgMod = loadPg();
    return new pgMod.Client({ connectionString: this.url, keepAlive: true });
  }

  private async openClient(): Promise<void> {
    if (this.stopped) return;
    this.setState('connecting');
    const client = this.makeClient();
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
      if (payload) this.deliver(payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      this.reconnectAttempt = 0;
      this.setState('connected');
      // #4.4 — on a RECONNECT (not the first connect, which the REST load already
      // seeds), replay the changes missed while the LISTEN was down. Best-effort:
      // a failure (old cloud without the function, transient error) is logged and
      // skipped — the live stream resumes regardless.
      if (this.hasConnected) await this.catchUp(client);
      this.hasConnected = true;
      // Arm the backstop poll AFTER catch-up, so the first poll sees the
      // post-catchup cursor (lastSeq) and never re-delivers what catch-up just did.
      this.startWatchdog();
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

  /** Emit a payload to subscribers and advance the catch-up cursor (#4.4). */
  private deliver(payload: RealtimePayload): void {
    if (payload.seq > this.lastSeq) this.lastSeq = payload.seq;
    this.emitter.emit('payload', payload);
  }

  /**
   * Replay the changes missed during a LISTEN gap (#4.4). Reads them through the
   * SECURITY DEFINER `lattice_changes_since(cursor, limit)`, which returns ONLY
   * the rows the connecting role may see (same visibility gate as live fan-out)
   * and is bounded. Each replayed change is delivered like a live one (advancing
   * the cursor). Best-effort: any error is logged + skipped (never throws into the
   * connect path). No-op until we've seen at least one change (cursor at 0 means
   * the REST load already has the current state — nothing to catch up to).
   */
  private async catchUp(client: pg.Client): Promise<void> {
    if (this.lastSeq <= 0) return;
    try {
      const r = await client.query(
        `SELECT seq, table_name, pk, op, owner_role, created_at FROM lattice_changes_since($1, $2)`,
        [this.lastSeq, CATCHUP_LIMIT],
      );
      for (const row of r.rows as Record<string, unknown>[]) {
        this.deliver(mapChangeRow(row));
      }
    } catch (e) {
      console.warn('[realtime] catch-up replay failed (skipping):', (e as Error).message);
    }
  }

  /** Start the backstop liveness poll (idempotent; no-op when disabled). */
  private startWatchdog(): void {
    if (this.watchdogIntervalMs <= 0 || this.watchdogTimer || this.stopped) return;
    this.watchdogTimer = setInterval(() => {
      void this.runWatchdogPoll();
    }, this.watchdogIntervalMs);
    // Don't keep the process alive solely for the poll.
    if (typeof this.watchdogTimer.unref === 'function') this.watchdogTimer.unref();
  }

  /** Stop the backstop poll. Idempotent. */
  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * One backstop poll: re-run the bounded, visibility-gated `lattice_changes_since`
   * and deliver anything past the cursor — so a silently-dead LISTEN (pooler drop
   * with no socket close) still surfaces missed changes. Guards: skip if stopped /
   * no client / not connected / a poll is already in flight / cursor at 0 (nothing
   * to catch up to). Best-effort: a poll error is logged and does NOT reconnect
   * (forcing a reconnect under a transaction-mode pooler just re-acquires another
   * silently-dead LISTEN). The in-flight flag clears in `finally`.
   */
  private async runWatchdogPoll(): Promise<void> {
    if (this.stopped || !this.client || this.currentState !== 'connected') return;
    if (this.watchdogInFlight || this.lastSeq <= 0) return;
    this.watchdogInFlight = true;
    try {
      const r = await this.client.query(
        `SELECT seq, table_name, pk, op, owner_role, created_at FROM lattice_changes_since($1, $2)`,
        [this.lastSeq, CATCHUP_LIMIT],
      );
      for (const row of r.rows as Record<string, unknown>[]) {
        this.deliver(mapChangeRow(row));
      }
    } catch (e) {
      console.warn('[realtime] watchdog poll failed (skipping):', (e as Error).message);
    } finally {
      this.watchdogInFlight = false;
    }
  }

  private handleClientError(err: Error): void {
    console.warn('[realtime] pg client error:', err.message);
    // The 'end' event follows; transition there.
  }

  private handleClientEnd(): void {
    // The poll runs against this.client; tear it down before reconnecting so it
    // can't fire against a dead/replaced client. openClient re-arms it on success.
    this.stopWatchdog();
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
    this.stopWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      // Bounded graceful close. `client.end()` can hang forever on a wedged /
      // half-open connection; cap it and, on timeout, force the socket closed so
      // the connection is released (not leaked) and stop() returns promptly. An
      // unbounded await here previously froze workspace switches.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ended = Promise.resolve(client.end()).then(
        () => 'ended' as const,
        () => 'ended' as const, // a graceful-close error is still "closed enough"
      );
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, this.stopEndTimeoutMs);
        (timer as { unref?: () => void }).unref?.();
      });
      const outcome = await Promise.race([ended, timedOut]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') {
        try {
          const stream = (
            client as unknown as { connection?: { stream?: { destroy?: () => void } } }
          ).connection?.stream;
          stream?.destroy?.();
        } catch {
          // best-effort force-close — the socket is being abandoned regardless
        }
      }
    }
    this.setState('stopped');
    this.emitter.removeAllListeners();
  }
}

/**
 * Map a change-feed op to the activity-feed verb. The change feed's op domain is
 * `upsert` | `delete` (the `__lattice_changes` CHECK + the NOTIFY trigger), so
 * `upsert` collapses insert+update into a generic "update" (the feed doesn't
 * distinguish them). Legacy uppercase `INSERT`/`UPDATE`/`DELETE` are still
 * accepted for forward-compat. Anything else → null (skip). #4.1 — matching only
 * the uppercase forms here dropped EVERY remote change.
 */
export function feedOpForChange(op: string): 'update' | 'delete' | null {
  if (op === 'upsert' || op === 'INSERT' || op === 'UPDATE') return 'update';
  if (op === 'delete' || op === 'DELETE') return 'delete';
  return null;
}

/**
 * Map a `lattice_changes_since` result row to a {@link RealtimePayload}. Shared by
 * the reconnect catch-up and the watchdog poll so the two replay paths can't drift.
 */
export function mapChangeRow(row: Record<string, unknown>): RealtimePayload {
  const created = row.created_at;
  return {
    seq: Number(row.seq),
    table_name: typeof row.table_name === 'string' ? row.table_name : null,
    pk: typeof row.pk === 'string' ? row.pk : null,
    op: typeof row.op === 'string' ? row.op : 'upsert',
    owner_role: typeof row.owner_role === 'string' ? row.owner_role : null,
    created_at:
      created instanceof Date ? created.toISOString() : typeof created === 'string' ? created : '',
  };
}

export function parsePayload(raw: string | undefined): RealtimePayload | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj.seq !== 'number' || typeof obj.op !== 'string') return null;
    return {
      seq: obj.seq,
      table_name: typeof obj.table_name === 'string' ? obj.table_name : null,
      pk: typeof obj.pk === 'string' ? obj.pk : null,
      op: obj.op,
      owner_role: typeof obj.owner_role === 'string' ? obj.owner_role : null,
      created_at: typeof obj.created_at === 'string' ? obj.created_at : '',
      del_owner_role: typeof obj.del_owner_role === 'string' ? obj.del_owner_role : null,
      del_visibility: typeof obj.del_visibility === 'string' ? obj.del_visibility : null,
      del_grantees: Array.isArray(obj.del_grantees)
        ? obj.del_grantees.filter((g): g is string => typeof g === 'string')
        : null,
    };
  } catch {
    return null;
  }
}
