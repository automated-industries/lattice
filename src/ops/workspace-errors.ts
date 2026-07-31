/**
 * Failure reasons the workspace and database lifecycle capabilities raise, as
 * stable codes.
 *
 * A capability cannot answer with a status. The same call has to serve a request
 * handler, a command line, and a library caller, and only one of those has a
 * response to write — so it throws an ordinary Error carrying a stable `code`,
 * and whichever adapter invoked it decides what that means on its own transport.
 * This is the shape the cloud, ingest, model-configuration, account, and
 * connect-a-source capabilities already use.
 *
 * The codes keep apart the failures that mean different things to a caller. A
 * name that resolves to nothing is a typo; a refusal to remove the LAST database
 * in a set is a deliberate rule, and a caller that wanted to empty a workspace
 * has to be told which of the two happened. Collapsing them into one "delete
 * failed" would leave a script unable to tell a mistake from a policy.
 *
 * Deliberately NOT here: the filesystem faults underneath a delete. An unlink
 * that fails, or a credential purge that cannot confirm it removed anything, is
 * a real fault and must read as one rather than as an answer this layer chose.
 */

/**
 * Every failure a workspace or database lifecycle capability distinguishes. One
 * list feeds both the type and the runtime check, so the two cannot disagree.
 *
 *   invalid_request  the arguments are wrong or incomplete; nothing was attempted
 *   not_found        the workspace or database named is not one of this set
 *   last_database    the target is the only database left, and a workspace keeps one
 */
const WORKSPACE_ERROR_CODES = ['invalid_request', 'not_found', 'last_database'] as const;

export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];

/** An Error carrying one of the codes above. */
export type WorkspaceError = Error & { code: WorkspaceErrorCode };

/**
 * Recognising a code has to mean recognising OURS.
 *
 * This layer provokes filesystem errors constantly, and every one of them
 * carries a `code` too (`ENOENT`, `EBUSY`, `EPERM`). A reader that accepted any
 * string would classify a failed unlink as a deliberate refusal and report it as
 * whatever status happened to be nearest — turning a half-deleted workspace into
 * a cheerful "not found". An unrecognised failure is a real fault and must read
 * as one.
 */
const KNOWN: ReadonlySet<string> = new Set<string>(WORKSPACE_ERROR_CODES);

/** Build a tagged workspace-lifecycle failure. Throw it; never return it. */
export function workspaceError(code: WorkspaceErrorCode, message: string): WorkspaceError {
  return Object.assign(new Error(message), { code });
}

/**
 * The workspace-lifecycle code on a thrown value, or undefined when it carries
 * none of ours — including when it carries somebody else's.
 */
export function workspaceErrorCode(e: unknown): WorkspaceErrorCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !KNOWN.has(code)) return undefined;
  return code as WorkspaceErrorCode;
}
