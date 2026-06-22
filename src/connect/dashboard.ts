import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { configDir } from '../framework/user-config.js';

/**
 * Shared logic for the "connect a dashboard" feature: validate a user-supplied
 * dashboard path (file or folder), and remember the last connected one so it
 * survives a restart. The path points at the dashboard **in place** on disk —
 * Lattice serves the live folder, so the user's own edits show up on refresh and
 * nothing is copied. Storage is the machine-local config dir; the path itself is
 * not a secret, so it is a plain JSON file (not the encrypted credential store).
 */

const STORE_FILE = 'connected-dashboard.json';

export interface ResolvedDashboard {
  /** Absolute path to the dashboard file or folder. */
  path: string;
  mode: 'file' | 'dir';
}

/**
 * Validate + classify a dashboard path. Throws a clear, user-facing error when
 * the path is blank or does not exist (the caller surfaces the message); never
 * returns a path that does not resolve to a real file/dir.
 */
export function resolveDashboard(path: string): ResolvedDashboard {
  const trimmed = path.trim();
  if (!trimmed) throw new Error('Dashboard path is empty.');
  const abs = resolve(trimmed);
  if (!existsSync(abs)) throw new Error('That path does not exist: ' + abs);
  if (statSync(abs).isDirectory()) return { path: abs, mode: 'dir' };
  // A connected dashboard is served at `/` as a web page, so a single file must
  // be HTML. A data file (.xlsx, .json, .csv, …) is not a dashboard — served
  // raw, the browser would just download it. Point the user at import instead.
  const ext = extname(abs).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') {
    throw new Error(
      'That looks like a data file, not a web page. To load its contents into Lattice, ' +
        'use "Import Dashboard Data" instead of connecting it as a dashboard.',
    );
  }
  return { path: abs, mode: 'file' };
}

/** The persisted connected-dashboard path (machine-local), or null when none. */
export function getConnectedDashboard(): string | null {
  try {
    const raw = readFileSync(join(configDir(), STORE_FILE), 'utf8');
    const v = JSON.parse(raw) as { path?: unknown };
    return typeof v.path === 'string' && v.path ? v.path : null;
  } catch {
    // Absent or unreadable ⇒ nothing connected. Not an error.
    return null;
  }
}

/** Persist the connected-dashboard path, or clear it when `path` is null. */
export function setConnectedDashboard(path: string | null): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STORE_FILE), JSON.stringify({ path: path ?? null }) + '\n', 'utf8');
}
