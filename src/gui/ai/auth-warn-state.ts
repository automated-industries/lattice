/**
 * Claude OAuth auth-warning state — a per-process singleton (GUI session; never
 * persisted to the shared DB). When a Claude OAuth token refresh fails TERMINALLY
 * (refresh token expired/revoked/not found), we flip this on so the chat rail can
 * show a reconnect notice before the user discovers the problem mid-conversation
 * (when the access token finally expires).
 *
 * This is the exact analog of {@link getClaudeLimitState} in limit-state.ts —
 * a transient in-memory signal tied to the client session, not the workspace or
 * user account.
 *
 * Terminal vs. transient: a 400 response with OAuth error code `invalid_grant`
 * means the refresh token is dead (expired, revoked, not found). Everything else
 * (network error, 5xx, socket timeout) is transient and does NOT set the warning —
 * the current access token may still be valid and the user may keep chatting.
 */

export interface ClaudeAuthWarning {
  kind: 'reconnect_required';
  message: string;
}

let current: ClaudeAuthWarning | null = null;

/**
 * Set the auth warning when a terminal OAuth failure is detected (invalid_grant).
 * Called from resolveClaudeAuth when token refresh fails with a structured OAuth error.
 */
export function setClaudeAuthWarning(): void {
  current = {
    kind: 'reconnect_required',
    message:
      'Your Claude sign-in has expired. Chat will stop working soon — reconnect your account to keep going.',
  };
}

/** The active auth-warning state, or null. Never auto-clears (the user must reconnect). */
export function getClaudeAuthWarning(): ClaudeAuthWarning | null {
  return current;
}

/**
 * Clear the auth warning. Called when:
 * - A successful token refresh happens (current token is valid after all)
 * - The user reconnects (new OAuth credential is written)
 * - The credential is deleted/disconnected
 */
export function clearClaudeAuthWarning(): void {
  current = null;
}
