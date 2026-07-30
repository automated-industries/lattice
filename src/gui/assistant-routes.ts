import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { transcribe } from './ai/transcribe.js';
import { voiceModeFromConfig, type VoiceMode } from './ai/voice-mode.js';
import { getClaudeLimitState } from './ai/limit-state.js';
import { clearClaudeAuthWarning, getClaudeAuthWarning } from './ai/auth-warn-state.js';
import {
  readOAuthConfig,
  oauthConfigured,
  generatePkceVerifier,
  pkceChallengeFor,
  generateState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
} from './ai/oauth.js';
import {
  setAssistantCredential,
  deleteAssistantCredential,
  setAssistantCredentialCleared,
  clearAssistantCredentialCleared,
  readPreferences,
  writePreferences,
} from '../framework/user-config.js';
import { sendJson, readJson } from './http.js';
import { isManagedWorkspaces } from './identity/managed.js';
import {
  readOpenAiCompatConfig,
  setOpenAiCompatConfig,
  clearOpenAiCompatConfig,
  readLatticeCloudConfig,
  clearLatticeCloudConfig,
  setActiveProvider,
  activeProviderKind,
} from './ai/provider-config.js';
import { refreshLatticeCloudCredential } from './identity/model.js';
import {
  CLAUDE_OAUTH_KIND,
  CREDENTIALS,
  claudeAuthKind,
  getAggressiveness,
  getClarifyThreshold,
  getVoiceCredential,
  hasCredential,
  isClaudeConnected,
  isManagedModelAuth,
  liveSecretsOfKind,
  type CredentialName,
} from '../ops/ai-config.js';

/**
 * GUI endpoints for the assistant's credentials + voice transcription. API
 * tokens are stored as rows in the native `secrets` entity, whose `value`
 * column is encrypted at rest by the framework. No endpoint ever returns a
 * stored token — `GET /api/assistant/config` reports presence flags only.
 *
 * Same auth model as the other GUI dev-tool routes: localhost trust;
 * team-cloud mode does not mount this dispatcher.
 *
 * This file is the HTTP adapter ONLY. Credential resolution, the connected
 * check, the clarify threshold and the rest of the assistant's configuration
 * are a capability that a background job or a command-line caller needs just as
 * much as a browser does, so they live in `../ops/ai-config.js` and are
 * re-exported below. Nothing outside an adapter should import this file.
 */

