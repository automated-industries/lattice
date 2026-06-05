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
} from '../framework/user-config.js';

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
  db: Lattice;
  pathname: string;
  method: string;
}

interface SecretRow {
  id: string;
  kind?: string | null;
  value?: string | null;
  deleted_at?: string | null;
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
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

/** Upsert a single live secret row of a kind (keeping one binding). */
async function storeSecret(db: Lattice, kind: string, name: string, value: string): Promise<void> {
  const [first, ...extras] = await liveSecretsOfKind(db, kind);
  if (first) {
    await db.update('secrets', first.id, { value, name });
    for (const extra of extras)
      await db.update('secrets', extra.id, { deleted_at: new Date().toISOString() });
  } else {
    await db.insert('secrets', {
      id: crypto.randomUUID(),
      name,
      kind,
      value,
      description: `${name} (assistant).`,
    });
  }
}

/** Live (non-deleted) secret rows for a given kind. */
async function liveSecretsOfKind(db: Lattice, kind: string): Promise<SecretRow[]> {
  const rows = (await db.query('secrets', {
    filters: [{ col: 'kind', op: 'eq', val: kind }],
  })) as unknown as SecretRow[];
  return rows.filter((r) => !r.deleted_at);
}

/** Decrypted value of the first live secret row of a kind (framework decrypts on read). */
async function secretValue(db: Lattice, kind: string): Promise<string | null> {
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
 */
async function readMachineCredential(db: Lattice, kind: string): Promise<string | null> {
  const fromMachine = getAssistantCredential(kind);
  if (fromMachine) return fromMachine;
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
 * Resolve the Claude API token. Prefers the machine-local credential store
 * (persists across workspaces), then the workspace `secrets` row (back-compat),
 * then the `ANTHROPIC_API_KEY` env var. Server-side only.
 */
export async function getAnthropicApiKey(db: Lattice): Promise<string | null> {
  return (
    (await readMachineCredential(db, CREDENTIALS.anthropic.kind)) ??
    process.env.ANTHROPIC_API_KEY ??
    null
  );
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
 * new junctions. Stored in `secrets`; falls back to {@link DEFAULT_AGGRESSIVENESS}.
 */
export async function getAggressiveness(db: Lattice): Promise<number> {
  const raw = await secretValue(db, AGGRESSIVENESS_KIND);
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_AGGRESSIVENESS;
  return Math.min(1, Math.max(0, n));
}

/** Map aggressiveness → an Anthropic sampling temperature in [0, 1]. */
export function aggressivenessToTemperature(aggressiveness: number): number {
  return Math.min(1, Math.max(0, aggressiveness));
}

export async function getVoiceCredential(db: Lattice): Promise<VoiceCredential | null> {
  const openai =
    (await readMachineCredential(db, CREDENTIALS.openai.kind)) ??
    process.env.OPENAI_API_KEY ??
    null;
  const eleven =
    (await readMachineCredential(db, CREDENTIALS.elevenlabs.kind)) ??
    process.env.ELEVENLABS_API_KEY ??
    null;
  const pref = await secretValue(db, STT_PROVIDER_KIND);
  // Honor an explicit choice when its key is available, else infer (OpenAI first).
  if (pref === 'elevenlabs' && eleven) return { provider: 'elevenlabs', apiKey: eleven };
  if (pref === 'openai' && openai) return { provider: 'openai', apiKey: openai };
  if (openai) return { provider: 'openai', apiKey: openai };
  if (eleven) return { provider: 'elevenlabs', apiKey: eleven };
  return null;
}

async function hasCredential(db: Lattice, name: CredentialName, envVar: string): Promise<boolean> {
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
export async function resolveClaudeAuth(db: Lattice): Promise<ClaudeAuth | null> {
  // Treat an empty env var the same as unset, so `||` (not `??`) is correct here.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const betaHeader = process.env.ANTHROPIC_OAUTH_BETA || undefined;
  const oauthRaw = await readMachineCredential(db, CLAUDE_OAUTH_KIND);
  if (oauthRaw) {
    try {
      let tokens = JSON.parse(oauthRaw) as StoredOAuthTokens;
      const cfg = readOAuthConfig();
      if (
        cfg &&
        tokens.refresh_token &&
        tokens.expires_at &&
        Date.now() > tokens.expires_at - 60_000
      ) {
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
  const apiKey =
    (await readMachineCredential(db, CREDENTIALS.anthropic.kind)) ??
    process.env.ANTHROPIC_API_KEY ??
    null;
  return apiKey ? { apiKey } : null;
}

/** Whether any Claude auth (subscription OR API key) is configured. */
export async function hasClaudeAuth(db: Lattice): Promise<boolean> {
  return (
    Boolean(await readMachineCredential(db, CLAUDE_OAUTH_KIND)) ||
    (await hasCredential(db, 'anthropic', 'ANTHROPIC_API_KEY'))
  );
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
      hasVoiceKey: voice !== null,
      sttProvider: voice?.provider ?? null,
      sttPreference: (await secretValue(db, STT_PROVIDER_KIND)) ?? 'auto',
      aggressiveness: await getAggressiveness(db),
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
    await storeSecret(db, AGGRESSIVENESS_KIND, 'Inference aggressiveness', String(value));
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
    if (!['auto', 'openai', 'elevenlabs'].includes(provider)) {
      sendJson(res, { error: `unknown provider: ${provider}` }, 400);
      return true;
    }
    if (provider === 'auto') {
      for (const row of await liveSecretsOfKind(db, STT_PROVIDER_KIND)) {
        await db.update('secrets', row.id, { deleted_at: new Date().toISOString() });
      }
    } else {
      await storeSecret(db, STT_PROVIDER_KIND, 'Voice provider preference', provider);
    }
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
    for (const row of await liveSecretsOfKind(db, cred.kind)) {
      await db.update('secrets', row.id, { deleted_at: new Date().toISOString() });
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
    // workspace's secrets table.
    deleteAssistantCredential(CREDENTIALS[name].kind);
    for (const row of await liveSecretsOfKind(db, CREDENTIALS[name].kind)) {
      await db.update('secrets', row.id, { deleted_at: new Date().toISOString() });
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

  // GET /api/assistant/oauth/start — begin the PKCE subscription flow.
  if (method === 'GET' && pathname === '/api/assistant/oauth/start') {
    const cfg = readOAuthConfig();
    if (!cfg) {
      sendJson(res, { error: 'oauth_not_configured' }, 503);
      return true;
    }
    const verifier = generatePkceVerifier();
    const state = generateState();
    const cookieOpts = 'HttpOnly; Path=/; Max-Age=300; SameSite=Lax';
    res.writeHead(302, {
      Location: buildAuthorizeUrl(cfg, state, pkceChallengeFor(verifier)),
      'Set-Cookie': [
        `lat_oauth_verifier=${verifier}; ${cookieOpts}`,
        `lat_oauth_state=${state}; ${cookieOpts}`,
      ],
    });
    res.end();
    return true;
  }

  // GET /api/assistant/oauth/callback — exchange the code, store the token.
  if (method === 'GET' && pathname === '/api/assistant/oauth/callback') {
    const cfg = readOAuthConfig();
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
    if (!cfg || !code || !state || !verifier || state !== cookies.lat_oauth_state) {
      redirect('error');
      return true;
    }
    try {
      const tokens = await exchangeCodeForTokens(cfg, code, verifier);
      await storeSecret(db, 'claude_oauth', 'Claude subscription', JSON.stringify(tokens));
      redirect('connected');
    } catch {
      redirect('error');
    }
    return true;
  }

  return false;
}
