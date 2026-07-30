import type { Lattice } from '../lattice.js';
import type { SttProvider } from '../gui/ai/transcribe.js';
import { setClaudeAuthWarning, clearClaudeAuthWarning } from '../gui/ai/auth-warn-state.js';
import { readOAuthConfig, refreshAccessToken, OAuthExchangeError } from '../gui/ai/oauth.js';
import type { ClaudeAuth } from '../gui/ai/chat.js';
import {
  getAssistantCredential,
  setAssistantCredential,
  deleteAssistantCredential,
  isAssistantCredentialCleared,
  readPreferences,
} from '../framework/user-config.js';
import { activeProviderKind, type LlmProviderKind } from '../gui/ai/provider-config.js';
import { isAuthError } from '../gui/ai/error-humanize.js';

/**
 * Assistant configuration + credential resolution — a capability, not a route.
 *
 * Everything here answers questions the product has to be able to answer no
 * matter who is asking: is a model connected, which credential should a call
 * use, what is the clarify threshold, which speech-to-text key is available.
 * The chat assistant asks them, the importer asks them, workspace open asks
 * them. None of those are HTTP.
 *
 * This lived inside `gui/assistant-routes.ts` until the layering split, which
 * meant a background job or a CLI command could only reach it by importing an
 * HTTP route file — dragging a server module into a code path that never serves
 * a request. That is backwards: a route is one way to call a capability, so a
 * capability must never live inside one. The rule the layering test enforces is
 * that arrows point this way only — a route may import this module; this module
 * must never import a route.
 *
 * Nothing here touches a request or a response object. `assistant-routes.ts`
 * re-exports the whole surface, so callers that predate the split keep working
 * unchanged.
 */
export const CLAUDE_OAUTH_KIND = 'claude_oauth';

/** Short credential names (used in the API) → `secrets.kind` + display name. */
export const CREDENTIALS = {
  anthropic: { kind: 'anthropic_api_key', name: 'Claude API token' },
  openai: { kind: 'openai_api_key', name: 'OpenAI API key' },
  elevenlabs: { kind: 'elevenlabs_api_key', name: 'ElevenLabs API key' },
} as const;
export type CredentialName = keyof typeof CREDENTIALS;

export const ANTHROPIC_KEY_KIND = CREDENTIALS.anthropic.kind;

interface SecretRow {
  id: string;
  kind?: string | null;
  value?: string | null;
  deleted_at?: string | null;
}