// Re-exported so callers written before the capability moved keep working
// unchanged. New code should import from `../ops/ai-config.js` directly.
export {
  ANTHROPIC_KEY_KIND,
  CLAUDE_OAUTH_KIND,
  CREDENTIALS,
  DEFAULT_AGGRESSIVENESS,
  DEFAULT_CLARIFY_THRESHOLD,
  aggressivenessToTemperature,
  claudeAuthKind,
  clarifyFloor,
  getAggressiveness,
  getAnthropicApiKey,
  getClarifyThreshold,
  getVoiceCredential,
  hasCredential,
  isClaudeConnected,
  isManagedModelAuth,
  liveSecretsOfKind,
  maybeDisconnectExpiredClaude,
  resolveClaudeAuth,
  retireLegacyPreferenceSecrets,
} from '../ops/ai-config.js';
export type { CredentialName, VoiceCredential } from '../ops/ai-config.js';

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
    const sttPreference = readPreferences().voice_provider;
    // On-device dictation is the keyless default — the mic is no longer gated on a
    // cloud voice key. `voiceMode` is the single signal the GUI acts on: 'local'
    // (on-device, keyless), a cloud provider (when its key is set), or 'off' (the
    // legacy "No Voice" sentinel). A configured cloud key still drives the cloud
    // transcribe fallback (POST /api/assistant/transcribe).
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
        // Bounded on purpose: this response now decides whether the app boots at
        // all, and it is fetched from a remote proxy. An unbounded wait on a
        // wedged proxy would hang the boot gate itself with nothing on screen; a
        // timeout instead yields "balance unknown", which is reported as such and
        // deliberately does NOT lock the user out.
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
    // We asked for a balance and got no number back. The GUI must say "unavailable"
    // instead of formatting the null as $0.00 — "we could not read your balance" and
    // "you are out of tokens" are different facts and lead to different actions.
    const balanceUnavailable = balanceProbed && balanceCents === null;
    // A cloud account with nothing left to spend is NOT a usable backend: every turn
    // would be refused by the proxy. Treating it as connected boots the app into a
    // state where all AI work fails, so it counts as not-connected and the client
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
    sendJson(res, {
      hasAnthropicKey,
      hasOpenaiKey,
      hasElevenlabsKey,
      claudeAuthKind: await claudeAuthKind(db),
      // Which backend answers turns, and the OpenAI-compatible endpoint's non-secret
      // config (so the GUI can show "Connected to gpt-4o at api.example.com").
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
      // Why `connected` is false when a backend IS configured, so the client can
      // offer the specific way out instead of a generic "connect something".
      // 'cloud_balance_exhausted' = signed in, no tokens left → top up (or switch).
      modelAccessBlocked:
        !connected && cloudBalanceExhausted ? ('cloud_balance_exhausted' as const) : null,
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
      // True when a balance was asked for and none came back. The GUI says so
      // rather than rendering the null as a zero.
      balanceUnavailable,
      topUpUrl,
    });
    return true;
  }

  // POST /api/assistant/provider/openai-compat { baseUrl, apiKey, model, headers? } —
  // connect an OpenAI-compatible endpoint (OpenAI / Azure / OpenRouter / a local server /
  // a gateway, or Copilot if the user points it there) as the assistant backend. Stored
  // machine-local + encrypted (like every other assistant credential); saving makes it
  // the active provider. NO provider-specific auth/headers are shipped — the user
  // supplies the base URL, key, model, and any extra headers their endpoint needs.
  // @headless-debt configuring an OpenAI-compatible provider writes the machine-local
  // assistant config, which is not on the library surface.
  if (method === 'POST' && pathname === '/api/assistant/provider/openai-compat') {
    // Managed deployment: the operator owns the model credential; a user must not
    // point the assistant at their own backend (see resolveLlmProvider's managed gate).
    if (isManagedModelAuth()) {
      sendJson(res, { error: 'The model backend is managed by the operator.' }, 403);
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const rawKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!/^https?:\/\/\S+$/i.test(baseUrl)) {
      sendJson(res, { ok: false, error: 'baseUrl must be an http(s) URL' }, 400);
      return true;
    }
    if (!model) {
      sendJson(res, { ok: false, error: 'model is required' }, 400);
      return true;
    }
    const headers =
      body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)
        ? (Object.fromEntries(
            Object.entries(body.headers as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string]),
          ) as Record<string, string>)
        : undefined;
    const prior = readOpenAiCompatConfig();
    // On a settings EDIT a blank key means "keep the current key" (the key is never
    // shown back, so an empty field is not a request to clear it); on first connect there
    // is no prior, so a blank key = a keyless local server.
    const apiKey = rawKey === '' && prior ? prior.apiKey : rawKey;
    setOpenAiCompatConfig({ baseUrl, apiKey, model, ...(headers ? { headers } : {}) });
    // `test: true` (the settings model-edit save) verifies the endpoint actually responds
    // and REVERTS to the prior config if it does not — a bad edit never replaces a working
    // one. The onboarding flow saves WITHOUT `test` and runs POST /api/assistant/test as
    // its own step (so it can send the user back to the setup screen on failure).
    if (body.test === true) {
      const { resolveLlmProvider, smokeTestProvider } = await import('./ai/provider.js');
      const provider = await resolveLlmProvider(db);
      const result = provider
        ? await smokeTestProvider(provider)
        : { ok: false as const, error: 'Could not resolve the model provider.' };
      if (!result.ok) {
        if (prior) setOpenAiCompatConfig(prior);
        else clearOpenAiCompatConfig();
        sendJson(res, { ok: false, error: result.error });
        return true;
      }
    }
    sendJson(res, { ok: true, activeProvider: 'openai_compat', model, baseUrl });
    return true;
  }

  // POST /api/assistant/test — smoke-test the ACTIVE provider so the onboarding "Testing
  // your AI" step (and any runtime re-check) can verify the model actually responds.
  // Always 200; the client branches on `ok`.
  // @headless-debt smoke-testing the configured model provider is only reachable here.
  if (method === 'POST' && pathname === '/api/assistant/test') {
    const { resolveLlmProvider, smokeTestProvider } = await import('./ai/provider.js');
    const provider = await resolveLlmProvider(db);
    if (!provider) {
      sendJson(res, { ok: false, error: 'No model provider is configured.' });
      return true;
    }
    sendJson(res, await smokeTestProvider(provider));
    return true;
  }

  // DELETE /api/assistant/provider/openai-compat — forget the endpoint; the active
  // provider falls back to Anthropic (a connected Claude subscription still works).
  // @headless-debt clearing the OpenAI-compatible provider config is only reachable here.
  if (method === 'DELETE' && pathname === '/api/assistant/provider/openai-compat') {
    clearOpenAiCompatConfig();
    sendJson(res, { ok: true, activeProvider: 'anthropic' });
    return true;
  }

  // POST /api/assistant/provider/lattice-cloud — activate the signed-in account's
  // Lattice Cloud model: mint a scoped proxy credential from the encrypted identity
  // session and make it the active provider. NO body — the credential is derived
  // from the session, never supplied by the client. Managed deployments own the
  // model credential, so this is refused there (like the openai-compat route).
  // @headless-debt minting the hosted-account model credential is only reachable here.
  if (method === 'POST' && pathname === '/api/assistant/provider/lattice-cloud') {
    if (isManagedModelAuth()) {
      sendJson(res, { error: 'The model backend is managed by the operator.' }, 403);
      return true;
    }
    const cfg = await refreshLatticeCloudCredential();
    if (!cfg) {
      sendJson(res, { ok: false, error: 'Sign in with your Lattice Cloud account first.' }, 400);
      return true;
    }
    sendJson(res, { ok: true, activeProvider: 'lattice_cloud' });
    return true;
  }

  // DELETE /api/assistant/provider/lattice-cloud — stop using the Lattice Cloud
  // account model; the active provider falls back to Anthropic.
  // @headless-debt clearing the hosted-account model credential is only reachable here.
  if (method === 'DELETE' && pathname === '/api/assistant/provider/lattice-cloud') {
    clearLatticeCloudConfig();
    sendJson(res, { ok: true, activeProvider: 'anthropic' });
    return true;
  }

  // PUT /api/assistant/provider { provider } — switch which configured backend is
  // active ('anthropic' | 'openai_compat'), without disconnecting the other.
  // @headless-debt choosing which configured provider is active is only reachable here.
  if (method === 'PUT' && pathname === '/api/assistant/provider') {
    if (isManagedModelAuth()) {
      sendJson(res, { error: 'The model backend is managed by the operator.' }, 403);
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    const provider = body.provider;
    if (provider !== 'anthropic' && provider !== 'openai_compat') {
      sendJson(res, { error: "provider must be 'anthropic' or 'openai_compat'" }, 400);
      return true;
    }
    // Don't let the user select a provider that isn't configured — that would strand
    // the assistant on a backend that resolves to nothing.
    if (provider === 'openai_compat' && !readOpenAiCompatConfig()) {
      sendJson(res, { error: 'no OpenAI-compatible endpoint is configured' }, 400);
      return true;
    }
    setActiveProvider(provider);
    sendJson(res, { ok: true, activeProvider: provider });
    return true;
  }

  // PUT /api/assistant/aggressiveness { value } — inference aggressiveness 0..1.
  // @capability user.preferences
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

  // PUT /api/assistant/clarify-threshold { value } — clarify threshold 0..1
  // (see getClarifyThreshold). Mirrors the aggressiveness route above.
  // @capability user.preferences
  if (method === 'PUT' && pathname === '/api/assistant/clarify-threshold') {
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
    writePreferences({ ...readPreferences(), clarify_threshold: value });
    sendJson(res, { ok: true, value });
    return true;
  }

  // PUT /api/assistant/stt-provider { provider } — explicit voice provider choice.
  // @capability user.preferences
  if (method === 'PUT' && pathname === '/api/assistant/stt-provider') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    const provider = typeof body.provider === 'string' ? body.provider : 'local';
    if (
      provider !== 'local' &&
      provider !== 'auto' &&
      provider !== 'openai' &&
      provider !== 'elevenlabs'
    ) {
      sendJson(res, { error: `unknown provider: ${provider}` }, 400);
      return true;
    }
    // User preference, machine-local — not a workspace secret.
    writePreferences({ ...readPreferences(), voice_provider: provider });
    sendJson(res, { ok: true });
    return true;
  }

  // PUT /api/assistant/key { kind?, key } — set / replace a credential.
  // @headless-debt storing the assistant API key encrypts it into the secrets table through
  // a helper that is not on the library surface.
  if (method === 'PUT' && pathname === '/api/assistant/key') {
    if (isManagedModelAuth()) {
      sendJson(
        res,
        { error: 'Model access is managed by the host; per-user credentials are disabled.' },
        403,
      );
      return true;
    }
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
    if (name === 'anthropic') {
      // Claude access is OAuth-only — a per-user API key is no longer accepted.
      sendJson(
        res,
        { error: 'Claude access is OAuth-only — connect a subscription instead of an API key.' },
        400,
      );
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
  // @headless-debt deleting the stored assistant API key is only reachable here.
  if (method === 'DELETE' && pathname === '/api/assistant/key') {
    if (isManagedModelAuth()) {
      sendJson(
        res,
        { error: 'Model access is managed by the host; per-user credentials are disabled.' },
        403,
      );
      return true;
    }
    const url = new URL(req.url ?? '', 'http://localhost');
    const name = (url.searchParams.get('kind') ?? 'anthropic') as CredentialName;
    if (!(name in CREDENTIALS)) {
      sendJson(res, { error: `unknown credential kind: ${name}` }, 400);
      return true;
    }
    if (name === 'anthropic') {
      // Claude access is OAuth-only — there is no per-user API key to clear.
      sendJson(
        res,
        { error: 'Claude access is OAuth-only — connect a subscription instead of an API key.' },
        400,
      );
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
  // @headless-debt speech-to-text over an uploaded recording is a real capability, but the
  // transcription call is only reachable through this route.
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
    if (isManagedModelAuth()) {
      sendJson(
        res,
        { error: 'Model access is managed by the host; connecting a subscription is disabled.' },
        403,
      );
      return true;
    }
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
  // @gui-only interactive-consent: this IS the redirect target a provider sends a browser back
  // to after a human approved a consent screen, and the code it carries is only exchangeable
  // with the verifier held in the cookie the authorize step set on that browser. There is
  // nothing to receive, and no verifier to receive it with, outside that round trip.
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
      // Successful reconnect clears any prior auth warning.
      clearClaudeAuthWarning();
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
  // @gui-only interactive-consent: completes a browser consent redirect, exchanging the
  // returned code using the verifier held in the session cookie the authorize step set.
  // There is no code to exchange unless a human approved a consent screen in a browser.
  if (method === 'POST' && pathname === '/api/assistant/oauth/exchange') {
    if (isManagedModelAuth()) {
      sendJson(
        res,
        { error: 'Model access is managed by the host; connecting a subscription is disabled.' },
        403,
      );
      return true;
    }
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
      // Distinguish the two failure modes — they were conflated into one
      // misleading "paste the full code" message. A missing verifier cookie
      // means the flow itself is gone (never started here, expired after 10 min,
      // or the app restarted between authorizing and pasting), which re-pasting
      // the same code can't fix; a missing code is an actually-empty paste.
      if (!verifier) {
        sendJson(
          res,
          {
            ok: false,
            error:
              'This connection attempt expired or was interrupted — click "Connect with Claude" again to get a fresh code, then paste it right away.',
          },
          400,
        );
        return true;
      }
      if (!code) {
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
      // Successful reconnect clears any prior auth warning.
      clearClaudeAuthWarning();
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
  // @headless-debt disconnecting the stored subscription credential is only reachable here.
  if (method === 'DELETE' && pathname === '/api/assistant/oauth') {
    deleteAssistantCredential(CLAUDE_OAUTH_KIND);
    // Disconnecting clears any auth warning since the subscription no longer exists.
    clearClaudeAuthWarning();
    sendJson(res, { ok: true });
    return true;
  }

  return false;
}
