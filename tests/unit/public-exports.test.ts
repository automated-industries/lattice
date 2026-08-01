import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as lattice from '../../src/index.js';

/**
 * Additive-only guard for the public API surface.
 *
 * The promise is that an existing caller keeps working across a minor release — the
 * published surface only GROWS. Removing or renaming a name breaks that promise
 * outright, and not gently: an ESM `import { gone } from 'latticesql'` fails to
 * instantiate the module, so a program that merely LISTS the name stops loading before
 * any of its own code runs.
 *
 * The baseline is a plain checked-in file (`public-surface.json`), deliberately NOT a
 * snapshot and deliberately NOT under `__snapshots__/`. That placement is the whole
 * point, and it is the one thing here that was learned the hard way. A snapshot has a
 * tool that rewrites it — `vitest -u` — which accepts a deletion exactly as readily as
 * an addition, prints "1 updated", and turns this guard green in one command. Reaching
 * for that command is a reflex when a test goes red, so the guard that most needed a
 * deliberate answer was the one easiest to answer without thinking, and a removal did go
 * out that way. Nothing regenerates the file.
 *
 * `published` is every name this major has published — NOT the current surface. A name
 * that is no longer exported stays on the list and is explained by an entry in
 * `removed`, carrying the version it went in and one line of why. So a removal is not
 * recorded by deleting a line; it is recorded by adding a paragraph, which is the diff a
 * reviewer is meant to stop on. That shape is what makes the checks below possible:
 *
 *  - a name gone from the entry with no record fails, because the list still names it;
 *  - regenerating the list from the live surface fails, because it drops the recorded
 *    names and leaves their records pointing at nothing;
 *  - deleting a name from the list outright fails, because the list may not shrink below
 *    {@link PUBLISHED_FLOOR};
 *  - re-exporting a recorded name fails, so a name cannot be quietly resurrected and
 *    then removed a second time under the first removal's record.
 *
 * BE CLEAR ABOUT WHAT THIS CANNOT DO, because a guard trusted past its reach is worse
 * than no guard. It cannot tell a legitimate removal from an illegitimate one: a removal
 * stated in `removed` passes, and stating one costs a hand edit. That is deliberate —
 * the goal is that removals are ANSWERED, not that they are impossible. Nor is the floor
 * a fence. It pins the length the list had when the number below was last written, so it
 * refuses the next deletion outright; once the surface has grown by k names, k of them
 * could be deleted again before the length dips under it. And no test reading only the
 * working tree can do better than this without reading history.
 *
 * The one arm that survives even a co-ordinated hand edit to the baseline is the floor of
 * names at the bottom: those are written in this file, so dropping one means editing the
 * test itself.
 */

const ROOT = resolve(__dirname, '..', '..');
const BASELINE_PATH = join(__dirname, 'public-surface.json');

/** One acknowledged removal: the name, the release it left in, and why. */
interface RemovalRecord {
  name: string;
  version: string;
  reason: string;
}

interface Baseline {
  /** The major `published` was captured at. Re-agreed, and recaptured, at each major. */
  major: number;
  /** Every name this major has published, sorted — including names since removed. */
  published: string[];
  /** Why each name on `published` that is no longer exported is not exported. */
  removed: RemovalRecord[];
}

/**
 * The length `published` had when this number was last written. The list may grow past
 * it freely — an addition never needs this touched — but it may not shrink below it,
 * which is what makes deleting a name from the list a failing edit rather than a free
 * one. It lives HERE rather than beside the list so that rewriting that file cannot also
 * rewrite the bar it is measured against.
 *
 * Lower it only when the major changes and the list is recaptured; a recapture drops the
 * removed names, so the list legitimately gets shorter exactly then.
 */
const PUBLISHED_FLOOR = 534;

/**
 * Names something downstream is known to build on, pinned in the test rather than in the
 * baseline. Kept short on purpose: a floor is only useful while every line on it is one
 * somebody would notice going missing. These are the four a managed deployment imports —
 * the same four the packaging import/require checks assert — plus the retrieval entry
 * points.
 */
const LOAD_BEARING = [
  'Lattice',
  'registerNativeEntities',
  'secureCloud',
  'memberGroupFor',
  'evaluateRetrieval',
  'benchmarkRetrieval',
  'checkSlos',
];

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
const removedNames = baseline.removed.map((r) => r.name);

const currentMajor = Number(
  (
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  ).version.split('.')[0],
);

const current = Object.keys(lattice).sort();