/** Live (non-deleted) secret rows for a given kind. */
export async function liveSecretsOfKind(db: Lattice, kind: string): Promise<SecretRow[]> {
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
 * Managed-deployment mode. When `LATTICE_MANAGED_MODEL_AUTH` is set, Lattice is
 * running as a managed service where the operator supplies the model credential
 * through the environment (typically alongside `ANTHROPIC_BASE_URL`, so calls go
 * through the operator's own endpoint). In this mode per-user credential
 * configuration is disabled: a pasted API key or a connected subscription is
 * never read, so every model call uses the operator-provided credential and a
 * user cannot substitute their own. Off by default — a normal single-user
 * install is unaffected.
 */
export function isManagedModelAuth(): boolean {
  const v = process.env.LATTICE_MANAGED_MODEL_AUTH;
  return v === '1' || v === 'true';
}

/**
 * Resolve the anthropic API key, honoring the authoritative "cleared" sentinel.
 * When the user has cleared the key, BOTH the stored read and the env fallback
 * are skipped — so a clear stays cleared across reloads/restarts until a new key
 * is saved (which clears the sentinel). Otherwise: machine store → workspace
 * `secrets` (back-compat) → `ANTHROPIC_API_KEY` env var.
 */
async function resolveAnthropicKey(db: Lattice | null): Promise<string | null> {
  // Managed deployment: use ONLY the operator's env credential; never read a
  // stored per-user key (it must not override the operator's).
  if (isManagedModelAuth()) return process.env.ANTHROPIC_API_KEY ?? null;
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

/** Inference aggressiveness (0 = conservative … 1 = aggressive), fixed for all users. */
export const DEFAULT_AGGRESSIVENESS = 0.9;

/**
 * The assistant's "inference aggressiveness" — a single behaviour knob (0 = only
 * high-confidence, conservative changes; 1 = eagerly add/enrich/link/extrapolate).
 * Drives the model sampling temperature AND how liberally ingest materializes new
 * junctions. This is now FIXED at {@link DEFAULT_AGGRESSIVENESS} for every user — the
 * per-user selector was removed; a high, eager setting is the intended experience — so a
 * stale stored preference no longer applies.
 */
export function getAggressiveness(): number {
  return DEFAULT_AGGRESSIVENESS;
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

/** Default clarify threshold (see {@link getClarifyThreshold}). */
export const DEFAULT_CLARIFY_THRESHOLD = 0.6;

/**
 * The user's "clarify threshold" — the single confidence bar that decides when
 * an automated inference asks the user instead of guessing: confidence ≥ the
 * threshold → act silently; between the floor (threshold / 2, derived by each
 * consumer via {@link clarifyFloor}) and the threshold → ask a short
 * multiple-choice question; below the floor → drop the inference as noise.
 * A USER preference (machine-local `preferences.json`), same model as
 * {@link getAggressiveness}. Falls back to {@link DEFAULT_CLARIFY_THRESHOLD}.
 */
export function getClarifyThreshold(): number {
  const n = readPreferences().clarify_threshold;
  if (!Number.isFinite(n)) return DEFAULT_CLARIFY_THRESHOLD;
  return Math.min(1, Math.max(0, n));
}

/** The "drop as noise" floor derived from a clarify threshold. */
export function clarifyFloor(threshold: number): number {
  return threshold / 2;
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

export async function hasCredential(
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
  // Managed deployment: the operator provides the credential via env; a user's
  // connected subscription or pasted key must never override it. Short-circuit
  // before any stored-credential read so managed auth is always the env key.
  // Do NOT set auth warnings on managed deployments — the operator's credential
  // path is out of the user's hands.
  if (isManagedModelAuth()) {
    const managedKey = process.env.ANTHROPIC_API_KEY ?? null;
    return managedKey ? { apiKey: managedKey } : null;
  }
  // Treat an empty env var the same as unset, so `||` (not `??`) is correct here.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const betaHeader = process.env.ANTHROPIC_OAUTH_BETA || undefined;
  const oauthRaw = await readMachineCredential(db, CLAUDE_OAUTH_KIND);
  if (oauthRaw) {
    // A connected Claude subscription is STRICTLY preferred over an API key:
    // having a key configured must never override OAuth, and a transient refresh
    // failure must NOT silently switch auth (that would quietly run the assistant
    // on a different account/billing). We reach the API-key fallback below only
    // when there is no usable OAuth token at all.
    try {
      let tokens = JSON.parse(oauthRaw) as StoredOAuthTokens;
      if (tokens.refresh_token && tokens.expires_at && Date.now() > tokens.expires_at - 60_000) {
        try {
          const cfg = readOAuthConfig();
          const refreshed = await refreshAccessToken(cfg, tokens.refresh_token);
          tokens = {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
            expires_at: refreshed.expires_at,
          };
          // Refreshed tokens persist machine-level so the subscription stays
          // connected across every workspace, not just the one that linked it.
          setAssistantCredential(CLAUDE_OAUTH_KIND, JSON.stringify(tokens));
          // A successful refresh clears any prior warning — the subscription is
          // working and the user can keep chatting.
          clearClaudeAuthWarning();
        } catch (e) {
          // Distinguish terminal failures (refresh token expired/revoked) from
          // transient failures (network blip, 5xx, timeout). A terminal failure
          // (invalid_grant) means the refresh token will never work again, so
          // we signal this to the client so the user sees a reconnect notice
          // before the current access token expires and calls start failing.
          const isTerminal = e instanceof OAuthExchangeError && e.kind === 'invalid_grant';
          if (isTerminal) {
            setClaudeAuthWarning();
            console.warn(
              '[lattice/assistant] Claude subscription token refresh failed with invalid_grant (terminal); setting auth warning:',
              (e as Error).message,
            );
          } else {
            // Transient failure (network, 5xx, timeout, etc.). Do NOT set the
            // warning — the current access token may still be valid and the user
            // may keep chatting. On the next refresh attempt, if the network
            // recovers or the server comes back, the warning clears automatically.
            console.warn(
              '[lattice/assistant] Claude subscription token refresh failed (transient); keeping the connected subscription (re-connect if calls start failing):',
              (e as Error).message,
            );
          }
        }
      }
      if (tokens.access_token) return { authToken: tokens.access_token, betaHeader };
      console.warn(
        '[lattice/assistant] Claude subscription is connected but has no usable access token — re-connect Claude.',
      );
    } catch (e) {
      // The stored OAuth blob is corrupt/unreadable — genuinely unusable.
      console.warn(
        '[lattice/assistant] stored Claude subscription credential is unreadable; re-connect Claude:',
        (e as Error).message,
      );
    }
  }
  // No usable OAuth → not connected. Claude access is OAuth-only in a normal
  // install (the per-user API-key path was removed); a managed deployment already
  // returned its operator env credential at the top of this function.
  return null;
}

/**
 * The single connected/disconnected truth the server gate and the client wall
 * both read. True when a model call would succeed: a managed deployment has its
 * operator env credential, otherwise a Claude subscription (OAuth token) is
 * connected. Deliberately a presence check — no token refresh — so it stays cheap
 * on the per-request gate.
 */
export async function isClaudeConnected(db: Lattice | null): Promise<boolean> {
  if (isManagedModelAuth()) return Boolean(process.env.ANTHROPIC_API_KEY);
  return Boolean(await readMachineCredential(db, CLAUDE_OAUTH_KIND));
}

/**
 * Whether a Claude subscription (OAuth) is connected: 'oauth' when a subscription
 * token is stored, else null. Claude access is OAuth-only in a normal install, so
 * there is no 'key' kind. A managed deployment authenticates via the operator's
 * env credential and is reflected by `connected` + `managedModelAuth` on the
 * config instead — see {@link isClaudeConnected}.
 */
export async function claudeAuthKind(db: Lattice | null): Promise<'oauth' | null> {
  if (await readMachineCredential(db, CLAUDE_OAUTH_KIND)) return 'oauth';
  return null;
}

/**
 * When a model call fails with an auth error (401/403) AND the active backend is a
 * connected Claude subscription (OAuth), DISCONNECT it — deleting the stored token so
 * `isClaudeConnected` (hence `config.connected`) flips to false. This is the confirmed
 * signal that the token is dead: `resolveClaudeAuth` deliberately keeps the token on a
 * refresh *failure* (a transient network blip must not eject a valid subscription), so
 * only a real 401 from an actual call proves it's expired/revoked. Once disconnected,
 * the chat's existing "re-check config, re-onboard if disconnected" path prompts the
 * user to reconnect instead of failing every turn on a dead token. Returns true when it
 * disconnected.
 *
 * Scoped strictly to the OAuth subscription: a managed deployment's operator credential
 * is never touched; a bring-your-own Claude API key (configured as an OpenAI-compatible
 * anthropic endpoint — also provider kind 'anthropic') is the user's to manage, not ours
 * to auto-delete; and a Lattice Cloud account (kind 'lattice_cloud') re-mints its own
 * short-lived credential rather than disconnecting.
 */
export async function maybeDisconnectExpiredClaude(
  db: Lattice | null,
  providerKind: LlmProviderKind,
  err: unknown,
): Promise<boolean> {
  if (!isAuthError(err)) return false;
  if (isManagedModelAuth()) return false; // operator-owned credential, never user-cleared
  if (providerKind !== 'anthropic') return false; // cloud/openai-compat manage their own auth
  if (activeProviderKind() === 'openai_compat') return false; // a BYO key, not the OAuth sub
  if ((await claudeAuthKind(db)) !== 'oauth') return false; // no OAuth subscription stored
  deleteAssistantCredential(CLAUDE_OAUTH_KIND);
  // A confirmed 401/403 means the credential is dead — clear any warning.
  clearClaudeAuthWarning();
  console.warn(
    '[lattice/assistant] Claude subscription auth failed (401/403) — disconnected the expired subscription; the user must reconnect Claude.',
  );
  return true;
}
