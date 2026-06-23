import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { transcribe, type SttProvider } from './ai/transcribe.js';
import {
  readOAuthConfig,
  oauthConfigured,
  generatePkceVerifier,
  pkceChallengeFor,
  generateState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
} from './ai/oauth.js';
import type { ClaudeAuth } from './ai/chat.js';
import {
  getAssistantCredential,
  setAssistantCredential,
  deleteAssistantCredential,
  isAssistantCredentialCleared,
  setAssistantCredentialCleared,
  clearAssistantCredentialCleared,
  readPreferences,
  writePreferences,
} from '../framework/user-config.js';
import { sendJson, readJson } from './http.js';

const CLAUDE_OAUTH_KIND = 'claude_oauth';

/**
 * GUI endpoints for the assistant's credentials + voice transcription. API
 * tokens are stored as rows in the native `secrets` entity, whose `value`
 * column is encrypted at rest by the framework. No endpoint ever returns a
 * stored token — `GET /api/assistant/config` reports presence flags only.
 *
 * Same auth model as the other GUI dev-tool routes: localhost trust;
 * team-cloud mode does not mount this dispatcher.
 */

/** Short credential names (used in the API) → `secrets.kind` + display name. */
const CREDENTIALS = {
  anthropic: { kind: 'anthropic_api_key', name: 'Claude API token' },
  openai: { kind: 'openai_api_key', name: 'OpenAI API key' },
  elevenlabs: { kind: 'elevenlabs_api_key', name: 'ElevenLabs API key' },
} as const;
type CredentialName = keyof typeof CREDENTIALS;

export const ANTHROPIC_KEY_KIND = CREDENTIALS.anthropic.kind;

interface AssistantContext {
  // Null in the virgin (no-workspace) state. Assistant credentials live in the
  // machine-local store, not a workspace, so config / key / OAuth all work with
  // no active DB — only the SQLite back-compat secrets lookup needs `db`, and it
  // is skipped when `db` is null. This is what lets "Connect with Claude" run
  // from first-run onboarding before any workspace exists.
  db: Lattice | null;
  pathname: string;
  method: string;
}

interface SecretRow {
  id: string;
  kind?: string | null;
  value?: string | null;
  deleted_at?: string | null;
}

