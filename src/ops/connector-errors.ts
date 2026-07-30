/**
 * Failure reasons the connect-a-source capabilities raise, as stable codes.
 *
 * A capability cannot answer with a status. The same call has to serve a request
 * handler, a command line, and a library caller, and only one of those has a
 * response to write — so it throws an ordinary Error carrying a stable `code`,
 * and whichever adapter invoked it decides what that means on its own transport.
 * This is the shape the cloud, model-configuration, and account capabilities
 * already use.
 *
 * Connecting a source fails in two very different ways and the codes keep them
 * apart, because the difference decides what the caller should DO. A source that
 * refuses the credentials is the caller's to fix and nothing was kept; a setup or
 * import failure happened on our side of the handshake, and whether anything
 * survived it is stated by the code rather than left to be guessed.
 */

/**
 * Every failure a connect-a-source capability distinguishes. One list feeds both
 * the type and the runtime check, so the two cannot disagree.
 *
 *   invalid_request      the arguments are wrong or incomplete; nothing was attempted
 *   unsupported          this source does not connect the way the caller asked
 *   connector_not_found  no such connection, or it belongs to somebody else
 *   source_rejected      the source refused the credentials, or could not be reached
 *   source_unavailable   something this needs is absent — a dependency, a stored URL
 *   setup_failed         the connection was rolled back; nothing at all was kept
 *   import_failed        the connection was KEPT with its error; the first import failed
 */
const CONNECTOR_ERROR_CODES = [
  'invalid_request',
  'unsupported',
  'connector_not_found',
  'source_rejected',
  'source_unavailable',
  'setup_failed',
  'import_failed',
] as const;

export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

/**
 * An Error carrying one of the codes above.
 *
 * `connectorId` is populated on `import_failed` only, and it is the whole point
 * of that code: the connection is still there, in an error state, and the caller
 * needs its id to retry or remove it. Reporting a failure that left something
 * behind without naming what it left would be the silent half of a loud failure.
 */
export type ConnectorError = Error & { code: ConnectorErrorCode; connectorId?: string };

/**
 * Recognising a code has to mean recognising OURS.
 *
 * Plenty of thrown values carry a `code` — a database driver's refusal, a socket
 * error from an unreachable host, which is exactly what this layer provokes — and
 * a reader that accepted any string would classify one of those as a capability's
 * own answer and report it as whatever status happened to be nearest. An
 * unrecognised failure is a real fault and must read as one.
 */
const KNOWN: ReadonlySet<string> = new Set<string>(CONNECTOR_ERROR_CODES);

/** Build a tagged connect-a-source failure. Throw it; never return it. */
export function connectorError(
  code: ConnectorErrorCode,
  message: string,
  connectorId?: string,
): ConnectorError {
  return Object.assign(new Error(message), {
    code,
    ...(connectorId !== undefined ? { connectorId } : {}),
  });
}

/**
 * The connect-a-source code on a thrown value, or undefined when it carries none
 * of ours — including when it carries somebody else's.
 */
export function connectorErrorCode(e: unknown): ConnectorErrorCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !KNOWN.has(code)) return undefined;
  return code as ConnectorErrorCode;
}
