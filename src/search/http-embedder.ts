/**
 * An embedding function that calls an HTTP embeddings endpoint.
 *
 * Lattice never bundles an embedding model — a library caller passes its own
 * `embed` function. A config file cannot express a function, so a config-declared
 * table needs a way to name an endpoint instead. This builds that function from
 * the endpoint's address, the model name, and (optionally) the environment
 * variable holding the key.
 *
 * The request/response shape is the one every hosted and local embedding server
 * speaks: `POST { model, input }`, answered with a vector. Three response shapes
 * are accepted because servers differ on the wrapper, not on the vector:
 *
 *   { "data": [ { "embedding": [...] } ] }   { "embedding": [...] }   { "embeddings": [[...]] }
 *
 * Everything that can go wrong throws with the reason: a missing key variable, a
 * non-2xx status, a body with no vector in it, a vector containing a value that
 * is not a finite number. An embedding that is silently empty or partly garbage
 * poisons a vector index and produces wrong search results forever after, so
 * none of those cases returns a value.
 */

/** How to reach an embeddings endpoint. */
export interface HttpEmbedderOptions {
  /** Absolute `http`/`https` URL of the embeddings endpoint. */
  url: string;
  /** Model name sent with every request. */
  model: string;
  /**
   * Name of the environment variable holding the API key, sent as a bearer
   * token. Omit for an endpoint that needs no key (a local model server). The
   * key itself is never part of this configuration — only the variable's name.
   */
  apiKeyEnv?: string;
  /** Abort a request that takes longer than this. Default 30000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Pull the vector out of whichever wrapper the server used. */
function extractVector(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const body = payload as Record<string, unknown>;
  if (Array.isArray(body.data)) {
    const first: unknown = (body.data as unknown[])[0];
    if (typeof first === 'object' && first !== null) {
      return (first as Record<string, unknown>).embedding;
    }
    return undefined;
  }
  if (Array.isArray(body.embeddings)) return (body.embeddings as unknown[])[0];
  return body.embedding;
}

/**
 * Build an embedding function that posts text to `url` and returns the vector.
 *
 * @throws When the endpoint is unreachable, answers non-2xx, needs a key whose
 *         environment variable is unset, or returns anything other than a
 *         non-empty vector of finite numbers.
 */
export function createHttpEmbedder(opts: HttpEmbedderOptions): (text: string) => Promise<number[]> {
  const { url, model, apiKeyEnv } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (text: string): Promise<number[]> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKeyEnv !== undefined) {
      const key = process.env[apiKeyEnv];
      if (key === undefined || key.trim().length === 0) {
        // Fail before the request rather than sending an unauthenticated one and
        // reporting whatever the server says about it.
        throw new Error(
          `Lattice: cannot embed — the embeddings endpoint needs a key from ${apiKeyEnv}, and that environment variable is not set.`,
        );
      }
      headers.authorization = `Bearer ${key}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`Lattice: embeddings request to ${url} failed: ${(e as Error).message}`);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(
        `Lattice: embeddings endpoint ${url} returned ${String(res.status)}${detail ? ` — ${detail}` : ''}`,
      );
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (e) {
      throw new Error(
        `Lattice: embeddings endpoint ${url} returned a body that is not JSON: ${(e as Error).message}`,
      );
    }

    const vector = extractVector(payload);
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(
        `Lattice: embeddings endpoint ${url} returned no embedding for model "${model}".`,
      );
    }
    const numbers = vector.map((v) => (typeof v === 'number' ? v : Number.NaN));
    if (numbers.some((v) => !Number.isFinite(v))) {
      throw new Error(
        `Lattice: embeddings endpoint ${url} returned an embedding containing a value that is not a finite number.`,
      );
    }
    return numbers;
  };
}
