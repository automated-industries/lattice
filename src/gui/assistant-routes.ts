import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';

/**
 * GUI endpoints for the assistant's credentials. The Claude API token is
 * stored as a row in the native `secrets` entity (`kind='anthropic_api_key'`),
 * whose `value` column is encrypted at rest by the framework. No endpoint ever
 * returns the stored token — `GET /api/assistant/config` reports only whether
 * one is present.
 *
 * Same auth model as the other GUI dev-tool routes: localhost trust;
 * team-cloud mode does not mount this dispatcher.
 */

/** `secrets.kind` value under which the Claude API token is stored. */
export const ANTHROPIC_KEY_KIND = 'anthropic_api_key';
const ANTHROPIC_KEY_NAME = 'Claude API token';

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

/** Live (non-deleted) secret rows for a given kind. */
async function liveSecretsOfKind(db: Lattice, kind: string): Promise<SecretRow[]> {
  const rows = (await db.query('secrets', {
    filters: [{ col: 'kind', op: 'eq', val: kind }],
  })) as unknown as SecretRow[];
  return rows.filter((r) => !r.deleted_at);
}

/**
 * Resolve the Claude API token server-side. Prefers the encrypted `secrets`
 * row (set via the Assistant settings panel); falls back to the
 * `ANTHROPIC_API_KEY` environment variable. Returns null when neither is set.
 * Server-side only — never exposed through an endpoint.
 */
export async function getAnthropicApiKey(db: Lattice): Promise<string | null> {
  const rows = await liveSecretsOfKind(db, ANTHROPIC_KEY_KIND);
  // The framework decrypts the `value` column on read.
  const fromDb = rows.find((r) => typeof r.value === 'string' && r.value.length > 0)?.value;
  if (fromDb) return fromDb;
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

/**
 * Dispatch `/api/assistant/*`. Returns true when it handled the request.
 */
export async function dispatchAssistantRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AssistantContext,
): Promise<boolean> {
  const { db, pathname, method } = ctx;

  // GET /api/assistant/config — presence flags only, never values.
  if (method === 'GET' && pathname === '/api/assistant/config') {
    const hasAnthropicKey =
      (await liveSecretsOfKind(db, ANTHROPIC_KEY_KIND)).some(
        (r) => typeof r.value === 'string' && r.value.length > 0,
      ) || Boolean(process.env.ANTHROPIC_API_KEY);
    sendJson(res, { hasAnthropicKey });
    return true;
  }

  // PUT /api/assistant/key — set / replace the Claude API token.
  if (method === 'PUT' && pathname === '/api/assistant/key') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
      return true;
    }
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key) {
      sendJson(res, { error: 'key is required' }, 400);
      return true;
    }
    const [first, ...extras] = await liveSecretsOfKind(db, ANTHROPIC_KEY_KIND);
    if (first) {
      // Update the first live row; soft-delete any extras to keep one binding.
      await db.update('secrets', first.id, { value: key, name: ANTHROPIC_KEY_NAME });
      for (const extra of extras) {
        await db.update('secrets', extra.id, { deleted_at: new Date().toISOString() });
      }
    } else {
      await db.insert('secrets', {
        id: crypto.randomUUID(),
        name: ANTHROPIC_KEY_NAME,
        kind: ANTHROPIC_KEY_KIND,
        value: key,
        description: 'Claude API token used by the assistant sidebar.',
      });
    }
    sendJson(res, { ok: true, hasAnthropicKey: true });
    return true;
  }

  // DELETE /api/assistant/key — clear the stored token.
  if (method === 'DELETE' && pathname === '/api/assistant/key') {
    const existing = await liveSecretsOfKind(db, ANTHROPIC_KEY_KIND);
    for (const row of existing) {
      await db.update('secrets', row.id, { deleted_at: new Date().toISOString() });
    }
    sendJson(res, { ok: true, hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY) });
    return true;
  }

  return false;
}
