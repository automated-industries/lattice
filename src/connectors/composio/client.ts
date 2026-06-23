/**
 * The single seam coupling Lattice to Composio.
 *
 * The rest of the connector layer programs against the small {@link ComposioClient}
 * interface, never against `@composio/core` directly. `loadComposioClient` is the
 * only place that imports the optional dependency and adapts the installed SDK to
 * this interface — so if a Composio SDK method is renamed, only this file changes,
 * and the adapter/sync logic stays testable by injecting a fake client.
 *
 * `@composio/core` is an OPTIONAL dependency. A library consumer that never uses
 * connectors does not need it installed; calling a connector without it throws a
 * clear, actionable error rather than a module-not-found at import time.
 */

import {
  getAssistantCredential,
  setAssistantCredential,
  deleteAssistantCredential,
} from '../../framework/user-config.js';

/** Credential kind for the workspace-level Composio API key (machine-local, encrypted). */
const COMPOSIO_API_KEY_KIND = 'composio_api_key';

/** Read the configured Composio API key (machine-local store, then env). */
export function getComposioApiKey(): string | null {
  return getAssistantCredential(COMPOSIO_API_KEY_KIND) ?? process.env.COMPOSIO_API_KEY ?? null;
}

/** Persist the Composio API key to the machine-local encrypted store. */
export function setComposioApiKey(value: string): void {
  setAssistantCredential(COMPOSIO_API_KEY_KIND, value);
}

/** Remove the stored Composio API key. */
export function clearComposioApiKey(): void {
  deleteAssistantCredential(COMPOSIO_API_KEY_KIND);
}

/** A raw response from executing a Composio tool/action. */
export interface ComposioActionResult {
  /** The action's payload (shape is action-specific). */
  data: unknown;
  /** Whether the action succeeded. */
  successful: boolean;
  /** Error message when not successful. */
  error?: string;
}

/**
 * The minimal Composio surface the connector layer depends on. Intentionally
 * tiny and backend-neutral; {@link loadComposioClient} adapts the real SDK to it.
 */
export interface ComposioClient {
  /** Begin OAuth for a member + toolkit; returns a redirect URL (+ pending id). */
  authorize(userId: string, toolkit: string): Promise<{ redirectUrl: string; pendingId?: string }>;
  /** Finalize/look up the member's connected account for a toolkit. */
  finalize(userId: string, toolkit: string): Promise<{ connectionId: string }>;
  /** Execute one toolkit action for a member and return its raw result. */
  execute(
    slug: string,
    input: { userId: string; connectionId?: string; arguments?: Record<string, unknown> },
  ): Promise<ComposioActionResult>;
  /** Revoke a connected account. */
  revoke(connectionId: string): Promise<void>;
}

/** Thrown when a connector is used but its prerequisites are missing. */
export class ConnectorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorUnavailableError';
  }
}

/**
 * The subset of `@composio/core`'s runtime shape we adapt. Declared locally (not
 * imported) so the optional dependency is never a compile-time requirement.
 *
 * NOTE: verify these names against the installed `@composio/core` version before
 * release — they are the documented v3 surface (client + per-user tools/auth) but
 * are the one part of this feature that cannot be checked without the package +
 * a live key. Only this adapter changes if a name differs.
 */
interface ComposioSdkModule {
  Composio: new (opts: { apiKey: string }) => ComposioSdkInstance;
}
interface ComposioSdkInstance {
  toolkits: {
    authorize(userId: string, toolkit: string): Promise<{ redirectUrl: string; id?: string }>;
  };
  connectedAccounts: {
    list(query: {
      userIds?: string[];
      toolkitSlugs?: string[];
    }): Promise<{ items: { id: string }[] }>;
    delete(id: string): Promise<void>;
  };
  tools: {
    execute(
      slug: string,
      body: { userId: string; connectedAccountId?: string; arguments?: Record<string, unknown> },
    ): Promise<{ data?: unknown; successful?: boolean; error?: string }>;
  };
}

let cachedModule: ComposioSdkModule | null = null;

async function importComposio(): Promise<ComposioSdkModule> {
  if (cachedModule) return cachedModule;
  try {
    // Optional dependency — dynamic import with a non-literal specifier so TypeScript
    // does NOT statically resolve it (the package need not be installed to compile
    // latticesql; only consumers using connectors install it).
    const specifier = '@composio/core';
    cachedModule = (await import(specifier as string)) as unknown as ComposioSdkModule;
    return cachedModule;
  } catch {
    throw new ConnectorUnavailableError(
      'The Composio connector requires the optional dependency "@composio/core". ' +
        'Install it with `npm install @composio/core` to use connectors.',
    );
  }
}

/**
 * Build a {@link ComposioClient} from the installed SDK + the configured API key.
 * Throws {@link ConnectorUnavailableError} if the dependency or the key is absent.
 */
export async function loadComposioClient(): Promise<ComposioClient> {
  const apiKey = getComposioApiKey();
  if (!apiKey) {
    throw new ConnectorUnavailableError(
      'No Composio API key configured. Set it on the Connectors settings page ' +
        '(or the COMPOSIO_API_KEY environment variable) before using a connector.',
    );
  }
  const mod = await importComposio();
  const sdk = new mod.Composio({ apiKey });

  return {
    async authorize(userId, toolkit) {
      const res = await sdk.toolkits.authorize(userId, toolkit);
      const out: { redirectUrl: string; pendingId?: string } = { redirectUrl: res.redirectUrl };
      if (res.id !== undefined) out.pendingId = res.id;
      return out;
    },
    async finalize(userId, toolkit) {
      const { items } = await sdk.connectedAccounts.list({
        userIds: [userId],
        toolkitSlugs: [toolkit],
      });
      const account = items[0];
      if (!account) {
        throw new ConnectorUnavailableError(
          `No connected ${toolkit} account found for this user — complete the OAuth flow first.`,
        );
      }
      return { connectionId: account.id };
    },
    async execute(slug, input) {
      const body: {
        userId: string;
        connectedAccountId?: string;
        arguments?: Record<string, unknown>;
      } = {
        userId: input.userId,
      };
      if (input.connectionId !== undefined) body.connectedAccountId = input.connectionId;
      if (input.arguments !== undefined) body.arguments = input.arguments;
      const res = await sdk.tools.execute(slug, body);
      const result: ComposioActionResult = {
        data: res.data ?? null,
        successful: res.successful ?? false,
      };
      if (res.error !== undefined) result.error = res.error;
      return result;
    },
    async revoke(connectionId) {
      await sdk.connectedAccounts.delete(connectionId);
    },
  };
}
