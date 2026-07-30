import type { Lattice } from '../lattice.js';
import type { SttProvider } from '../gui/ai/transcribe.js';
import {
  setClaudeAuthWarning,
  clearClaudeAuthWarning,
  getClaudeAuthWarning,
  type ClaudeAuthWarning,
} from '../gui/ai/auth-warn-state.js';
import {
  readOAuthConfig,
  refreshAccessToken,
  oauthConfigured,
  OAuthExchangeError,
} from '../gui/ai/oauth.js';
import type { ClaudeAuth } from '../gui/ai/chat.js';
import {
  getAssistantCredential,
  setAssistantCredential,
  deleteAssistantCredential,
  isAssistantCredentialCleared,
  setAssistantCredentialCleared,
  clearAssistantCredentialCleared,
  readPreferences,
} from '../framework/user-config.js';
import {
  activeProviderKind,
  readOpenAiCompatConfig,
  setOpenAiCompatConfig,
  clearOpenAiCompatConfig,
  readLatticeCloudConfig,
  clearLatticeCloudConfig,
  setActiveProvider,
  type LlmProviderKind,
  type StoredOpenAiCompat,
  type StoredLatticeCloud,
} from '../gui/ai/provider-config.js';
import { refreshLatticeCloudCredential } from '../gui/identity/model.js';
import { isManagedWorkspaces } from '../gui/identity/managed.js';
import { getClaudeLimitState, type ClaudeLimitState } from '../gui/ai/limit-state.js';
import { voiceModeFromConfig, type VoiceMode, type VoicePreference } from '../gui/ai/voice-mode.js';
import { isAuthError } from '../gui/ai/error-humanize.js';
import { modelError, MANAGED_MODEL_REFUSAL, MANAGED_CREDENTIAL_REFUSAL } from './model-errors.js';

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

/* ────────────────────────────────────────────────────────────────────────────
 * Changing the configuration, not just reading it.
 *
 * Everything above answers questions. Everything below CHANGES the answers:
 * connect an endpoint, pick which backend answers turns, save or clear a key,
 * disconnect a subscription. Those were request handlers, which made the browser
 * the only way to configure a machine — so a server with no display could not be
 * pointed at a model at all, and a fleet could not be configured from a script.
 *
 * None of it needed a browser. Every value involved lives in the machine-local
 * credential store, and the one that touches a database only retires a leftover
 * row. So the work moved here verbatim and the request handlers became what they
 * should have been: parse, call, and shape a response.
 *
 * Refusals travel as TAGGED ERRORS (see `./model-errors.js`), never as a status
 * code — a capability that returned 403 would be asserting that its caller speaks
 * HTTP. The adapter maps the code onto its own transport; a command line prints
 * the sentence and exits non-zero.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Everything the app knows about how this machine reaches a model, as one value.
 *
 * Presence flags only — no endpoint on this surface ever returns a stored token,
 * and neither does this. It is the exact shape the browser client reads, so the
 * request handler passes it straight through, and a command-line status report
 * is looking at the same facts rather than a second, drifting summary of them.
 */
export interface ModelStatus {
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  hasElevenlabsKey: boolean;
  claudeAuthKind: 'oauth' | null;
  activeProvider: LlmProviderKind;
  openaiCompat: { configured: boolean; model: string | null; baseUrl: string | null };
  latticeCloud: { configured: boolean };
  connected: boolean;
  modelAccessBlocked: 'cloud_balance_exhausted' | null;
  limitState: ClaudeLimitState | null;
  authWarning: ClaudeAuthWarning | null;
  hasVoiceKey: boolean;
  sttProvider: SttProvider | null;
  sttPreference: VoicePreference;
  voiceMode: VoiceMode;
  localVoiceAvailable: boolean;
  aggressiveness: number;
  clarifyThreshold: number;
  oauthEnabled: boolean;
  managedModelAuth: boolean;
  managedWorkspaces: boolean;
  accountUrl: string | null;
  balanceCents: number | null;
  balanceUnavailable: boolean;
  topUpUrl: string | null;
}

/**
 * Report how this machine reaches a model: which credentials are present, which
 * backend is active, whether a turn would succeed, and what is blocking it when
 * one would not. Changes nothing.
 */
