/**
 * The member-access registry is the single source of truth for what a cloud
 * MEMBER may reach. These pure-function tests pin the registry shape + the grant
 * SQL it emits, so the "forgot to grant / accidentally granted" class is caught
 * here rather than as a production GUI degradation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEMBER_READABLE_BOOKKEEPING,
  OWNER_ONLY_BOOKKEEPING,
  grantMemberTableAccessSql,
  grantMemberTableAccessBatchSql,
  grantMemberBookkeepingSql,
  grantMemberExecuteSql,
} from '../../src/cloud/member-access.js';

describe('member-access registry', () => {
  it('keeps readable and owner-only sets disjoint (no table is both)', () => {
    const readable = new Set(MEMBER_READABLE_BOOKKEEPING.map((e) => e.name));
    for (const t of OWNER_ONLY_BOOKKEEPING) {
      expect(readable.has(t), `${t} must not be both member-readable and owner-only`).toBe(false);
    }
  });

  it('lists the GUI/identity/changelog tables as member-readable', () => {
    const names = MEMBER_READABLE_BOOKKEEPING.map((e) => e.name);
    expect(names).toContain('_lattice_gui_meta');
    expect(names).toContain('_lattice_gui_column_meta');
    expect(names).toContain('_lattice_gui_audit');
    expect(names).toContain('__lattice_user_identity');
    expect(names).toContain('__lattice_changelog');
  });

  it('keeps the sensitive bookkeeping tables owner-only', () => {
    for (const t of [
      '__lattice_owners',
      '__lattice_row_grants',
      '__lattice_member_invites',
      '__lattice_cloud_settings',
      '__lattice_column_policy',
    ]) {
      expect(OWNER_ONLY_BOOKKEEPING).toContain(t);
    }
  });

  it('grantMemberTableAccessSql: NEVER grants table-level base SELECT — masked or not', () => {
    // This is the whole security property of the 5.5 masking change, so it is
    // asserted as a property over every statement rather than as a fixed list.
    //
    // There used to be a second branch here: "this table isn't masked, so grant
    // members SELECT on the base table." It decided masked-ness by looking the
    // column policy up BY NAME, and a policy stranded by a rename reads back empty —
    // indistinguishable from "nothing is masked". So the branch handed members raw
    // SELECT on a table whose columns the owner had marked secret. Every masking
    // leak we have shipped came out of that statement, and it was patched three
    // times, path by path, while the branch itself stayed. There is no unmasked
    // branch now, which is what makes the whole class unreachable.
    for (const masked of [true, false]) {
      const sql = grantMemberTableAccessSql('people', { masked }, 'lattice_members');
      expect(sql.some((s) => s.startsWith('REVOKE SELECT ON "people"'))).toBe(true);
      for (const s of sql) {
        // Column-level grants — GRANT SELECT (col) — are a different privilege and
        // are exempt; the parenthesis is what distinguishes them.
        expect(s).not.toMatch(/GRANT\s+[^(;]*\bSELECT\b(?!\s*\()[^(;]*ON\s+"people"(?!_v)/);
      }
    }
  });

  it('grantMemberTableAccessSql: members read the _v view and write the base', () => {
    const sql = grantMemberTableAccessSql('people', undefined, 'lattice_members');
    expect(sql[0]).toBe('GRANT INSERT, UPDATE, DELETE ON "people" TO lattice_members');
    // The view grant is guarded: reconcile runs against pre-5.5 clouds whose views
    // do not exist yet, and it is the same pass that builds them.
    expect(sql.join('\n')).toContain('GRANT SELECT ON "people_v" TO lattice_members');
    expect(sql.join('\n')).toContain('to_regclass');
  });

  it('grantMemberTableAccessSql: a masked table still lets the member name its own key in a write', () => {
    // Postgres needs SELECT on every column an UPDATE/DELETE's WHERE clause names.
    // Without this the revoke above makes the table read-only for members — which is
    // what it silently did, because the old tests asserted privilege bits and never
    // performed a member write.
    const dml =
      grantMemberTableAccessSql('people', undefined, 'lattice_members').find((s) =>
        s.includes('LATTICE_DMLKEY'),
      ) ?? '';
    expect(dml).toContain('GRANT SELECT (%I) ON %I TO lattice_members');
    expect(dml).toContain('indisprimary'); // key columns come from the catalog...
    expect(dml).toContain("'deleted_at'"); // ...plus the soft-delete marker
    // ...and NEVER from the column policy — a stranded policy must not be able to
    // widen what a member can read.
    expect(dml).not.toContain('__lattice_column_policy');
  });

  it('the plpgsql and TypeScript view-mask readers recover the SAME columns', () => {
    // Two places recover "which columns does the standing view guard" out of
    // pg_get_viewdef: the TypeScript rebuild (viewMaskedColumns, cloud/audience.ts)
    // and the plpgsql member add-column path (cloud/rls.ts), which is the one that
    // runs with NO owner connected. They disagreed once already — the plpgsql one was
    // case-sensitive, required an unquoted name, and matched a single literal space —
    // and because Postgres QUOTES any identifier that is not all-lowercase, that
    // disagreement republished a mixed-case masked column in clear.
    //
    // Compared by BEHAVIOUR rather than by text, because they are written in different
    // languages and a byte comparison would either be impossible or would pass on two
    // patterns that happen to look alike. Whatever they are, they must accept the same
    // definitions — that is the property, and it is the one that broke.
    const src = (rel: string): string =>
      readFileSync(join(import.meta.dirname, '..', '..', 'src', rel), 'utf8');

    // Lift each reader's pattern out of the source it actually ships in.
    const tsLiteral = /const re = (\/.*\/[gimsuy]*);/.exec(src('cloud/audience.ts'))?.[1];
    expect(tsLiteral, 'the TypeScript reader in cloud/audience.ts has moved').toBeTruthy();
    // EVERY plpgsql reader, not the first one. There is more than one now
    // (`lattice_member_add_column` recovers the guarded column NAMES;
    // `lattice_table_has_masked_column` asks whether there are any), and lifting only
    // the first match quietly stopped testing whichever one moved later in the file —
    // which is precisely how two readers of the same artifact drift apart.
    const pgLiterals = [...src('cloud/rls.ts').matchAll(/'(END AS\[\[:space:\]\][^']*)'/g)].map(
      (m) => m[1]!,
    );
    expect(
      pgLiterals.length,
      'the plpgsql view-mask readers in cloud/rls.ts have moved',
    ).toBeGreaterThanOrEqual(2);

    const tsBody = /^\/(.*)\/([gimsuy]*)$/.exec(tsLiteral ?? '');
    const tsRe = new RegExp(tsBody?.[1] ?? '', tsBody?.[2] ?? '');
    // POSIX ERE → JS: the two spellings of "any whitespace" and "optional".
    const pgRes = pgLiterals.map(
      (lit) => new RegExp(lit.replace(/\[\[:space:\]\]/g, '\\s').replace(/\{0,1\}/g, '?'), 'gi'),
    );

    const names = (re: RegExp, def: string): string[] => {
      const out: string[] = [];
      const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      for (let m = r.exec(def); m !== null; m = r.exec(def)) if (m[1]) out.push(m[1]);
      return out;
    };

    const defs: [string, string[]][] = [
      // What Postgres stores for a lowercase masked column.
      [
        'SELECT CASE WHEN lattice_is_owner(...) THEN j.secret ELSE NULL::text END AS secret',
        ['secret'],
      ],
      // ...and for one that is not all-lowercase, which it quotes. This is the case
      // that leaked.
      [
        'SELECT CASE WHEN lattice_is_owner(...) THEN j."secretNote" ELSE NULL::text END AS "secretNote"',
        ['secretNote'],
      ],
      // Postgres reflows the definition it stores, so the gap can be a newline.
      ['CASE WHEN x THEN j.a ELSE NULL::text END AS\n    "mixedCase",\n  j.body', ['mixedCase']],
      // Several in one definition, in order.
      ['... END AS a, j.body, ... END AS "B2"', ['a', 'B2']],
      // Nothing guarded: an unmasked pass-through view must yield no columns at all,
      // or every rebuild would "preserve" masks that were never there.
      ['SELECT j.id, j.body FROM journal j WHERE lattice_row_visible(...)', []],
    ];
    for (const [def, expected] of defs) {
      expect(names(tsRe, def), `TypeScript reader on: ${def}`).toEqual(expected);
      for (const [i, pgRe] of pgRes.entries()) {
        expect(names(pgRe, def), `plpgsql reader #${String(i)} on: ${def}`).toEqual(expected);
      }
    }
  });

  it('grantMemberTableAccessBatchSql: joins the statements into one multi-statement string', () => {
    // One round-trip per table; pg's simple-query protocol runs them all at once,
    // which is only safe while the SQL binds no parameters.
    expect(grantMemberTableAccessBatchSql('people', undefined, 'lattice_members')).toBe(
      grantMemberTableAccessSql('people', undefined, 'lattice_members').join('; '),
    );
    const masked = grantMemberTableAccessBatchSql('people', { masked: true }, 'lattice_members');
    expect(masked).toBe(
      grantMemberTableAccessSql('people', { masked: true }, 'lattice_members').join('; '),
    );
    expect(masked).not.toContain('?'); // parameterless — see the batch doc comment
  });

  it('grantMemberBookkeepingSql emits one to_regclass-guarded GRANT per readable entry', () => {
    const sql = grantMemberBookkeepingSql('lattice_members');
    expect(sql).toHaveLength(MEMBER_READABLE_BOOKKEEPING.length);
    for (const e of MEMBER_READABLE_BOOKKEEPING) {
      expect(
        sql.some((s) => s.includes(`"${e.name}"`) && s.includes('to_regclass')),
        `${e.name} must have a guarded grant`,
      ).toBe(true);
    }
  });

  it('grantMemberExecuteSql grants EXECUTE on the SQLite-compat polyfills only', () => {
    const sql = grantMemberExecuteSql('lattice_members');
    expect(sql).toContain('json_extract(text, text)');
    expect(sql).toContain('strftime(text, text)');
    expect(sql).toContain('lattice_members');
    // The DEFINER RLS helpers must NOT be in the member EXECUTE grant.
    expect(sql).not.toContain('lattice_is_owner');
  });
});
