import { Lattice } from '../lattice.js';
import { emitAnalytics } from './analytics.js';

/**
 * Cloud-connect probe — non-destructive inspection of a candidate
 * target Lattice (typically a BYO Postgres URL the user wants to
 * connect to). Used by the GUI's "Migrate to cloud" and "Connect to
 * existing cloud" wizards to surface team-membership requirements
 * before the user commits, but exported as a public API so library
 * consumers can pre-flight the same check.
 *
 * The function opens a short-lived Lattice against the URL, reads
 * the singleton `__lattice_team_identity` row (if any), then closes.
 * It does NOT mutate the target — `init()` does run, which applies
 * the base schema, but no rows are inserted and no GUI/native
 * registration happens here.
 */

export interface CloudProbeResult {
  /** True iff a Lattice could be opened + init()'d successfully against the URL. */
  reachable: boolean;
  /** Adapter dialect of the probed URL. Useful for the GUI to label cards. */
  dialect: 'sqlite' | 'postgres';
  /** True iff the probed Lattice has a populated `__lattice_team_identity` row. */
  teamEnabled: boolean;
  /** Team name from `__lattice_team_identity.team_name`, if `teamEnabled`. */
  teamName?: string;
  /** Underlying error message when `reachable: false`. */
  error?: string;
}

/**
 * Probe a candidate Lattice URL for reachability + team status.
 *
 * Implementation note: this opens a real Lattice with no schema
 * registered beyond what `init()` applies internally, then queries
 * a single row. The `__lattice_team_identity` table doesn't exist on
 * untouched DBs — the query falls through to a "table not found"
 * which we treat as `teamEnabled: false`. On a Lattice that's been
 * through `lattice gui` (which registers the team-identity table
 * during openConfig), the table exists but may be empty, also
 * `teamEnabled: false`.
 *
 * Never throws. Errors are returned in the result's `error` field
 * with `reachable: false`.
 */
export async function probeCloud(targetUrl: string): Promise<CloudProbeResult> {
  emitAnalytics('probeCloud');
  const dialect: 'sqlite' | 'postgres' = /^postgres(ql)?:\/\//i.test(targetUrl)
    ? 'postgres'
    : 'sqlite';

  let probe: Lattice | null = null;
  try {
    probe = new Lattice(targetUrl);
    await probe.init();

    // Try to read the singleton team identity. If the table doesn't
    // exist (untouched DB), .get throws — treat as not a team.
    let teamEnabled = false;
    let teamName: string | undefined;
    try {
      const row = (await probe.get('__lattice_team_identity', 'singleton')) as {
        team_name?: string;
      } | null;
      if (row && typeof row.team_name === 'string') {
        teamEnabled = true;
        teamName = row.team_name;
      }
    } catch {
      // Table not present — not a team DB.
    }

    return teamName !== undefined
      ? { reachable: true, dialect, teamEnabled, teamName }
      : { reachable: true, dialect, teamEnabled };
  } catch (e) {
    // Surface as much underlying detail as the driver gave us so the GUI
    // can show something more actionable than "Unreachable: unknown".
    // Postgres errors from `pg` carry `.code` (SQLSTATE) + `.routine` +
    // `.severity` properties — include them when present so callers can
    // tell e.g. SCRAM auth failure (28P01) from a network error.
    const err = e as Error & { code?: string; routine?: string; severity?: string };
    const parts: string[] = [];
    if (err.code) parts.push(`[${err.code}]`);
    if (err.message) parts.push(err.message);
    if (err.routine && !err.message.includes(err.routine)) {
      parts.push(`(routine: ${err.routine})`);
    }
    return {
      reachable: false,
      dialect,
      teamEnabled: false,
      error: parts.join(' ') || 'unknown',
    };
  } finally {
    if (probe) {
      try {
        probe.close();
      } catch {
        // best-effort
      }
    }
  }
}