describe('public API surface (additive-only)', () => {
  it('every published name is still exported, or says why it is not', () => {
    const unrecorded = baseline.published.filter(
      (n) => !current.includes(n) && !removedNames.includes(n),
    );
    expect(
      unrecorded,
      `These names are on the published list and gone from the package entry, with no ` +
        `removal recorded: ${unrecorded.join(', ')}. Removing a published name is a breaking ` +
        `change — an ESM importer that merely lists it stops loading. Restore the export; or, ` +
        `if the removal is intended, add an entry to the "removed" array of ` +
        `tests/unit/public-surface.json giving the name, the version it goes out in, and one ` +
        `line of why, and LEAVE the name on "published". Deleting the name from the list is ` +
        `not how this is recorded and will fail a different check.`,
    ).toEqual([]);
  });

  it('every exported name is on the published list — additions are recorded, not implied', () => {
    const unlisted = current.filter((n) => !baseline.published.includes(n));
    expect(
      unlisted,
      `New public names, not yet in tests/unit/public-surface.json: ` +
        `${unlisted.map((n) => JSON.stringify(n)).join(', ')}. Add them (sorted) to its ` +
        `"published" array, so the diff shows the surface growing and confirms nothing was ` +
        `dropped alongside.`,
    ).toEqual([]);
  });

  it('every acknowledged removal names a name the published list still carries', () => {
    const stranded = removedNames.filter((n) => !baseline.published.includes(n));
    expect(
      stranded,
      `tests/unit/public-surface.json records these as removed but no longer lists them under ` +
        `"published": ${stranded.join(', ')}. The list is every name this major published, not ` +
        `the current surface — a removed name stays on it and its record explains the absence. ` +
        `This is what a wholesale recapture from the live surface looks like: it drops the ` +
        `removed names and leaves their records pointing at nothing. Put them back.`,
    ).toEqual([]);
  });

  it('nothing recorded as removed is exported again', () => {
    const resurrected = removedNames.filter((n) => current.includes(n));
    expect(
      resurrected,
      `tests/unit/public-surface.json records these as removed, and the package entry exports ` +
        `them: ${resurrected.join(', ')}. Re-adding a name is an addition and has to be ` +
        `recorded as one — delete its removal record. Leaving the record in place would let ` +
        `the name be removed a second time later under the first removal's acknowledgement, ` +
        `without anybody agreeing to that one.`,
    ).toEqual([]);
  });

  it('every acknowledged removal is complete and dated at this major', () => {
    const malformed = baseline.removed
      .map((r, i) => {
        const where = `removed[${String(i)}] (${r.name || '<unnamed>'})`;
        if (!r.name?.trim()) return `${where}: no "name"`;
        if (!r.reason?.trim()) return `${where}: no "reason" — say in one line why it went`;
        if (!/^\d+\.\d+\.\d+$/.test(r.version ?? ''))
          return `${where}: "version" must be the x.y.z release it goes out in, got ${JSON.stringify(r.version)}`;
        const recordedMajor = Number(r.version.split('.')[0]);
        if (recordedMajor !== baseline.major)
          return `${where}: recorded at ${r.version}, but this list was captured at major ${String(baseline.major)}`;
        return null;
      })
      .filter((m): m is string => m !== null);
    expect(
      malformed,
      `Incomplete removal records in tests/unit/public-surface.json: ${malformed.join('; ')}. ` +
        `A removal is an exception to the additive-only promise, so each one carries the name, ` +
        `the release it goes out in, and a reason — an exception nobody can read is not one ` +
        `anybody agreed to.`,
    ).toEqual([]);
  });

  it('the published list has not shrunk', () => {
    expect(
      baseline.published.length,
      `tests/unit/public-surface.json lists ${String(baseline.published.length)} names; this ` +
        `major has published at least ${String(PUBLISHED_FLOOR)}, so a name was taken off the ` +
        `list. Taking a name off is not how a removal is recorded: the list keeps every name ` +
        `this major published, and a name that is no longer exported is explained by an entry ` +
        `in "removed". Put it back and record it there. Lowering PUBLISHED_FLOOR is correct ` +
        `only when the major changes and the list is recaptured.`,
    ).toBeGreaterThanOrEqual(PUBLISHED_FLOOR);
  });

  it('was captured at the major this package is on', () => {
    expect(
      baseline.major,
      `tests/unit/public-surface.json was captured at major ${String(baseline.major)}; this ` +
        `package is ${String(currentMajor)}.x. Recapture it — dropping the names this major ` +
        `removed, clearing their records, and re-pinning PUBLISHED_FLOOR to the new length — ` +
        `so the comparisons above resume against the surface this major ships.`,
    ).toBe(currentMajor);
  });

  it('the published list is sorted and free of duplicates', () => {
    const sorted = [...baseline.published].sort();
    expect(
      baseline.published,
      `tests/unit/public-surface.json's "published" array must be sorted with no repeats, so ` +
        `that a name added or removed shows up as a one-line diff where a reviewer looks for ` +
        `it rather than anywhere in 500 lines.`,
    ).toEqual(sorted);
    expect(new Set(baseline.published).size).toBe(baseline.published.length);
  });

  it('keeps the load-bearing public surface present', () => {
    for (const name of LOAD_BEARING) {
      expect(lattice).toHaveProperty(name);
    }
  });
});
