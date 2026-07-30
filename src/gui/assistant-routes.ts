import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { readPreferences, writePreferences } from '../framework/user-config.js';
import { sendJson, readJson } from './http.js';
import { startSubscriptionSignIn, completeSubscriptionSignIn } from '../ops/subscription.js';
import {
  isManagedModelAuth,
  readModelStatus,
  connectModelEndpoint,
  disconnectModelEndpoint,
  connectAccountModel,
  disconnectAccountModel,
  selectModelProvider,
  testModelProvider,
  setAssistantApiKey,
  clearAssistantApiKey,
  disconnectClaudeSubscription,
} from '../ops/ai-config.js';
import { transcribeRecording } from '../ops/voice.js';
import {
  modelErrorCode,
  MANAGED_MODEL_REFUSAL,
  MANAGED_CREDENTIAL_REFUSAL,
  type ModelErrorCode,
} from '../ops/model-errors.js';

/**
 * GUI endpoints for the assistant's model configuration, credentials, and voice
 * transcription. API tokens are stored as encrypted machine-local credentials
 * (with any legacy per-workspace copy retired on write). No endpoint ever returns
 * a stored token — `GET /api/assistant/config` reports presence flags only.
 *
 * Same auth model as the other GUI dev-tool routes: localhost trust; team-cloud
 * mode does not mount this dispatcher.
 *
 * This file is the HTTP adapter ONLY. Reading the configuration and CHANGING it —
 * connecting an endpoint, choosing which backend answers, saving or clearing a
 * key, disconnecting a subscription, transcribing a recording — are capabilities a
 * command line, a background job, or a library caller needs just as much as a
 * browser does. They live in `../ops/ai-config.js` and `../ops/voice.js` and are
 * re-exported below. Nothing outside an adapter should import this file.
 *
 * WHAT IS LEFT HERE, deliberately: reading a request body, shaping a response,
 * and choosing a status code. A capability cannot pick a status — the same call
 * serves a request, a command, and a library caller — so it throws a TAGGED
 * error and {@link statusForModelError} maps the code onto this transport.
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
  clearAssistantApiKey,
  connectAccountModel,
  connectModelEndpoint,
  disconnectAccountModel,
  disconnectClaudeSubscription,
  disconnectModelEndpoint,
  getAggressiveness,
  getAnthropicApiKey,
  getClarifyThreshold,
  getVoiceCredential,
  hasCredential,
  isClaudeConnected,
  isManagedModelAuth,
  liveSecretsOfKind,
  maybeDisconnectExpiredClaude,
  readModelStatus,
  resolveClaudeAuth,
  retireLegacyPreferenceSecrets,
  selectModelProvider,
  setAssistantApiKey,
  testModelProvider,
} from '../ops/ai-config.js';
export type {
  CredentialName,
  VoiceCredential,
  ModelStatus,
  ModelEndpointInput,
  ModelEndpointResult,
} from '../ops/ai-config.js';
export { transcribeRecording } from '../ops/voice.js';

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

/**
 * What a tagged model-configuration failure means over HTTP.
 *
 * The mapping lives in the adapter because it is a fact about this transport and
 * nothing else: the same refusal is an exit code on a command line and a thrown
 * value in a library call. An unrecognised failure is deliberately absent — those
 * are real faults and must not be dressed up as a client mistake.
 */
function statusForModelError(code: ModelErrorCode): number {
  switch (code) {
    case 'managed_model_auth':
      return 403;
    case 'transcription_failed':
      return 502;
    default:
      // invalid_request, provider_not_configured, account_not_signed_in,
      // no_voice_key — the caller asked for something that cannot be done as
      // asked, and the message says what to do instead.
      return 400;
  }
}

/**
 * Answer a tagged failure, or re-throw.
 *
 * Re-throwing an untagged error is the point: it reaches the server's error
 * handler as the fault it is, rather than being reported as a 400 that blames
 * whoever sent the request.
 *
 * @param shape how this route words an error body — the two shapes predate the
 * split and are kept exactly, because clients read both.
 */
