import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A mask that nothing calls is not a mask.
 *
 * `maskAuditImages` was written, documented, covered by a passing unit test — and
 * wired to nothing. It sat in the tree as dead code while a cloud member's
 * version-history read went on returning owner-secret columns in cleartext, and
 * while a docstring two functions below it asserted the gap was closed. The test
 * suite could not tell: it called the helper directly and proved the helper worked,
 * which was true and beside the point.
 *
 * That is the failure this file exists to catch, and it is a SHAPE, not an
 * incident: a security control is written, reviewed, believed, and never invoked.
 * Nothing else in the suite notices, because every other test either exercises the
 * helper directly or exercises a path that was never wired to it.
 *
 * The registry below is deliberately CURATED rather than inferred. There is no
 * heuristic guessing which exports are security-relevant, so this cannot fire on
 * ordinary code, and adding an entry is a deliberate act at review time. A generic
 * unused-export lint would be useless here for both reasons: `src/index.ts`
 * re-exports most of the surface, and `maskAuditImages` WAS referenced — by a test.
 *
 * The stronger guard is the integration test that drives a real route as a real
 * member and asserts the secret value is absent from the response body; that one
 * catches dead code inherently because it never names the helper at all. This is
 * the cheap sibling that runs without Postgres and names the rule out loud.
 *
 * WHAT THIS FILE CANNOT DO, stated so nobody trusts it further than it goes.
 * It proves a symbol is REFERENCED. It cannot prove a symbol is REACHED. Those come
 * apart whenever a control is guarded by a state the production wiring never builds:
 * the destructive gate's "the user was asked and said no" branch was fully wired —
 * called from `gateDestructive`, which is called from `executeFunction`, which the
 * chat loop calls on every tool call — and still could not run, because the chat
 * route only ever handed the ledger a GRANTED consent record, so the declined status
 * the branch keys on was never constructed. Every reference this file counts was
 * real; the branch was dead anyway.
 *
 * That gap is not closable here without real dataflow analysis. A grep for the
 * literal 'declined' passes (the store genuinely produces it) — the defect was that
 * the consumer dropped it, which is a flow property, not a text property. A stricter
 * text rule would fire on ordinary code, and this file's whole value is that it never
 * does. So the guard for the reachability class is behavioural and lives elsewhere:
 * drive the REAL entry point into the state, and assert the control acted. See
 * tests/integration/consent-decline-reaches-gate.test.ts, which answers a consent
 * question with the non-affirming option through POST /api/chat and then checks the
 * records are still there. When a security control keys on a STATE, that is the shape
 * of test it needs; a call-site count is not a substitute for one.
 */
const SRC = join(import.meta.dirname, '..', '..', 'src');

/** Security-critical exports that MUST have at least one production call site. */
const MUST_BE_WIRED: readonly { symbol: string; definedIn: string; why: string }[] = [
  {
    symbol: 'maskAuditImagesForViewer',
    definedIn: 'gui/mutations.ts',
    why: "hides another member's cells in served audit images",
  },
  {
    symbol: 'maskAuditImages',
    definedIn: 'gui/mutations.ts',
    why: 'the per-entry mask the viewer-aware wrapper applies',
  },
  {
    symbol: 'maskSecretJson',
    definedIn: 'gui/mutations.ts',
    why: 'masks secret columns inside a row-snapshot JSON string',
  },
  {
    symbol: 'maskEncryptedJson',
    definedIn: 'gui/mutations.ts',
    why: 'keeps framework-encrypted credentials out of served audit images',
  },
  {
    symbol: 'auditEntryWithoutImages',
    definedIn: 'gui/mutations.ts',
    why: 'drops row snapshots from undo/redo/revert echoes',
  },
  {
    symbol: 'loadSecretColumns',
    definedIn: 'gui/mutations.ts',
    why: 'resolves which columns count as secret for a viewer',
  },
  {
    symbol: 'maskedColumnsForTables',
    definedIn: 'cloud/audience.ts',
    why: 'reads the masked column set a member can actually verify (view definitions)',
  },
  {
    symbol: 'dmlKeyGrantSql',
    definedIn: 'cloud/member-access.ts',
    why: 'the column grants that keep member writes working once base SELECT is revoked',
  },
  {
    symbol: 'redactRow',
    definedIn: 'gui/ai/handlers/read.ts',
    why: 'keeps secret cells out of assistant tool results',
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('security helpers are actually wired to something', () => {
  const files = sourceFiles(SRC).map((f) => ({
    rel: f.slice(SRC.length + 1).replace(/\\/g, '/'),
    text: readFileSync(f, 'utf8'),
  }));

  for (const { symbol, definedIn, why } of MUST_BE_WIRED) {
    it(`${symbol} has a production call site`, () => {
      // Count every reference except the definition itself. `src/index.ts` is
      // excluded because a re-export is not a use — that is precisely how a helper
      // can look referenced while nothing calls it.
      //
      // A reference from INSIDE the defining file counts: several of these are
      // composed by a sibling in the same module (the viewer-aware wrapper calls the
      // per-entry mask), and that is a real call site. What must not be zero is
      // "anything at all uses this", which is exactly what was zero when the leak
      // shipped.
      const re = new RegExp(`\\b${symbol}\\b`, 'g');
      const uses = files
        .filter((f) => f.rel !== 'index.ts')
        .reduce((n, f) => {
          const hits = (f.text.match(re) ?? []).length;
          return n + (f.rel === definedIn ? Math.max(0, hits - 1) : hits);
        }, 0);

      expect(
        uses,
        `"${symbol}" (${why}) is defined in ${definedIn} and called from nowhere in src/. ` +
          `A mask that is never called is not a mask — wire it or delete it. If it is ` +
          `genuinely obsolete, remove the export AND this registry entry in the same change, ` +
          `so the removal is a decision someone made rather than a gap nobody noticed.`,
      ).toBeGreaterThan(0);
    });
  }

  it('the registry names real, still-existing definitions', () => {
    // Guards the guard: a renamed or deleted helper must not leave an entry that
    // silently passes because some unrelated file happens to mention the name.
    for (const { symbol, definedIn } of MUST_BE_WIRED) {
      const def = files.find((f) => f.rel === definedIn);
      expect(def, `${definedIn} does not exist (registry entry for "${symbol}")`).toBeTruthy();
      expect(
        new RegExp(`(export\\s+(async\\s+)?function|export\\s+const)\\s+${symbol}\\b`).test(
          def?.text ?? '',
        ),
        `"${symbol}" is not exported from ${definedIn} any more — update the registry`,
      ).toBe(true);
    }
  });
});
