/**
 * The last check before reconciliation is allowed to DELETE a rendered tree.
 *
 * Cleanup works by difference: whatever the previous render recorded and the
 * current schema no longer produces is treated as removed and swept from disk.
 * That is correct exactly when the current schema is the whole truth about this
 * workspace. When it is not — because the process never learned the layout —
 * every previously rendered context reads as removed, and a command that was
 * asked to reconcile quietly empties the directory instead.
 *
 * The two ways a process ends up with less than the truth, and how each is told
 * apart from a workspace that genuinely dropped something:
 *
 *  1. **The layout never loaded.** A shared workspace whose published layout has
 *     not arrived, a config that describes nothing. The tell is that the process
 *     holds no user-declared rendered layout AT ALL while the previous render
 *     recorded one. Framework-shipped tables are excluded from both sides of
 *     that comparison — every opener registers those, so counting them would
 *     make the condition unreachable and the check decorative. (It was, and this
 *     is the bug that made this file necessary.)
 *
 *     "Framework-shipped" is BOTH the named native entities AND anything under
 *     the reserved `_lattice_` / `__lattice_` prefix, and it has to be, because
 *     which bookkeeping tables exist depends on HOW the workspace was opened:
 *     the browser registers per-entity metadata, per-column metadata, a machine
 *     identity row and an audit log, and a command registers none of them. Every
 *     one of those renders a file, so a workspace the browser has touched left a
 *     record of four tables no command will ever declare — and check 2 read that
 *     as four rendered outputs the workspace had dropped. Paired with any source
 *     whose tables could not be reconstructed, that refused every command-line
 *     reconciliation of that workspace, permanently, over internal bookkeeping
 *     the operator cannot act on and no flag can clear. The prefix is the
 *     existing convention for "this table is Lattice's, not the workspace's"
 *     (see `schema/identifier.ts`), so it is asked BY PREFIX rather than by a
 *     list of names that only one of the openers could keep current.
 *
 *     A workspace that really did delete its LAST table looks EXACTLY like this
 *     from here, and no fact available to this function tells the two apart — a
 *     config that lost its entities and a config whose entities were removed on
 *     purpose are the same file. So this one is not a verdict, it is a question,
 *     and {@link CleanupBackstopInput.layoutEmptied} is the answer: a caller who
 *     knows the emptiness is intended says so and the pass proceeds. Without
 *     that, the refusal would be permanent — reconciliation stops writing as
 *     well as sweeping, and the stale tree could never be cleared.
 *
 *  2. **A rendered context this process cannot account for.** An external
 *     database or an MCP connector registers its tables at connect time, in that
 *     process only; a later opener has to replay the registration. When it did
 *     not — or replayed the TABLE and not its rendered CONTEXT, which is the
 *     same asymmetry one step smaller — the source's rendered tree looks
 *     orphaned. So the comparison is against the live rendered CONTEXTS, not the
 *     live tables: cleanup deletes on the absence of a context, and a table
 *     restored without one is precisely the state that reads as "removed".
 *     It is told apart from a genuine drop by asking the workspace's own
 *     connector registry: a table a currently connected source owns was never
 *     "removed by the user" — it was never learned. A source whose table set
 *     cannot be reconstructed here is treated the same way, because "I cannot
 *     name their tables" is not permission to delete a tree that might be
 *     theirs.
 *
 * Everything else proceeds: a table dropped from the config, a row deleted, a
 * layout genuinely emptied of one entity while others remain. The check refuses
 * a whole cleanup pass rather than filtering it, because a process that is wrong
 * about one table is not trustworthy about the rest of the same pass.
 *
 * **What counts as "previously rendered" is every rendered FILE, not only the
 * per-record directory trees.** A table that renders one rollup file and no
 * per-record directory — the simplest and most common shape a workspace has —
 * records no entity context at all. Asking only about entity contexts therefore
 * answered "there is no baseline here" for exactly those workspaces, so this
 * whole check stood down and the sweep deleted the one file the workspace had.
 * The baseline is drawn from the previous render's rendered files as well, and
 * the live side is widened to match: the live rendered layout is the entity
 * contexts PLUS the tables that render a file, or the check would refuse every
 * healthy single-file workspace instead of the emptied one.
 *
 * Each shape still gets its OWN comparison in check 2, because they are deleted
 * for different reasons: a per-record tree is swept when its CONTEXT stops being
 * produced, a table's rollup file when its TABLE does, a multi-output file when
 * its MULTI does. Comparing any of them against another's live set is how a real
 * removal gets missed (a context lost while the table survives) or a healthy
 * workspace gets blocked — which is exactly what happened to multi-outputs. They
 * are recorded under the MULTI's name, and a multi name is not a table name: it
 * is an arbitrary label the caller chooses (`agent-context`, `author-context`),
 * and nothing registers a table by it. Held against the live TABLES, every live,
 * unchanged multi therefore read as output the workspace had dropped, and any
 * source whose tables could not be reconstructed turned that into a standing
 * refusal no flag could clear. The live multis are their own set for the same
 * reason the other two are their own sets.
 */