function sendModelError(
  res: ServerResponse,
  e: unknown,
  shape: 'error' | 'ok-false' = 'error',
): void {
  const code = modelErrorCode(e);
  if (!code) throw e;
  const message = (e as Error).message;
  const body = shape === 'ok-false' ? { ok: false, error: message } : { error: message };
  sendJson(res, body, statusForModelError(code));
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
    sendJson(res, await readModelStatus(db));
    return true;
  }

  // POST /api/assistant/provider/openai-compat { baseUrl, apiKey, model, headers? } —
  // connect an OpenAI-compatible endpoint (OpenAI / Azure / OpenRouter / a local server /
  // a gateway, or Copilot if the user points it there) as the assistant backend. Stored
  // machine-local + encrypted (like every other assistant credential); saving makes it
  // the active provider. NO provider-specific auth/headers are shipped — the user
  // supplies the base URL, key, model, and any extra headers their endpoint needs.
  // @capability model.connect-endpoint
  if (method === 'POST' && pathname === '/api/assistant/provider/openai-compat') {
    // Refused before the body is even read, as it always has been. The capability
    // refuses independently, so a direct caller is not on the honour system —
    // this is the same answer, given earlier.
    if (isManagedModelAuth()) {
      sendJson(res, { error: MANAGED_MODEL_REFUSAL }, 403);
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    // Untrusted JSON: keep only the string-valued headers, and let the capability
    // judge whether the URL and model are usable.
    const headers =
      body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)
        ? (Object.fromEntries(
            Object.entries(body.headers as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string]),
          ) as Record<string, string>)
        : undefined;
    try {
      // `test: true` (the settings model-edit save) verifies the endpoint actually
      // responds and REVERTS to the prior config if it does not — a bad edit never
      // replaces a working one. The onboarding flow saves WITHOUT `test` and runs
      // POST /api/assistant/test as its own step (so it can send the user back to
      // the setup screen on failure).
      const result = await connectModelEndpoint(db, {
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : '',
        model: typeof body.model === 'string' ? body.model : '',
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
        ...(headers ? { headers } : {}),
        test: body.test === true,
      });
      sendJson(res, result);
    } catch (e) {
      sendModelError(res, e, 'ok-false');
    }
    return true;
  }

  // POST /api/assistant/test — smoke-test the ACTIVE provider so the onboarding "Testing
  // your AI" step (and any runtime re-check) can verify the model actually responds.
  // Always 200; the client branches on `ok`.
  // @capability model.test
  if (method === 'POST' && pathname === '/api/assistant/test') {
    sendJson(res, await testModelProvider(db));
    return true;
  }

  // DELETE /api/assistant/provider/openai-compat — forget the endpoint; the active
  // provider falls back to Anthropic (a connected Claude subscription still works).
  // @capability model.disconnect-endpoint
  if (method === 'DELETE' && pathname === '/api/assistant/provider/openai-compat') {
    sendJson(res, { ok: true, activeProvider: disconnectModelEndpoint() });
    return true;
  }

  // POST /api/assistant/provider/lattice-cloud — activate the signed-in account's
  // Lattice Cloud model: mint a scoped proxy credential from the encrypted identity
  // session and make it the active provider. NO body — the credential is derived
  // from the session, never supplied by the client. Managed deployments own the
  // model credential, so this is refused there (like the openai-compat route).
  // @capability model.connect-account
  if (method === 'POST' && pathname === '/api/assistant/provider/lattice-cloud') {
    try {
      await connectAccountModel();
      sendJson(res, { ok: true, activeProvider: 'lattice_cloud' });
    } catch (e) {
      // Managed refusal keeps its bare `{ error }` shape; "sign in first" keeps
      // its `{ ok: false, error }` one. Both predate the split and clients read
      // them as they are.
      sendModelError(res, e, modelErrorCode(e) === 'managed_model_auth' ? 'error' : 'ok-false');
    }
    return true;
  }

  // DELETE /api/assistant/provider/lattice-cloud — stop using the Lattice Cloud
  // account model; the active provider falls back to Anthropic.
  // @capability model.disconnect-account
  if (method === 'DELETE' && pathname === '/api/assistant/provider/lattice-cloud') {
    sendJson(res, { ok: true, activeProvider: disconnectAccountModel() });
    return true;
  }

  // PUT /api/assistant/provider { provider } — switch which configured backend is
  // active ('anthropic' | 'openai_compat'), without disconnecting the other.
  // @capability model.select
  if (method === 'PUT' && pathname === '/api/assistant/provider') {
    if (isManagedModelAuth()) {
      sendJson(res, { error: MANAGED_MODEL_REFUSAL }, 403);
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    try {
      sendJson(res, {
        ok: true,
        activeProvider: selectModelProvider(typeof body.provider === 'string' ? body.provider : ''),
      });
    } catch (e) {
      sendModelError(res, e);
    }
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
  // @capability model.set-key
  if (method === 'PUT' && pathname === '/api/assistant/key') {
    if (isManagedModelAuth()) {
      sendJson(res, { error: MANAGED_CREDENTIAL_REFUSAL }, 403);
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    try {
      await setAssistantApiKey(
        db,
        typeof body.kind === 'string' ? body.kind : 'anthropic',
        typeof body.key === 'string' ? body.key : '',
      );
      sendJson(res, { ok: true });
    } catch (e) {
      sendModelError(res, e);
    }
    return true;
  }

  // DELETE /api/assistant/key?kind= — clear a credential.
  // @capability model.clear-key
  if (method === 'DELETE' && pathname === '/api/assistant/key') {
    if (isManagedModelAuth()) {
      sendJson(res, { error: MANAGED_CREDENTIAL_REFUSAL }, 403);
      return true;
    }
    const url = new URL(req.url ?? '', 'http://localhost');
    try {
      await clearAssistantApiKey(db, url.searchParams.get('kind') ?? 'anthropic');
      sendJson(res, { ok: true });
    } catch (e) {
      sendModelError(res, e);
    }
    return true;
  }

  // POST /api/assistant/transcribe — raw audio body → text via the configured
  // STT provider. The composer posts the recorded blob with its mime type as
  // Content-Type (no multipart), so we read the raw bytes here.
  // @capability voice.transcribe
  if (method === 'POST' && pathname === '/api/assistant/transcribe') {
    let buf: Buffer;
    try {
      buf = await readBuffer(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    try {
      const text = await transcribeRecording(db, {
        audio: buf,
        mimeType: req.headers['content-type'] ?? 'audio/webm',
      });
      sendJson(res, { text });
    } catch (e) {
      sendModelError(res, e);
    }
    return true;
  }

  // GET /api/assistant/oauth/start — begin the PKCE subscription flow. Opened in
  // a new tab by the GUI; the default (manual) flow shows a code on the provider
  // page that the user pastes back via /oauth/exchange. A loopback callback is
  // only used when an env-pinned client allowlists one.
  //
  // The verifier this attempt turns on is kept in the machine-local store, not in
  // a cookie: a cookie would bind the exchange to this browser and this process,
  // which is exactly what made connecting a subscription impossible from a
  // terminal. Nothing here depends on the client being a browser any more — the
  // desktop webview and the command line take the same URL back.
  // @capability subscription.signin-start
  if (method === 'GET' && pathname === '/api/assistant/oauth/start') {
    let started: ReturnType<typeof startSubscriptionSignIn>;
    try {
      started = startSubscriptionSignIn({ redirectUri: oauthRedirectUri(req) });
    } catch (e) {
      sendModelError(res, e);
      return true;
    }
    // Desktop/webview clients can't open a new tab, so they request this with
    // `Accept: application/json` to get the authorize URL back and open it in the
    // system browser. The default browser path still gets the 302 redirect.
    if ((req.headers.accept ?? '').includes('application/json')) {
      sendJson(res, { authorizeUrl: started.authorizeUrl });
      return true;
    }
    res.writeHead(302, { Location: started.authorizeUrl });
    res.end();
    return true;
  }

  // GET /api/assistant/oauth/callback — exchange the code, store the token.
  // @gui-only interactive-consent: this IS the redirect target a provider sends a browser back
  // to after a human approved a consent screen, so its only possible caller is that redirect.
  // It is a convenience rather than a second mechanism — the same operation without a browser
  // is the paste-a-code path, subscription.signin-complete, which is what this branch calls.
  if (method === 'GET' && pathname === '/api/assistant/oauth/callback') {
    const url = new URL(req.url ?? '', 'http://localhost');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const redirect = (flash: string): void => {
      res.writeHead(302, { Location: `/#/settings/user-config?oauth=${flash}` });
      res.end();
    };
    if (!code || !state) {
      redirect('error');
      return true;
    }
    try {
      // The same `<code>#<state>` shape the paste path uses, so both legs run the
      // one exchange — including its state check against the attempt in progress.
      await completeSubscriptionSignIn(`${code}#${state}`);
      redirect('connected');
    } catch {
      redirect('error');
    }
    return true;
  }

  // POST /api/assistant/oauth/exchange — the code-paste leg. After the user
  // authorizes in the popped tab, the provider shows a code (often
  // `<code>#<state>`); they paste it here and it is redeemed for a token.
  // Body: { code }.
  // @capability subscription.signin-complete
  if (method === 'POST' && pathname === '/api/assistant/oauth/exchange') {
    try {
      const body = await readJson(req);
      await completeSubscriptionSignIn(typeof body.code === 'string' ? body.code : '');
      sendJson(res, { ok: true });
    } catch (e) {
      // The client renders `error` for a refusal, so the shape stays as it was;
      // only the status now comes from the tagged code rather than a fixed 400.
      const code = modelErrorCode(e);
      sendJson(
        res,
        { ok: false, error: (e as Error).message },
        code === undefined ? 400 : statusForModelError(code),
      );
    }
    return true;
  }

  // DELETE /api/assistant/oauth — disconnect the linked Claude subscription.
  // (The OAuth token isn't a named API-key credential, so it's cleared here
  // rather than via /api/assistant/key.)
  // @capability model.disconnect-subscription
  if (method === 'DELETE' && pathname === '/api/assistant/oauth') {
    disconnectClaudeSubscription();
    sendJson(res, { ok: true });
    return true;
  }

  return false;
}
