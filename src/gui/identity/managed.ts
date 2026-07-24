/**
 * Managed-workspace mode — the env seam a hosting layer injects per session so
 * the GUI delegates workspace management (invite / members / revoke / create)
 * to the deployment's workspace manager instead of running its own token
 * machinery. Follows the `LATTICE_MANAGED_MODEL_AUTH` precedent exactly: a
 * session without the seam behaves byte-for-byte as before.
 *
 * Deliberately NOT gated on "the open workspace is Postgres" (`cloudMode`):
 * a self-hosted user with their own Postgres cloud has no manager and must
 * keep the token flow.
 */

export function managedWorkspacesUrl(): string | null {
  const v = process.env.LATTICE_MANAGED_WORKSPACES_URL;
  if (!v) return null;
  return v.replace(/\/$/, '');
}

export function isManagedWorkspaces(): boolean {
  return managedWorkspacesUrl() !== null;
}

/**
 * Forward a workspace-management call to the manager. The manager (not the GUI)
 * holds every credential and enforces ownership/caps; the GUI session only ever
 * reaches its own per-session endpoint. Errors come back verbatim so the dialog
 * shows the manager's message ("Member limit reached."), not a generic one.
 */
export async function managerCall<T>(
  path: 'invite' | 'members' | 'revoke' | 'create',
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<T> {
  const base = managedWorkspacesUrl();
  if (!base) throw new Error('No workspace manager is configured for this session.');
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `workspace manager error (${String(res.status)})`);
  return data;
}