function readBuffer(req: IncomingMessage, maxBytes = 25_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) reject(new Error('audio too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Live (non-deleted) secret rows for a given kind. */
async function liveSecretsOfKind(db: Lattice, kind: string): Promise<SecretRow[]> {
  const rows = (await db.query('secrets', {
    filters: [{ col: 'kind', op: 'eq', val: kind }],
  })) as unknown as SecretRow[];
  return rows.filter((r) => !r.deleted_at);
}

/** Decrypted value of the first live secret row of a kind (framework decrypts on read). */
async function secretValue(db: Lattice | null, kind: string): Promise<string | null> {
  if (!db) return null; // no workspace (virgin state) → machine store only
  const rows = await liveSecretsOfKind(db, kind);
  return rows.find((r) => typeof r.value === 'string' && r.value.length > 0)?.value ?? null;
}

/**
 * Read a credential that belongs at the USER/MACHINE level — API keys and
 * OAuth tokens — not inside a single workspace database. A Claude key is a
 * property of the machine + user; storing it per-DB meant creating a new
 * workspace started with an empty `secrets` table and the key appeared to
 * "de-attach". These live in the machine-local encrypted store
 * (`<config>/assistant-credentials.enc`) so they persist across every
 * workspace. (The aggressiveness + voice-provider *preferences* stay
 * per-workspace — they aren't secrets and aren't shared.)
 *
 * Precedence:
 *   1. the machine-local store (survives workspace switch/create),
 *   2. the active workspace's `secrets` table — back-compat for a key saved
 *      before this moved machine-level; when found there it is PROMOTED to the
 *      machine store (best-effort) so it works from every workspace thereafter.
 * The env-var fallback is layered on by the individual callers.
 *
 * The step-2 back-compat read + promotion runs ONLY for a local SQLite
 * workspace. A team-cloud / direct-Postgres `secrets` table is shared storage
 * that may hold ANOTHER principal's credential row (native `secrets` are
 * creator-owned and invisible to members, but still physically present and
 * raw-queryable) — reading it here would be a confused-deputy credential
 * crossing, and promoting it would copy someone else's key into this machine's
 * store. So on Postgres we use only the machine store + the caller's env-var
 * fallback.
 */
async function readMachineCredential(db: Lattice | null, kind: string): Promise<string | null> {
  const fromMachine = getAssistantCredential(kind);
  if (fromMachine) return fromMachine;
  // No workspace (virgin, db null), or a non-SQLite (shared) DB → machine store
  // only. db?.getDialect() is undefined when db is null, so this returns early.
  if (db?.getDialect() !== 'sqlite') return null;
  const fromDb = await secretValue(db, kind);
  if (fromDb) {
    try {
      setAssistantCredential(kind, fromDb);
    } catch {
      // best-effort promotion — a read must never fail on a write error
    }
    return fromDb;
  }
  return null;
}

/**
 * Resolve the anthropic API key, honoring the authoritative "cleared" sentinel.
 * When the user has cleared the key, BOTH the stored read and the env fallback
 * are skipped — so a clear stays cleared across reloads/restarts until a new key
 * is saved (which clears the sentinel). Otherwise: machine store → workspace
 * `secrets` (back-compat) → `ANTHROPIC_API_KEY` env var.
 */
async function resolveAnthropicKey(db: Lattice | null): Promise<string | null> {
  if (isAssistantCredentialCleared(CREDENTIALS.anthropic.kind)) return null;
  return (
    (await readMachineCredential(db, CREDENTIALS.anthropic.kind)) ??
    process.env.ANTHROPIC_API_KEY ??
    null
  );
}

/**
 * Resolve the Claude API token. Prefers the machine-local credential store
 * (persists across workspaces), then the workspace `secrets` row (back-compat),
 * then the `ANTHROPIC_API_KEY` env var — unless the key was explicitly cleared,
 * in which case it resolves to null. Server-side only.
 */
export async function getAnthropicApiKey(db: Lattice | null): Promise<string | null> {
  return resolveAnthropicKey(db);
}

export interface VoiceCredential {
  provider: SttProvider;
  apiKey: string;
}

/**
 * Resolve a speech-to-text credential. Prefers OpenAI Whisper when both are
 * configured. Falls back to OPENAI_API_KEY / ELEVENLABS_API_KEY env vars.
 * Returns null when no voice key is available.
 */
const STT_PROVIDER_KIND = 'stt_provider';
const AGGRESSIVENESS_KIND = 'assistant_aggressiveness';

/** Default inference aggressiveness (0 = conservative … 1 = aggressive). */
export const DEFAULT_AGGRESSIVENESS = 0.5;

/**
 * The user's "inference aggressiveness" — a single behaviour knob (0 = only
 * high-confidence, conservative changes; 1 = eagerly add/enrich/link/extrapolate).
 * Drives the model sampling temperature AND how liberally ingest materializes
 * new junctions. A USER preference (machine-local `preferences.json`), not a
 * workspace secret — so it persists across workspaces and never shows up in a
 * workspace's `secrets` object. Falls back to {@link DEFAULT_AGGRESSIVENESS}.
 */
export function getAggressiveness(): number {
  const n = readPreferences().aggressiveness;
  if (!Number.isFinite(n)) return DEFAULT_AGGRESSIVENESS;
  return Math.min(1, Math.max(0, n));
}

/**
 * Retire legacy per-workspace preference rows. Earlier builds stored the voice
 * provider + inference aggressiveness in the workspace `secrets` table (kinds
 * `stt_provider` / `assistant_aggressiveness`), which made them appear in the
 * Secrets object and reset on every workspace switch. They are USER preferences
 * now (see {@link getAggressiveness}); this soft-deletes any leftover rows so
 * they stop surfacing as workspace secrets. Idempotent + best-effort: it only
 * touches these two non-credential kinds and never throws (the value is NOT
 * promoted — the user re-picks once, then it persists machine-wide).
 */
export async function retireLegacyPreferenceSecrets(db: Lattice): Promise<void> {
  for (const kind of [STT_PROVIDER_KIND, AGGRESSIVENESS_KIND]) {
    try {
      for (const row of await liveSecretsOfKind(db, kind)) {
        await db.update('secrets', row.id, { deleted_at: new Date().toISOString() });
      }
    } catch (e) {
      console.warn(`[assistant] could not retire legacy ${kind} secret:`, (e as Error).message);
    }
  }
}

/** Map aggressiveness → an Anthropic sampling temperature in [0, 1]. */
export function aggressivenessToTemperature(aggressiveness: number): number {
  return Math.min(1, Math.max(0, aggressiveness));
}

export async function getVoiceCredential(db: Lattice | null): Promise<VoiceCredential | null> {
  const openai =
    (await readMachineCredential(db, CREDENTIALS.openai.kind)) ??
    process.env.OPENAI_API_KEY ??
    null;
  const eleven =
    (await readMachineCredential(db, CREDENTIALS.elevenlabs.kind)) ??
    process.env.ELEVENLABS_API_KEY ??
    null;
  const pref = readPreferences().voice_provider;
  // Honor an explicit choice when its key is available, else infer (OpenAI first).
  if (pref === 'elevenlabs' && eleven) return { provider: 'elevenlabs', apiKey: eleven };
  if (pref === 'openai' && openai) return { provider: 'openai', apiKey: openai };
  if (openai) return { provider: 'openai', apiKey: openai };
  if (eleven) return { provider: 'elevenlabs', apiKey: eleven };
  return null;
}

async function hasCredential(
  db: Lattice | null,
  name: CredentialName,
  envVar: string,
): Promise<boolean> {
  // An explicit clear is authoritative — it suppresses BOTH the stored read and
  // the env fallback, so a cleared key reports absent until the user re-saves.
  if (isAssistantCredentialCleared(CREDENTIALS[name].kind)) return false;
  return (
    Boolean(await readMachineCredential(db, CREDENTIALS[name].kind)) || Boolean(process.env[envVar])
  );
}

interface StoredOAuthTokens {
  access_token: string;
  refresh_token?: string | undefined;
  expires_at?: number | undefined;
}

/**
 * Resolve how the assistant should authenticate to Anthropic. Prefers a
 * connected Claude subscription (OAuth Bearer token, refreshed in place when
 * near expiry) and falls back to a raw API key (secret row or env). Returns
 * null when nothing is configured.
 */
export async function resolveClaudeAuth(db: Lattice | null): Promise<ClaudeAuth | null> {
  // Treat an empty env var the same as unset, so `||` (not `??`) is correct here.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const betaHeader = process.env.ANTHROPIC_OAUTH_BETA || undefined;
  const oauthRaw = await readMachineCredential(db, CLAUDE_OAUTH_KIND);
  if (oauthRaw) {
    try {
      let tokens = JSON.parse(oauthRaw) as StoredOAuthTokens;
      const cfg = readOAuthConfig();
      if (tokens.refresh_token && tokens.expires_at && Date.now() > tokens.expires_at - 60_000) {
        const refreshed = await refreshAccessToken(cfg, tokens.refresh_token);
        tokens = {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
          expires_at: refreshed.expires_at,
        };
        // Refreshed tokens persist machine-level so the subscription stays
        // connected across every workspace, not just the one that linked it.
        setAssistantCredential(CLAUDE_OAUTH_KIND, JSON.stringify(tokens));
      }
      if (tokens.access_token) return { authToken: tokens.access_token, betaHeader };
    } catch {
      // Malformed token blob — fall through to the API-key path.
    }
  }
  // No OAuth → fall back to the (non-cleared) stored-or-env API key.
  const apiKey = await resolveAnthropicKey(db);
  return apiKey ? { apiKey } : null;
}

/** Whether any Claude auth (subscription OR API key) is configured. */
export async function hasClaudeAuth(db: Lattice | null): Promise<boolean> {
  return (
    Boolean(await readMachineCredential(db, CLAUDE_OAUTH_KIND)) ||
    (await hasCredential(db, 'anthropic', 'ANTHROPIC_API_KEY'))
  );
}

/**
 * Which kind of Claude auth is active — so the GUI can show "Connected with
 * Claude" vs "API key set". A connected subscription wins (it's what
 * resolveClaudeAuth prefers).
 */
export async function claudeAuthKind(db: Lattice | null): Promise<'oauth' | 'key' | null> {
  if (await readMachineCredential(db, CLAUDE_OAUTH_KIND)) return 'oauth';
  if (await hasCredential(db, 'anthropic', 'ANTHROPIC_API_KEY')) return 'key';
  return null;
}

/** True for a loopback Host header (optionally with a port). Exported for tests. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * The OAuth callback URL for THIS GUI origin. Derived per-request because the GUI
 * runs on whatever local port was free. SECURITY: only a LOOPBACK Host header is
 * trusted — the GUI binds to 127.0.0.1, so a non-loopback Host (a forged header,
 * or an exposed/proxied deployment the docs warn against) must NOT shape the
 * OAuth redirect, or a forged Host could route the authorization code to another
 * origin. A non-loopback Host falls back to a bare loopback (the flow then simply
 * won't complete — the safe failure). `ANTHROPIC_OAUTH_REDIRECT_URI` overrides
 * everything for a deliberately-configured non-default deployment.
 */
function oauthRedirectUri(req: IncomingMessage): string {
  const rawHost = req.headers.host ?? '127.0.0.1';
  const host = isLoopbackHost(rawHost) ? rawHost : '127.0.0.1';
  // Loopback is always plain http (the GUI serves http on 127.0.0.1); we don't
  // honor x-forwarded-proto here since a proxied/non-loopback host isn't trusted.
  return `http://${host}/api/assistant/oauth/callback`;
}

export async function dispatchAssistantRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AssistantContext,
): Promise<boolean> {
  const { db, pathname, method } = ctx;

  // GET /api/assistant/config — presence flags only, never values.
  if (method === 'GET' && pathname === '/api/assistant/config') {
    const [hasAnthropicKey, hasOpenaiKey, hasElevenlabsKey] = await Promise.all([
      hasCredential(db, 'anthropic', 'ANTHROPIC_API_KEY'),
      hasCredential(db, 'openai', 'OPENAI_API_KEY'),
      hasCredential(db, 'elevenlabs', 'ELEVENLABS_API_KEY'),
    ]);
    const voice = await getVoiceCredential(db);
    sendJson(res, {
      hasAnthropicKey,
      hasOpenaiKey,
      hasElevenlabsKey,
      hasClaudeAuth: await hasClaudeAuth(db),
      claudeAuthKind: await claudeAuthKind(db),
      hasVoiceKey: voice !== null,
      sttProvider: voice?.provider ?? null,
      sttPreference: readPreferences().voice_provider,
      aggressiveness: getAggressiveness(),
      oauthEnabled: oauthConfigured(),
    });
    return true;
  }

  // PUT /api/assistant/aggressiveness { value } — inference aggressiveness 0..1.
  if (method === 'PUT' && pathname === '/api/assistant/aggressiveness') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    const value = Number(body.value);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      sendJson(res, { error: 'value must be a number in [0, 1]' }, 400);
      return true;
    }
    // User preference, machine-local — not a workspace secret.
    writePreferences({ ...readPreferences(), aggressiveness: value });
    sendJson(res, { ok: true, value });
    return true;
  }

  // PUT /api/assistant/stt-provider { provider } — explicit voice provider choice.
  if (method === 'PUT' && pathname === '/api/assistant/stt-provider') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    const provider = typeof body.provider === 'string' ? body.provider : 'auto';
    if (provider !== 'auto' && provider !== 'openai' && provider !== 'elevenlabs') {
      sendJson(res, { error: `unknown provider: ${provider}` }, 400);
      return true;
    }
    // User preference, machine-local — not a workspace secret.
    writePreferences({ ...readPreferences(), voice_provider: provider });
    sendJson(res, { ok: true });
    return true;
  }

  // PUT /api/assistant/key { kind?, key } — set / replace a credential.
  if (method === 'PUT' && pathname === '/api/assistant/key') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    const name = (typeof body.kind === 'string' ? body.kind : 'anthropic') as CredentialName;
    if (!(name in CREDENTIALS)) {
      sendJson(res, { error: `unknown credential kind: ${String(body.kind)}` }, 400);
      return true;
    }
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key) {
      sendJson(res, { error: 'key is required' }, 400);
      return true;
    }
    const cred = CREDENTIALS[name];
    // Store machine-level (assistant-credentials.enc) so the key persists
    // across every workspace — switching or creating a workspace no longer
    // de-attaches it. Retire any copy left in the active workspace's secrets
    // table (pre-machine installs stored it there); the machine store is now
    // the source of truth.
    setAssistantCredential(cred.kind, key);
    // Saving a new value un-clears the authoritative "cleared" sentinel, so the
    // env fallback (and presence flags) resolve normally again.
    clearAssistantCredentialCleared(cred.kind);
    // Retire any leftover pre-machine copy in the active workspace's secrets.
    // Nothing to retire in the virgin (no-workspace) state — db is null there.
    if (db) {
      for (const row of await liveSecretsOfKind(db, cred.kind)) {
        await db.update('secrets', row.id, { deleted_at: new Date().toISOString() });
      }
    }
    sendJson(res, { ok: true });
    return true;
  }

  // DELETE /api/assistant/key?kind= — clear a credential.
  if (method === 'DELETE' && pathname === '/api/assistant/key') {
    const url = new URL(req.url ?? '', 'http://localhost');
    const name = (url.searchParams.get('kind') ?? 'anthropic') as CredentialName;
    if (!(name in CREDENTIALS)) {
      sendJson(res, { error: `unknown credential kind: ${name}` }, 400);
      return true;
    }
    // Clear the machine-level store AND any leftover copy in the active
    // workspace's secrets table. Then set the authoritative "cleared" sentinel
    // so the env-var fallback is suppressed and the key STAYS cleared across
    // reloads/restarts until the user saves a new one.
    deleteAssistantCredential(CREDENTIALS[name].kind);
    setAssistantCredentialCleared(CREDENTIALS[name].kind);
    if (db) {
      for (const row of await liveSecretsOfKind(db, CREDENTIALS[name].kind)) {
        await db.update('secrets', row.id, { deleted_at: new Date().toISOString() });
      }
    }
    sendJson(res, { ok: true });
    return true;
  }

  // POST /api/assistant/transcribe — raw audio body → text via the configured
  // STT provider. The composer posts the recorded blob with its mime type as
  // Content-Type (no multipart), so we read the raw bytes here.
  if (method === 'POST' && pathname === '/api/assistant/transcribe') {
    const voice = await getVoiceCredential(db);
    if (!voice) {
      sendJson(res, { error: 'No voice key configured. Add an OpenAI or ElevenLabs key.' }, 400);
      return true;
    }
    let buf: Buffer;
    try {
      buf = await readBuffer(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    if (buf.length === 0) {
      sendJson(res, { error: 'empty audio' }, 400);
      return true;
    }
    const mime = req.headers['content-type'] ?? 'audio/webm';
    const ext =
      mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('wav') ? 'wav' : 'webm';
    try {
      const text = await transcribe({
        provider: voice.provider,
        apiKey: voice.apiKey,
        audio: new Blob([buf], { type: mime }),
        filename: `audio.${ext}`,
      });
      sendJson(res, { text });
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 502);
    }
    return true;
  }

  // GET /api/assistant/oauth/start — begin the PKCE subscription flow. Opened in
  // a new tab by the GUI; the default (manual) flow shows a code on the provider
  // page that the user pastes back via /oauth/exchange. A loopback callback is
  // only used when an env-pinned client allowlists one.
  if (method === 'GET' && pathname === '/api/assistant/oauth/start') {
    const cfg = readOAuthConfig();
    // Only fill a loopback redirect if none is configured (the default is the
    // provider's registered console redirect, i.e. the manual code-paste flow).
    if (!cfg.redirectUri) cfg.redirectUri = oauthRedirectUri(req);
    const verifier = generatePkceVerifier();
    const state = generateState();
    // 10 min: the manual flow has the user authorize, copy a code, and paste it
    // back, so the verifier/state must outlive a short window.
    const cookieOpts = 'HttpOnly; Path=/; Max-Age=600; SameSite=Lax';
    const setCookie = [
      `lat_oauth_verifier=${verifier}; ${cookieOpts}`,
      `lat_oauth_state=${state}; ${cookieOpts}`,
    ];
    const authorizeUrl = buildAuthorizeUrl(cfg, state, pkceChallengeFor(verifier));
    // Desktop/webview clients can't open a new tab, so they request this with
    // `Accept: application/json` to get the authorize URL back (to open in the
    // system browser) WHILE keeping the verifier/state cookies on the webview —
    // so the later /oauth/exchange of the pasted code finds its verifier. The
    // default browser path still gets the 302 redirect, unchanged.
    if ((req.headers.accept ?? '').includes('application/json')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': setCookie });
      res.end(JSON.stringify({ authorizeUrl }));
      return true;
    }
    res.writeHead(302, { Location: authorizeUrl, 'Set-Cookie': setCookie });
    res.end();
    return true;
  }

  // GET /api/assistant/oauth/callback — exchange the code, store the token.
  if (method === 'GET' && pathname === '/api/assistant/oauth/callback') {
    const cfg = readOAuthConfig();
    // Must MATCH the redirect_uri used at /start (OAuth binds them) — derived
    // from the same origin, so the same value unless pinned by env.
    if (!cfg.redirectUri) cfg.redirectUri = oauthRedirectUri(req);
    const url = new URL(req.url ?? '', 'http://localhost');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookies = parseCookies(req);
    const verifier = cookies.lat_oauth_verifier;
    const clear = [
      'lat_oauth_verifier=; HttpOnly; Path=/; Max-Age=0',
      'lat_oauth_state=; HttpOnly; Path=/; Max-Age=0',
    ];
    const redirect = (flash: string): void => {
      res.writeHead(302, {
        Location: `/#/settings/user-config?oauth=${flash}`,
        'Set-Cookie': clear,
      });
      res.end();
    };
    if (!code || !state || !verifier || state !== cookies.lat_oauth_state) {
      redirect('error');
      return true;
    }
    try {
      const tokens = await exchangeCodeForTokens(cfg, code, verifier, state);
      // Machine-level, like the API-key PUT + the refresh path — so a connected
      // subscription persists across every workspace, not just the one that was
      // active when the user linked it (otherwise the OAuth-connect path would
      // re-introduce the per-workspace de-attach bug).
      setAssistantCredential(CLAUDE_OAUTH_KIND, JSON.stringify(tokens));
      redirect('connected');
    } catch {
      redirect('error');
    }
    return true;
  }

  // POST /api/assistant/oauth/exchange — the MANUAL code-paste flow. After the
  // user authorizes in the popped tab, the provider shows a code (often
  // `<code>#<state>`); they paste it here. We verify the state against the cookie
  // set at /start, exchange it for tokens, and store them. Body: { code }.
  if (method === 'POST' && pathname === '/api/assistant/oauth/exchange') {
    const cfg = readOAuthConfig();
    const cookies = parseCookies(req);
    const verifier = cookies.lat_oauth_verifier;
    const clear = [
      'lat_oauth_verifier=; HttpOnly; Path=/; Max-Age=0',
      'lat_oauth_state=; HttpOnly; Path=/; Max-Age=0',
    ];
    try {
      const body = await readJson(req);
      const raw = typeof body.code === 'string' ? body.code.trim() : '';
      // The pasted value may be `<code>#<state>`; split off the state.
      const hash = raw.indexOf('#');
      const code = hash >= 0 ? raw.slice(0, hash) : raw;
      const pastedState = hash >= 0 ? raw.slice(hash + 1) : '';
      if (!code || !verifier) {
        sendJson(
          res,
          { ok: false, error: 'Paste the full code from the Claude authorization page.' },
          400,
        );
        return true;
      }
      // CSRF: if the paste carried a state, it must match the one we issued.
      if (pastedState && cookies.lat_oauth_state && pastedState !== cookies.lat_oauth_state) {
        sendJson(
          res,
          {
            ok: false,
            error: 'That code does not match this connection attempt — try Connect again.',
          },
          400,
        );
        return true;
      }
      // `||` (not `??`): an EMPTY pasted state should fall through to the cookie.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      const state = pastedState || cookies.lat_oauth_state || undefined;
      const tokens = await exchangeCodeForTokens(cfg, code, verifier, state);
      setAssistantCredential(CLAUDE_OAUTH_KIND, JSON.stringify(tokens));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'Set-Cookie': clear,
      });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, {
        'content-type': 'application/json; charset=utf-8',
        'Set-Cookie': clear,
      });
      res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
    return true;
  }

  // DELETE /api/assistant/oauth — disconnect the linked Claude subscription.
  // (The OAuth token isn't a named API-key credential, so it's cleared here
  // rather than via /api/assistant/key.)
  if (method === 'DELETE' && pathname === '/api/assistant/oauth') {
    deleteAssistantCredential(CLAUDE_OAUTH_KIND);
    sendJson(res, { ok: true });
    return true;
  }

  return false;
}
