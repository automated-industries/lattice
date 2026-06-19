/**
 * Detect whether a Lattice GUI is already serving a given localhost port.
 *
 * This is what keeps `lattice gui` a SINGLETON. The server falls back to the next
 * free port when its requested one is busy (so it never hard-fails), but for the
 * desktop GUI that fallback is a trap: launching Lattice while one is already
 * running — the installer, double-clicking the app, repeated dev launches — would
 * silently start a SECOND instance on the next port, each with its own browser tab
 * and its own background auto-update supervisor. Those pile up (and drift to
 * different versions), which is what crashes the browser. So before starting,
 * `runGui` probes the target port: if a Lattice GUI answers, it reuses it instead
 * of spawning a duplicate.
 *
 * A Lattice GUI answers `GET /api/version` with a JSON `{ version }` object; any
 * other response, or nothing listening, means "no Lattice GUI here" → null.
 */
export async function probeRunningGui(
  port: number,
  timeoutMs = 1000,
): Promise<{ version: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/version`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (typeof data !== 'object' || data === null || !('version' in data)) return null;
    const v = (data as { version: unknown }).version;
    return { version: typeof v === 'string' ? v : '' };
  } catch {
    // Connection refused / not listening / not a Lattice GUI / timed out.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