import type { LatticeManifest } from './manifest.js';
import type { CleanupResult } from './cleanup.js';
import { isReservedInternalIdentifier } from '../schema/identifier.js';

/** The result of a cleanup pass that was refused: nothing touched, and the reason. */
export function refusedCleanup(reason: string): CleanupResult {
  return { directoriesRemoved: [], filesRemoved: [], directoriesSkipped: [], warnings: [reason] };
}

export interface CleanupBackstopInput {
  /** The directory whose rendered tree is about to be reconciled. */
  outputDir: string;
  /** What the previous render recorded, or null when there is no baseline. */
  prevManifest: LatticeManifest | null;
  /**
   * Tables the live schema renders a per-record context for.
   *
   * The ONE thing this check compares against, on both sides. Cleanup sweeps a
   * rendered tree when the schema stops producing a CONTEXT for it, so asking
   * whether the TABLE is registered answers a different question than the one
   * that decides the deletion — and a table restored without its context slips
   * straight through it.
   */
  liveContexts: ReadonlySet<string>;
  /**
   * Tables the live schema renders a FILE for — a rollup, a multi-output.
   *
   * The other half of "what this process renders". A workspace whose tables
   * render one file each and no per-record directories has no entity contexts
   * whatsoever, so without this the live side of check 1 reads as empty for a
   * perfectly healthy workspace, and the prior side reads as empty for one whose
   * layout was lost — the two mistakes that made the deletion invisible to this
   * check in both directions.
   */
  liveFileTables: ReadonlySet<string>;
  /**
   * Multi-output renders this process produces, BY MULTI NAME.
   *
   * Separate from the tables on purpose: the manifest records a multi's files
   * under the name the multi was declared with, which is an arbitrary label and
   * never a table name. Asking whether a TABLE by that name is registered always
   * answers no, so every live multi read as removed output. What retires a
   * multi's files is the multi no longer being declared — so that is what this
   * side of the comparison holds.
   */
  liveMultis: ReadonlySet<string>;
  /**
   * Framework-shipped tables named individually — the native entities every
   * opener registers. Anything under the reserved `_lattice_` / `__lattice_`
   * prefix is framework bookkeeping too and is excluded alongside them WITHOUT
   * being listed here, because which of those exist depends on how the workspace
   * was opened and no single opener could keep the list current.
   *
   * All of it carries no information about whether this process learned the
   * workspace's own layout, so all of it is excluded from both sides of check 1.
   */
  frameworkTables: ReadonlySet<string>;
  /** Tables owned by a currently-connected external source. */
  externalTables: ReadonlySet<string>;
  /** Connected external sources whose table set could not be reconstructed. */
  unresolvedSources: readonly string[];
  /**
   * The caller states that this workspace really does render nothing now — it
   * was emptied on purpose, not left unloaded. Answers check 1 only; a rendered
   * context that belongs to a connected source is still protected, because
   * "I emptied my layout" says nothing about somebody else's tables.
   */
  layoutEmptied?: boolean;
}

/**
 * The reason this cleanup pass must not run, or null when it may proceed.
 *
 * The returned string is surfaced to the operator as a warning, and the command
 * that ran the reconciliation reports it as a failure — a refusal is a problem
 * to fix, never a quiet success over an untouched directory.
 */
