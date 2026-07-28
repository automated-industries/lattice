/**
 * Classification is TOTAL, and the two registries cannot contradict each other.
 *
 * The owner-only guard used to walk every relation and then FILTER through the
 * owner-only registry before asserting anything — so a relation in NEITHER registry
 * was not "asserted safe", it was skipped. Five relations were in that state on a
 * real secured cloud, including `_lattice_embeddings`, whose `content` column is the
 * base row's text verbatim with masked columns included.
 *
 * The integration guard proves the shape against a live cloud. These tests cover the
 * two things a live cloud cannot show:
 *
 *  - a bookkeeping table that no test cloud happens to materialize (the GUI meta
 *    tables, the connector registry, the AI caches) still has to be classified, so
 *    the check is made against the SOURCE rather than against one cloud's shape; and
 *  - the prefix axis, which made "member-readable AND owner-only" expressible for the
 *    first time. Exact-name disjointness was already asserted; a prefix can swallow a
 *    readable name, and nothing was checking that.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEMBER_READABLE_BOOKKEEPING,
  OWNER_ONLY_BOOKKEEPING,
  OWNER_ONLY_BOOKKEEPING_PREFIXES,
  CLOUD_DEFINER_FUNCTIONS,
  classifyCloudRelation,
  classifyDefinerFunction,
  isOwnerOnlyBookkeeping,
  isCloudInternalRelation,
  grantMemberBookkeepingSql,
} from '../../src/cloud/member-access.js';

const SRC = join(import.meta.dirname, '..', '..', 'src');

/** Every `.ts` file under `src/`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Internal relation names the shipping source refers to as whole string literals.
 *
 * Single-quoted only, and required NOT to end in `_`. Both restrictions are about
 * precision rather than convenience: the `'__lattice_fts_'` / `'_lattice_vec_'` /
 * `'__lattice_ai_'` literals are PREFIXES rather than relations, and the index names
 * (`_lattice_gui_audit_row_idx`) only ever appear double-quoted inside SQL, where
 * they are indexes and not relations this rule is about.
 */
function internalRelationLiterals(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/'(_{1,2}lattice_[a-z0-9_]*[a-z0-9])'/g)) found.add(m[1]!);
  }
  return [...found].sort();
}

