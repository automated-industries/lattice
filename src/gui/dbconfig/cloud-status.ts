import { cloudErrorCode } from '../../cloud/errors.js';

/**
 * Translate a cloud capability's failure into an HTTP status.
 *
 * The capabilities themselves never mention a status — they cannot, because the
 * same call has to serve a request, a command line, and a library caller. They
 * raise a tagged reason instead, and this is the one place that decides what
 * each reason means over HTTP, the same way the row primitives' denial and
 * conflict codes are mapped once by the server.
 *
 * Anything untagged is a genuine fault and stays a 500, logged with its stack by
 * the shared handler rather than quietly reported as a client mistake.
 */
export function cloudStatusFor(e: unknown): number {
  switch (cloudErrorCode(e)) {
    case 'invalid_request':
    case 'cloud_required':
    case 'cloud_invite_token':
      return 400;
    case 'cloud_owner_only':
    case 'cloud_managed':
    case 'cloud_invite_rejected':
      return 403;
    case 'cloud_not_lattice':
    case 'cloud_already_secured':
      return 409;
    case 'cloud_unreachable':
      return 502;
    default:
      return 500;
  }
}

/**
 * Call a cloud capability from a route, stamping any failure with the status
 * this transport should answer with.
 *
 * The stamp is what the shared request handler already looks for, so a refusal
 * comes back with the right code and the right message and a real fault still
 * gets logged with its stack. Nothing is swallowed here: every error keeps
 * travelling outward.
 */
export async function cloudCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw Object.assign(e as Error, { statusCode: cloudStatusFor(e) });
  }
}