export function cleanupRefusal(input: CleanupBackstopInput): string | null {
  const {
    outputDir,
    prevManifest,
    liveContexts,
    liveFileTables,
    liveMultis,
    frameworkTables,
    externalTables,
    unresolvedSources,
    layoutEmptied = false,
  } = input;

  // A table is the WORKSPACE'S own when it is neither a named native entity nor
  // under the reserved internal prefix. Both are the framework's, registered by
  // whichever opener happens to run, and counting either would make this check
  // fire on the difference between two openers instead of on a lost layout.
  const ownTable = (t: string): boolean =>
    !frameworkTables.has(t) && !isReservedInternalIdentifier(t);

  // What the previous render left on disk, in all three of the shapes it renders
  // in: per-record directory trees (entity contexts), a table's rollup file, and
  // a multi's outputs. Any one alone is a baseline worth protecting; a workspace
  // with only a rollup used to read as having none at all.
  const priorContexts = Object.keys(prevManifest?.entityContexts ?? {}).filter(ownTable);
  const priorFileTables = Object.keys(prevManifest?.tableFiles ?? {}).filter(ownTable);
  // NOT filtered by the framework tables: a multi's name is its own namespace,
  // and nothing framework-shipped declares one.
  const priorMultis = Object.keys(prevManifest?.multiFiles ?? {});
  const priorAny = new Set([...priorContexts, ...priorFileTables, ...priorMultis]);
  // Nothing of this workspace's own was rendered here before — nothing can be
  // wrongly swept, so there is nothing to refuse.
  if (priorAny.size === 0) return null;

  // 1 — this process holds no rendered layout of its own at all. "Layout" is all
  // three shapes, for the same reason the baseline is: a process that renders one
  // file per table and no directories has a complete layout and zero contexts,
  // and one that renders only multis has a complete layout and neither.
  const liveOwn = new Set<string>();
  for (const table of liveContexts) if (ownTable(table)) liveOwn.add(table);
  for (const table of liveFileTables) if (ownTable(table)) liveOwn.add(table);
  for (const multi of liveMultis) liveOwn.add(multi);
  if (liveOwn.size === 0 && !layoutEmptied) {
    return (
      `${outputDir}: cleanup skipped — this workspace renders no layout of its own, yet ` +
      `${String(priorAny.size)} previously rendered output(s) are recorded here. Nothing was ` +
      `removed, because the two things that look like this are opposites: a layout that never ` +
      `loaded (check the config, and for a shared workspace that its layout is readable), or one ` +
      `that really was emptied. If it was emptied on purpose, say so — pass --layout-emptied on ` +
      `the command, or layoutEmptied: true from a library call — and this tree will be swept.`
    );
  }

  // 2 — rendered output this process no longer produces. Each shape is compared
  // against the live set that actually governs its deletion:
  //  - a per-record tree is swept when its CONTEXT stops being produced, so a
  //    table registered without its rendered context still reads as removed —
  //    exactly the half-restored state a partial replay leaves behind, and the
  //    reason this side must not be compared against the live tables;
  //  - a table's rollup is swept when its TABLE stops being registered, which is
  //    what retires its path, so that side is compared against the live tables;
  //  - a multi's outputs are retired when the MULTI stops being declared, so
  //    that side is compared against the live multis. Held against the tables
  //    instead, a live multi never matched anything and stayed permanently
  //    "removed".
  const unknown = [
    ...new Set([
      ...priorContexts.filter((t) => !liveContexts.has(t)),
      ...priorFileTables.filter((t) => !liveFileTables.has(t)),
      ...priorMultis.filter((m) => !liveMultis.has(m)),
    ]),
  ];
  if (unknown.length === 0) return null;

  const fromConnected = unknown.filter((t) => externalTables.has(t));
  if (fromConnected.length > 0) {
    return (
      `${outputDir}: cleanup skipped — ${fromConnected.join(', ')} belong(s) to a connected ` +
      `source this workspace still has, but was not loaded here, so its rendered output reads ` +
      `as removed. Nothing was removed. Open the workspace so the connection is loaded, or ` +
      `disconnect the source first if you meant to retire it.`
    );
  }

  if (unresolvedSources.length > 0) {
    return (
      `${outputDir}: cleanup skipped — ${unknown.join(', ')} render(s) output this ` +
      `workspace no longer declares, but the tables of connected source(s) ` +
      `${unresolvedSources.join(', ')} could not be worked out on this machine, so they cannot ` +
      `be ruled out as the owner. Nothing was removed. Reconnect the source (or disconnect it) ` +
      `and run this again.`
    );
  }

  return null;
}