describe('cloud relation classification', () => {
  it('classifies every internal relation name the source refers to', () => {
    // The property that makes adding a bookkeeping table a deliberate act: a new
    // `__lattice_something` constant fails HERE, at the moment it is written, rather
    // than sitting outside the rule until a cloud happens to be walked with it
    // present. That is the gap that let `_lattice_embeddings` stay unclassified.
    const literals = internalRelationLiterals();
    // Non-vacuous: the scan really does find the bookkeeping namespace.
    expect(literals.length).toBeGreaterThan(20);
    expect(literals).toContain('_lattice_embeddings');
    expect(literals).toContain('__lattice_table_shares');

    const unresolved = literals
      .map((name) => ({ name, klass: classifyCloudRelation(name) }))
      .filter((r) => r.klass === 'unclassified' || r.klass === 'contradictory');
    expect({ unresolved }).toEqual({ unresolved: [] });
  });

  it('never classifies a registered name as both readable and owner-only', () => {
    // Exact-name disjointness was already asserted. The PREFIX axis was not, and it
    // is the one that can silently swallow a readable name.
    for (const e of MEMBER_READABLE_BOOKKEEPING) {
      expect(classifyCloudRelation(e.name), `${e.name} must classify as member-readable`).toBe(
        'member-readable',
      );
    }
    for (const name of OWNER_ONLY_BOOKKEEPING) {
      expect(classifyCloudRelation(name), `${name} must classify as owner-only`).toBe('owner-only');
    }
  });

  it('a prefix really CAN swallow a name, so the disjointness above is not vacuous', () => {
    // If the assertion above only held because prefixes cannot match readable-looking
    // names, it would be worthless. They can: this is a member-readable table's name
    // under an owner-only prefix, and the predicate claims it.
    expect(isOwnerOnlyBookkeeping('__lattice_fts__lattice_gui_meta')).toBe(true);
    expect(isOwnerOnlyBookkeeping('_lattice_vec__lattice_gui_meta')).toBe(true);
    // Both per-table families are covered by prefix, for a table nobody has created.
    expect(classifyCloudRelation('__lattice_fts_anything_at_all')).toBe('owner-only');
    expect(classifyCloudRelation('_lattice_vec_anything_at_all')).toBe('owner-only');
    expect(OWNER_ONLY_BOOKKEEPING_PREFIXES).toContain('__lattice_fts_');
    expect(OWNER_ONLY_BOOKKEEPING_PREFIXES).toContain('_lattice_vec_');
    // …and a readable prefix is not swallowed by either.
    expect(classifyCloudRelation('_lattice_gui_meta')).toBe('member-readable');
  });

  it('reports an unregistered bookkeeping table as unclassified, not as safe', () => {
    // The whole point. A name nobody has classified must come back as a hole.
    expect(classifyCloudRelation('__lattice_something_new')).toBe('unclassified');
    expect(classifyCloudRelation('_lattice_scratch')).toBe('unclassified');
    // User entities and their mask views are not bookkeeping and do not need listing.
    expect(classifyCloudRelation('journal')).toBe('user');
    expect(classifyCloudRelation('journal_v')).toBe('user');
  });

  it('decides internal-ness by the rule the cloud layer actually applies', () => {
    // The classifier tested a bare leading underscore. The cloud layer tests
    // `__lattice_` / `_lattice_` — `reconcileCloudMemberAccess` and
    // `secureNewCloudTable` both skip exactly those two prefixes and secure
    // everything else. A user table named `_foo` therefore gets RLS, a mask view and
    // member grants like any other entity, while the classifier called it a registry
    // hole and reddened the guard. A guard that fails on a correctly-secured table is
    // one somebody eventually turns off.
    for (const name of ['_foo', '_2026_archive', '_x_v']) {
      expect(classifyCloudRelation(name), `${name} is a user table to the cloud layer`).toBe(
        'user',
      );
    }
    expect(isCloudInternalRelation('_foo')).toBe(false);
    expect(isCloudInternalRelation('_lattice_gui_audit')).toBe(true);
    expect(isCloudInternalRelation('__lattice_owners')).toBe(true);
    // …and the internal namespace still fails closed for a name nobody registered,
    // so this is a narrowing of the rule and not a loosening of the guard.
    expect(classifyCloudRelation('_lattice_brand_new')).toBe('unclassified');
    expect(classifyCloudRelation('__lattice_brand_new')).toBe('unclassified');
  });

  it('classifies a mask view over BOOKKEEPING with the relation it is named for', () => {
    // `_lattice_gui_audit_v` is the member read path onto the audit log. It is
    // internal-named, so the prefix rule alone reports it as an unclassified hole —
    // and it is a relation the product deliberately grants members. A mask view holds
    // no data of its own; it classifies with its base.
    expect(classifyCloudRelation('_lattice_gui_audit_v')).toBe('member-readable');
    // The same derivation must not manufacture access: a `_v` over an owner-only
    // relation classifies owner-only, i.e. still assert-not-granted.
    expect(classifyCloudRelation('__lattice_owners_v')).toBe('owner-only');
  });

  it('declares, for every readable entry with a narrowed grant, the view that replaces it', () => {
    // `db.query` emits `SELECT *`. A column-only SELECT grant therefore removes the
    // member's ability to read the relation AT ALL unless a read view is granted
    // beside it — the two are one decision, and splitting them would swap a leak for
    // a dead GUI. Pinned so the pair cannot drift apart.
    for (const e of MEMBER_READABLE_BOOKKEEPING) {
      if (!e.withholdColumns) continue;
      expect(e.readView, `${e.name} narrows SELECT and must declare a read view`).toBeTruthy();
      expect(e.privs, `${e.name} must not also hold table-level SELECT`).not.toMatch(/\bSELECT\b/);
    }
    // Non-vacuous: the audit log really is the relation this is about, and the images
    // really are what it withholds.
    const audit = MEMBER_READABLE_BOOKKEEPING.find((e) => e.name === '_lattice_gui_audit');
    expect(audit?.withholdColumns, 'the audit log must withhold its row images').toEqual([
      'before_json',
      'after_json',
    ]);
    expect(audit?.readView).toBe('_lattice_gui_audit_v');
  });

  it('emits the revoke BEFORE the catalog-driven re-grant, and grants the read view', () => {
    // Two properties, and both were bugs.
    //
    // ORDER: a column-less REVOKE clears the table-level grant and every column-level
    // one, so it must come first. Reversed, a cloud that already holds the old
    // table-level SELECT keeps it and the narrowing is a silent no-op.
    //
    // SOURCE: the re-granted columns come from `information_schema`, never from a list
    // written in the registry. `_lattice_gui_audit` gained `ts`, `undone`, `session_id`
    // and `source` across releases, so a workspace can be carrying any subset — an
    // allowlist naming a column the table does not have makes the GRANT raise and takes
    // the owner open down with it. Measured: three integration fixtures define the
    // audit table without `ts` or `source`.
    const sql = grantMemberBookkeepingSql('lattice_members').find((s) =>
      s.includes('"_lattice_gui_audit"'),
    );
    expect(sql, 'the audit grant statement').toBeTruthy();
    const revoke = sql!.indexOf('REVOKE SELECT ON "_lattice_gui_audit"');
    const regrant = sql!.indexOf('GRANT SELECT (%I)');
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(regrant).toBeGreaterThan(revoke);
    expect(sql).toContain('information_schema');
    expect(sql).toContain(`'before_json', 'after_json'`);
    expect(sql).not.toMatch(/GRANT SELECT, INSERT/);
    expect(sql).toContain('"_lattice_gui_audit_v"');
    // An entry with no narrowing is untouched — no stray revoke on the others.
    const meta = grantMemberBookkeepingSql('lattice_members').find((s) =>
      s.includes('"_lattice_gui_meta"'),
    );
    expect(meta).not.toContain('REVOKE');
    expect(meta).not.toContain('information_schema');
  });
});

