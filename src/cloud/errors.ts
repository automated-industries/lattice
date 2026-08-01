/**
 * Failure reasons the cloud capabilities raise, as stable codes.
 *
 * A capability cannot answer with a status: the same call has to work for a
 * request, a command line, and a library caller, and only one of those has a
 * response to write. So it throws an ordinary Error carrying a stable `code`,
 * and whichever adapter invoked it decides what that means on its own transport.
 * This mirrors how the row primitives already report a denial or a conflict.
 *
 * The codes are deliberately few and deliberately named after the SITUATION
 * rather than a number, so a library caller can branch on one without knowing
 * anything about HTTP.
 */

/**
 * Every failure a cloud capability distinguishes. The list is the source of both
 * the type and the runtime check, so the two can never disagree.
 *
 *   invalid_request         the arguments are wrong or incomplete; nothing was attempted
 *   cloud_required          the database is not a Lattice cloud, so this has no meaning
 *   cloud_owner_only        the connected role is a member, and this is owner-only
 *   cloud_managed           a deployment's workspace manager owns membership here
 *   cloud_unreachable       the target database could not be opened at all
 *   cloud_not_lattice       reachable Postgres, but nobody has made it a cloud yet
 *   cloud_already_secured   the target IS already a cloud, and this needed a blank one
 *   cloud_invite_token      the token does not decrypt with this email, or has expired
 *   cloud_invite_rejected   the invite was already used, revoked, or has run out
 *   cloud_coords_unresolved the active connection's coordinates could not be read
 */
const CLOUD_ERROR_CODES = [
  'invalid_request',
  'cloud_required',
  'cloud_owner_only',
  'cloud_managed',
  'cloud_unreachable',
  'cloud_not_lattice',
  'cloud_already_secured',
  'cloud_invite_token',
  'cloud_invite_rejected',
  'cloud_coords_unresolved',
] as const;

export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[number];

/** An Error carrying one of the codes above. */
export type CloudError = Error & { code: CloudErrorCode };

/**
 * Recognising a code has to mean recognising OURS.
 *
 * A database error carries a `code` too — a definer function that refuses a
 * non-owner raises one — and a reader that accepted any string would quietly
 * classify that refusal as a cloud capability's own answer, then report it as
 * whatever status happened to be nearest. An unrecognised failure is a real
 * fault and must read as one.
 */
const KNOWN: ReadonlySet<string> = new Set<string>(CLOUD_ERROR_CODES);

/** Build a tagged cloud failure. Throw it; never return it. */
export function cloudError(code: CloudErrorCode, message: string): CloudError {
  return Object.assign(new Error(message), { code });
}

/**
 * The cloud code on a thrown value, or undefined when it carries none of ours —
 * including when it carries somebody else's.
 */
export function cloudErrorCode(e: unknown): CloudErrorCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !KNOWN.has(code)) return undefined;
  return code as CloudErrorCode;
}