export async function readModelStatus(db: Lattice | null): Promise<ModelStatus> {
  const [hasAnthropicKey, hasOpenaiKey, hasElevenlabsKey] = await Promise.all([
    hasCredential(db, 'anthropic', 'ANTHROPIC_API_KEY'),
    hasCredential(db, 'openai', 'OPENAI_API_KEY'),
    hasCredential(db, 'elevenlabs', 'ELEVENLABS_API_KEY'),
  ]);
  const voice = await getVoiceCredential(db);
  const sttPreference = readPreferences().voice_provider;
  // On-device dictation is the keyless default — the mic is no longer gated on a
  // cloud voice key. `voiceMode` is the single signal the GUI acts on: 'local'
  // (on-device, keyless), a cloud provider (when its key is set), or 'off' (the
  // legacy "No Voice" sentinel). A configured cloud key still drives the cloud
  // transcribe fallback (see `transcribeRecording`).
  const voiceMode: VoiceMode = voiceModeFromConfig({
    preference: sttPreference,
    hasOpenaiKey,
    hasElevenlabsKey,
  });
  // OpenAI-compatible LLM provider (a base-URL + key + model the user connected as
  // an alternative backend). Presence + non-secret fields only — never the API key.
  const openaiCompat = readOpenAiCompatConfig();
  const latticeCloud = readLatticeCloudConfig();
  const claudeConnected = await isClaudeConnected(db);
  // Prepaid balance (cents) read from the metering proxy — for a managed
  // deployment (operator env credential) OR a per-user Lattice Cloud account
  // credential. null when neither applies or the proxy doesn't expose a balance
  // (a plain Anthropic base URL 404s — fail soft).
  let balanceCents: number | null = null;
  let topUpUrl: string | null = null;
  const balanceProbe: { base: string; key: string } | null = isManagedModelAuth()
    ? { base: process.env.ANTHROPIC_BASE_URL ?? '', key: process.env.ANTHROPIC_API_KEY ?? '' }
    : latticeCloud
      ? { base: latticeCloud.proxyBaseUrl, key: latticeCloud.token }
      : null;
  const balanceProbed = Boolean(balanceProbe?.base && balanceProbe.key);
  if (balanceProbe?.base && balanceProbe.key) {
    try {
      // Bounded on purpose: this answer now decides whether the app boots at all,
      // and it is fetched from a remote proxy. An unbounded wait on a wedged proxy
      // would hang the boot gate itself with nothing on screen; a timeout instead
      // yields "balance unknown", which is reported as such and deliberately does
      // NOT lock the user out.
      const r = await fetch(`${balanceProbe.base.replace(/\/$/, '')}/v1/balance`, {
        headers: { authorization: `Bearer ${balanceProbe.key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const b = (await r.json()) as { balance_cents?: number; top_up_url?: string };
        balanceCents = typeof b.balance_cents === 'number' ? b.balance_cents : null;
        topUpUrl = typeof b.top_up_url === 'string' ? b.top_up_url : null;
      }
    } catch {
      /* balance unavailable — reported as such below, never shown as zero */
    }
  }
  // We asked for a balance and got no number back. The caller must say
  // "unavailable" instead of formatting the null as $0.00 — "we could not read
  // your balance" and "you are out of tokens" are different facts and lead to
  // different actions.
  const balanceUnavailable = balanceProbed && balanceCents === null;
  // A cloud account with nothing left to spend is NOT a usable backend: every turn
  // would be refused by the proxy. Treating it as connected boots the app into a
  // state where all AI work fails, so it counts as not-connected and the caller
  // routes to top-up or another provider.
  //
  // Only a balance we actually read counts. An unreadable one is unknown, and
  // unknown must never lock a paid-up account out of its own app. A managed
  // deployment is out of scope here: the operator owns that credential, and the
  // per-user connect flow this unblocks is disabled there anyway.
  const cloudBalanceExhausted =
    !isManagedModelAuth() && latticeCloud !== null && balanceCents !== null && balanceCents <= 0;
  const usableLatticeCloud = latticeCloud !== null && !cloudBalanceExhausted;
  const connected = claudeConnected || openaiCompat !== null || usableLatticeCloud;
  return {
    hasAnthropicKey,
    hasOpenaiKey,
    hasElevenlabsKey,
    claudeAuthKind: await claudeAuthKind(db),
    // Which backend answers turns, and the OpenAI-compatible endpoint's non-secret
    // config (so a caller can show "Connected to gpt-4o at api.example.com").
    activeProvider: activeProviderKind(),
    openaiCompat: openaiCompat
      ? { configured: true, model: openaiCompat.model, baseUrl: openaiCompat.baseUrl }
      : { configured: false, model: null, baseUrl: null },
    // Lattice Cloud account model: presence only (never the token). Configured
    // once the account signs in and activates cloud model.
    latticeCloud: { configured: latticeCloud !== null },
    // The single connected/disconnected truth the client wall reads. True in a
    // managed deployment (operator env credential), when a Claude subscription is
    // connected, when an OpenAI-compatible endpoint is configured, OR when a
    // Lattice Cloud account model credential is active AND has balance left.
    connected,
    // Why `connected` is false when a backend IS configured, so the caller can
    // offer the specific way out instead of a generic "connect something".
    // 'cloud_balance_exhausted' = signed in, no tokens left → top up (or switch).
    modelAccessBlocked: !connected && cloudBalanceExhausted ? 'cloud_balance_exhausted' : null,
    // Claude usage-limit state (null unless the limit was hit). The chat shows
    // it and the Configure side reads it to block ingest/AI while limited.
    limitState: getClaudeLimitState(),
    // Claude auth-warning state (null unless a terminal token refresh failure
    // happened). The chat shows it as a reconnect notice so the user sees the
    // problem before mid-conversation 401 failures. Transient refresh failures
    // do NOT set this — the current access token may still be valid.
    authWarning: getClaudeAuthWarning(),
    hasVoiceKey: voice !== null,
    sttProvider: voice?.provider ?? null,
    sttPreference,
    voiceMode,
    // On-device speech is always available in a supporting browser; the asset
    // step is fail-soft, so the GUI also feature-detects the Worker at runtime.
    localVoiceAvailable: true,
    aggressiveness: getAggressiveness(),
    clarifyThreshold: getClarifyThreshold(),
    oauthEnabled: oauthConfigured(),
    // Managed deployment: the host supplies the model credential and per-user
    // credential controls are disabled. The GUI hides the connect/key UI.
    managedModelAuth: isManagedModelAuth(),
    // Managed workspaces: a workspace manager owns invite/members/revoke/create
    // for this session — the GUI delegates (email-only invite, single create
    // flow) and the token machinery has no caller. Same seam pattern as
    // managedModelAuth; a session without it behaves exactly as before.
    managedWorkspaces: isManagedWorkspaces(),
    // Operator-supplied account page for a managed/hosted deployment (null for a
    // normal install). The header account menu's "Account settings" action opens
    // it — that page owns billing / sign-out. Balance is mirrored here for display.
    accountUrl: process.env.LATTICE_ACCOUNT_URL ?? null,
    // Prepaid token balance in cents for a managed deployment OR a per-user cloud
    // account (null when neither applies, or when the read failed — see
    // `balanceUnavailable`), plus where to top up. Shown in the account menu.
    balanceCents,
    // True when a balance was asked for and none came back. The caller says so
    // rather than rendering the null as a zero.
    balanceUnavailable,
    topUpUrl,
  };
}

/** What connecting an OpenAI-compatible endpoint is told to do. */
export interface ModelEndpointInput {
  /** The endpoint's base URL — must be http(s). */
  baseUrl: string;
  /** The model id to send. */
  model: string;
  /**
   * The API key. Blank keeps the currently-stored key when one is already
   * connected (a settings edit never shows the key back, so an empty field is
   * not a request to clear it), and means "a keyless local server" on a first
   * connect where there is nothing to keep.
   */
  apiKey?: string | undefined;
  /** Extra headers the endpoint needs, if any. */
  headers?: Record<string, string> | undefined;
  /**
   * Verify the endpoint answers before keeping it. On failure the previous
   * configuration is put back and the failure is RETURNED, so a bad edit never
   * replaces a working one.
   */
  test?: boolean | undefined;
}

/** Connecting an endpoint either took, or was reverted and says why. */
export type ModelEndpointResult =
  | { ok: true; activeProvider: 'openai_compat'; model: string; baseUrl: string }
  | { ok: false; error: string };

/**
 * Connect an OpenAI-compatible endpoint (OpenAI, Azure, OpenRouter, a local
 * server, a gateway) as the assistant's backend, and make it active.
 *
 * NO provider-specific authentication is built in: the caller supplies the base
 * URL, key, model, and any extra headers their endpoint needs. Stored
 * machine-local and encrypted, like every other assistant credential.
 *
 * @throws invalid_request when the URL or model is missing or malformed.
 * @throws managed_model_auth on a deployment whose operator owns the credential.
 */
export async function connectModelEndpoint(
  db: Lattice | null,
  input: ModelEndpointInput,
): Promise<ModelEndpointResult> {
  // Managed deployment: the operator owns the model credential; a user must not
  // point the assistant at their own backend (see resolveLlmProvider's managed gate).
  if (isManagedModelAuth()) throw modelError('managed_model_auth', MANAGED_MODEL_REFUSAL);
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  const rawKey = (input.apiKey ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(baseUrl)) {
    throw modelError('invalid_request', 'baseUrl must be an http(s) URL');
  }
  if (!model) throw modelError('invalid_request', 'model is required');
  const prior = readOpenAiCompatConfig();
  // On a settings EDIT a blank key means "keep the current key"; on first connect
  // there is no prior, so a blank key = a keyless local server.
  const apiKey = rawKey === '' && prior ? prior.apiKey : rawKey;
  const cfg: StoredOpenAiCompat = {
    baseUrl,
    apiKey,
    model,
    ...(input.headers ? { headers: input.headers } : {}),
  };
  setOpenAiCompatConfig(cfg);
  if (input.test === true) {
    const result = await testModelProvider(db);
    if (!result.ok) {
      if (prior) setOpenAiCompatConfig(prior);
      else clearOpenAiCompatConfig();
      return { ok: false, error: result.error };
    }
  }
  return { ok: true, activeProvider: 'openai_compat', model, baseUrl };
}

/**
 * Forget the OpenAI-compatible endpoint. The active provider falls back to
 * Anthropic — a connected Claude subscription still works.
 *
 * @returns the provider that is active afterwards.
 */
export function disconnectModelEndpoint(): LlmProviderKind {
  clearOpenAiCompatConfig();
  return 'anthropic';
}

/**
 * Activate the signed-in account's hosted model: mint a scoped proxy credential
 * from the encrypted identity session and make it the active provider.
 *
 * The credential is DERIVED from the session and never supplied by the caller,
 * which is what keeps it scoped, short-lived, and revocable by signing the device
 * out.
 *
 * @throws managed_model_auth on a deployment whose operator owns the credential.
 * @throws account_not_signed_in when there is no session to mint from.
 */
export async function connectAccountModel(): Promise<StoredLatticeCloud> {
  if (isManagedModelAuth()) throw modelError('managed_model_auth', MANAGED_MODEL_REFUSAL);
  const cfg = await refreshLatticeCloudCredential();
  if (!cfg) {
    throw modelError('account_not_signed_in', 'Sign in with your Lattice Cloud account first.');
  }
  return cfg;
}

/**
 * Stop using the account's hosted model. The active provider falls back to
 * Anthropic.
 *
 * @returns the provider that is active afterwards.
 */
export function disconnectAccountModel(): LlmProviderKind {
  clearLatticeCloudConfig();
  return 'anthropic';
}

/**
 * Choose which already-configured backend answers turns, without disconnecting
 * the other.
 *
 * @throws invalid_request for a kind that is not a selectable backend.
 * @throws provider_not_configured when the chosen backend has nothing stored —
 * selecting it would strand the assistant on a backend that resolves to nothing.
 * @throws managed_model_auth on a deployment whose operator owns the credential.
 */
export function selectModelProvider(provider: string): LlmProviderKind {
  if (isManagedModelAuth()) throw modelError('managed_model_auth', MANAGED_MODEL_REFUSAL);
  if (provider !== 'anthropic' && provider !== 'openai_compat') {
    throw modelError('invalid_request', "provider must be 'anthropic' or 'openai_compat'");
  }
  if (provider === 'openai_compat' && !readOpenAiCompatConfig()) {
    throw modelError('provider_not_configured', 'no OpenAI-compatible endpoint is configured');
  }
  setActiveProvider(provider);
  return provider;
}

/**
 * Ask the active backend to answer one trivial prompt, so a caller can prove the
 * model really responds before relying on it.
 *
 * Never throws for a model that answered badly: a backend that refused, timed
 * out, or is not configured at all is an OUTCOME of the check, and the reason is
 * the useful part.
 */
export async function testModelProvider(
  db: Lattice | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Imported here rather than at the top because the provider resolver imports
  // this module — a static import each way would be a cycle.
  const { resolveLlmProvider, smokeTestProvider } = await import('../gui/ai/provider.js');
  const provider = await resolveLlmProvider(db);
  if (!provider) return { ok: false, error: 'No model provider is configured.' };
  return smokeTestProvider(provider);
}

/**
 * Save a speech credential (OpenAI or ElevenLabs), machine-level.
 *
 * Machine-level is the point: storing it inside a workspace meant creating a new
 * workspace started with an empty `secrets` table and the key appeared to
 * de-attach. Any leftover pre-machine copy in the active workspace is retired in
 * the same call, so the machine store is unambiguously the source of truth.
 *
 * @throws invalid_request for an unknown credential name, an empty key, or
 * `anthropic` — Claude access is a connected subscription, not a pasted key.
 * @throws managed_model_auth on a deployment whose operator owns the credential.
 */
export async function setAssistantApiKey(
  db: Lattice | null,
  name: string,
  key: string,
): Promise<void> {
  if (isManagedModelAuth()) throw modelError('managed_model_auth', MANAGED_CREDENTIAL_REFUSAL);
  const cred = assistantCredentialFor(name);
  const value = key.trim();
  if (!value) throw modelError('invalid_request', 'key is required');
  setAssistantCredential(cred.kind, value);
  // Saving a new value un-clears the authoritative "cleared" sentinel, so the
  // env fallback (and presence flags) resolve normally again.
  clearAssistantCredentialCleared(cred.kind);
  // Retire any leftover pre-machine copy in the active workspace's secrets.
  // Nothing to retire with no workspace open — db is null there.
  await retireWorkspaceCopies(db, cred.kind);
}

/**
 * Clear a speech credential.
 *
 * Clearing sets an authoritative sentinel as well as deleting the value, so the
 * environment-variable fallback is suppressed and the key STAYS cleared across
 * restarts until a new one is saved. Without it, a machine with the variable set
 * would report the key back as present the moment the process restarted.
 *
 * @throws invalid_request for an unknown credential name, or `anthropic`.
 * @throws managed_model_auth on a deployment whose operator owns the credential.
 */
export async function clearAssistantApiKey(db: Lattice | null, name: string): Promise<void> {
  if (isManagedModelAuth()) throw modelError('managed_model_auth', MANAGED_CREDENTIAL_REFUSAL);
  const cred = assistantCredentialFor(name);
  deleteAssistantCredential(cred.kind);
  setAssistantCredentialCleared(cred.kind);
  await retireWorkspaceCopies(db, cred.kind);
}

/**
 * Disconnect the linked Claude subscription.
 *
 * The subscription token is not one of the named API-key credentials, so it is
 * cleared here rather than through {@link clearAssistantApiKey}. Disconnecting
 * also clears any standing auth warning: the subscription no longer exists, so a
 * notice telling the user to reconnect a broken one would be about nothing.
 */
export function disconnectClaudeSubscription(): void {
  deleteAssistantCredential(CLAUDE_OAUTH_KIND);
  clearClaudeAuthWarning();
}

/**
 * Resolve a credential name to its stored kind, or refuse.
 *
 * `anthropic` is refused rather than accepted-and-ignored: Claude access is
 * OAuth-only in a normal install, and silently storing a pasted key that nothing
 * would ever read is worse than saying so.
 */
function assistantCredentialFor(name: string): (typeof CREDENTIALS)[CredentialName] {
  if (!(name in CREDENTIALS)) {
    throw modelError('invalid_request', `unknown credential kind: ${name}`);
  }
  if (name === 'anthropic') {
    throw modelError(
      'invalid_request',
      'Claude access is OAuth-only — connect a subscription instead of an API key.',
    );
  }
  return CREDENTIALS[name as CredentialName];
}

/** Soft-delete any copy of a credential left behind in a workspace's secrets. */
async function retireWorkspaceCopies(db: Lattice | null, kind: string): Promise<void> {
  if (!db) return;
  for (const row of await liveSecretsOfKind(db, kind)) {
    await db.update('secrets', row.id, { deleted_at: new Date().toISOString() });
  }
}