describe('cloud SECURITY DEFINER function registry', () => {
  it('flags every function that can return user-table column values', () => {
    // A definer function granted to members is exactly as powerful as a GRANT, and
    // Postgres grants EXECUTE to PUBLIC by default — so this flag, not a privilege
    // bit, is what says "this one can hand back row data and must be proven not to".
    const rowData = CLOUD_DEFINER_FUNCTIONS.filter((f) => f.returnsRowData).map((f) => f.name);
    expect(rowData).toContain('lattice_visible_embeddings');
    // The second member of the same class, and the one that shows why "returns row
    // data" has to include DERIVED values: `lattice_presign_file` returns a URL, and
    // the `files.ref_uri` object key is spliced into it verbatim. It was not in this
    // registry at all — it is installed by enabling cloud S3, and the registry only
    // listed what `secureCloud` alone creates.
    expect(rowData).toContain('lattice_presign_file');
  });

  it('admits no function that returns row data under row visibility alone', () => {
    // The invariant the whole audit of this surface reduces to. `columnMask` has two
    // values and no third, so a new entry cannot be written as "returns row data,
    // gated on rows only" — the shape both leaks had. Enforced here against the
    // registry, and against the live schema by the Postgres guard.
    for (const f of CLOUD_DEFINER_FUNCTIONS) {
      if (f.returnsRowData) {
        expect(f.columnMask, `${f.name} returns row data and must apply the mask`).toBe('applies');
      } else {
        expect(f.columnMask, `${f.name} returns no row data`).toBe('no-row-data');
      }
    }
    // Non-vacuous in both directions.
    expect(CLOUD_DEFINER_FUNCTIONS.some((f) => f.columnMask === 'applies')).toBe(true);
    expect(CLOUD_DEFINER_FUNCTIONS.some((f) => f.columnMask === 'no-row-data')).toBe(true);
  });

  it('classifies by exact signature, and reports an unregistered function as a hole', () => {
    expect(
      classifyDefinerFunction('lattice_visible_embeddings', 'p_table text')?.returnsRowData,
    ).toBe(true);
    // An overload is a different function with different reach, so the args are part
    // of the key rather than the name alone.
    expect(
      classifyDefinerFunction('lattice_visible_embeddings', 'p_table text, p_x text'),
    ).toBeNull();
    expect(classifyDefinerFunction('lattice_brand_new_helper', 'p_table text')).toBeNull();
    // The per-table trigger family is matched by prefix, for a table nobody made yet.
    expect(classifyDefinerFunction('lattice_track_anything_at_all', '')).not.toBeNull();
  });

  it('has no duplicate entries', () => {
    const keys = CLOUD_DEFINER_FUNCTIONS.map((f) => `${f.name}(${f.args})`);
    expect(keys).toEqual([...new Set(keys)]);
  });
});
