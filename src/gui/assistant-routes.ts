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
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
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
    for (const extra of extras) await db.update('secrets', extra.id, { deleted_at: new Date().toISOString() });
  } else {
    await db.insert('secrets', { id: crypto.randomUUID(), name, kind, value, description: `${name} (assistant).` });
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
 * Resolve the Claude API token. Prefers the encrypted `secrets` row; falls
 * back to the `ANTHROPIC_API_KEY` env var. Server-side only.
 */
export async function getAnthropicApiKey(db: Lattice): Promise<string | null> {
  return (await secretValue(db, CREDENTIALS.anthropic.kind)) ?? process.env.ANTHROPIC_API_KEY ?? null;
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
export async function getVoiceCredential(db: Lattice): Promise<VoiceCredential | null> {
  const openai = (await secretValue(db, CREDENTIALS.openai.kind)) ?? process.env.OPENAI_API_KEY ?? null;
  if (openai) return { provider: 'openai', apiKey: openai };
  const eleven =
    (await secretValue(db, CREDENTIALS.elevenlabs.kind)) ?? process.env.ELEVENLABS_API_KEY ?? null;
  if (eleven) return { provider: 'elevenlabs', apiKey: eleven };
  return null;
}

async function hasCredential(db: Lattice, name: CredentialName, envVar: string): Promise<boolean> {
  return Boolean(await secretValue(db, CREDENTIALS[name].kind)) || Boolean(process.env[envVar]);
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
  const betaHeader = process.env.ANTHROPIC_OAUTH_BETA || undefined;
  const oauthRaw = await secretValue(db, CLAUDE_OAUTH_KIND);
  if (oauthRaw) {
    try {
      let tokens = JSON.parse(oauthRaw) as StoredOAuthTokens;
      const cfg = readOAuthConfig();
      if (cfg && tokens.refresh_token && tokens.expires_at && Date.now() > tokens.expires_at - 60_000) {
        const refreshed = await refreshAccessToken(cfg, tokens.refresh_token);
        tokens = {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
          expires_at: refreshed.expires_at,
        };
        await storeSecret(db, CLAUDE_OAUTH_KIND, 'Claude subscription', JSON.stringify(tokens));
      }
      if (tokens.access_token) return { authToken: tokens.access_token, betaHeader };
    } catch {
      // Malformed token blob — fall through to the API-key path.
    }
  }
  const apiKey = (await secretValue(db, CREDENTIALS.anthropic.kind)) ?? process.env.ANTHROPIC_API_KEY ?? null;
  return apiKey ? { apiKey } : null;
}

/** Whether any Claude auth (subscription OR API key) is configured. */
export async function hasClaudeAuth(db: Lattice): Promise<boolean> {
  return (
    Boolean(await secretValue(db, CLAUDE_OAUTH_KIND)) ||
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
      oauthEnabled: oauthConfigured(),
    });
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
    const [first, ...extras] = await liveSecretsOfKind(db, cred.kind);
    if (first) {
      await db.update('secrets', first.id, { value: key, name: cred.name });
      for (const extra of extras) {
        await db.update('secrets', extra.id, { deleted_at: new Date().toISOString() });
      }
    } else {
      await db.insert('secrets', {
        id: crypto.randomUUID(),
        name: cred.name,
        kind: cred.kind,
        value: key,
        description: `${cred.name} used by the assistant sidebar.`,
      });
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
    const mime = req.headers['content-type'] || 'audio/webm';
    const ext = mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('wav') ? 'wav' : 'webm';
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
      'Set-Cookie': [`lat_oauth_verifier=${verifier}; ${cookieOpts}`, `lat_oauth_state=${state}; ${cookieOpts}`],
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
    const clear = ['lat_oauth_verifier=; HttpOnly; Path=/; Max-Age=0', 'lat_oauth_state=; HttpOnly; Path=/; Max-Age=0'];
    const redirect = (flash: string): void => {
      res.writeHead(302, { Location: `/#/settings/user-config?oauth=${flash}`, 'Set-Cookie': clear });
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
