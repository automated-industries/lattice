/**
 * Failure reasons the ingest and source-root capabilities raise, as stable codes.
 *
 * A capability cannot answer with a status. The same call has to serve a request
 * handler, a command line, and a library caller, and only one of those has a
 * response to write — so it throws an ordinary Error carrying a stable `code`,
 * and whichever adapter invoked it decides what that means on its own transport.
 * This is the shape the cloud, model-configuration, account, and connect-a-source
 * capabilities already use.
 *
 * The codes keep apart the failures that mean different things to a caller. A
 * path that names nothing is the caller's typo; a path that escapes every
 * registered root is a refusal on purpose; a file over the cap was never read at
 * all; a web address that would not answer is somebody else's outage. Collapsing
 * those into one "ingest failed" would leave every caller guessing which of them
 * happened, and a script cannot retry what it cannot tell apart.
 */

/**
 * Every failure an ingest capability distinguishes. One list feeds both the type
 * and the runtime check, so the two cannot disagree.
 *
 *   invalid_request       the arguments are wrong or incomplete; nothing was attempted
 *   not_found             the path or file named does not exist
 *   too_large             the source is over the ingest cap; it was never read
 *   outside_roots         the path escapes every registered source root
 *   local_files_disabled  reading this machine's filesystem is switched off here
 *   source_unreachable    a web address could not be fetched or yielded no readable text
 */
const INGEST_ERROR_CODES = [
  'invalid_request',
  'not_found',
  'too_large',
  'outside_roots',
  'local_files_disabled',
  'source_unreachable',
] as const;

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

/** An Error carrying one of the codes above. */
export type IngestError = Error & { code: IngestErrorCode };

/**
 * Recognising a code has to mean recognising OURS.
 *
 * Plenty of thrown values carry a `code` — a filesystem refusal (`ENOENT`), a
 * socket error from an unreachable host, which is exactly what this layer
 * provokes — and a reader that accepted any string would classify one of those as
 * a capability's own answer and report it as whatever status happened to be
 * nearest. An unrecognised failure is a real fault and must read as one.
 */
const KNOWN: ReadonlySet<string> = new Set<string>(INGEST_ERROR_CODES);

/** Build a tagged ingest failure. Throw it; never return it. */
export function ingestError(code: IngestErrorCode, message: string): IngestError {
  return Object.assign(new Error(message), { code });
}

/**
 * The ingest code on a thrown value, or undefined when it carries none of ours —
 * including when it carries somebody else's.
 */
export function ingestErrorCode(e: unknown): IngestErrorCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !KNOWN.has(code)) return undefined;
  return code as IngestErrorCode;
}
