/**
 * Every schema operation the package EXPORTS is accounted for: either it carries
 * the owner rule, or it is pinned here with the reason it does not need to.
 *
 * The rule that a scoped member may not change the shape of a shared database
 * has to travel WITH the operation, because the same function serves a request,
 * a command, the assistant and a library call, and only one of those goes past a
 * request handler. That was already true and already written down — and two
 * operations were exported anyway with no rule on them at all, one of them
 * writing the SAME row of the SAME store as the neighbour that had it.
 *
 * Nothing caught that, because the test that drives the doors names its symbols
 * by hand: a new export simply is not in the list, so its absence reads as
 * nothing. This is the other half — it does not drive anything, it takes an
 * INVENTORY, and it fails when the inventory changes without a decision. Adding
 * an export lands it in one of these two lists on purpose, in the same change,
 * instead of landing in neither by default.
 *
 * Read from the two files that actually decide it: the package entry point (what
 * is exported) and the module (what each one does). Neither list is written from
 * memory.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = readFileSync(join(REPO_ROOT, 'src', 'index.ts'), 'utf8');
const MODULE = readFileSync(join(REPO_ROOT, 'src', 'gui', 'schema-ops.ts'), 'utf8');

/**
 * Exports that legitimately carry no owner rule, each with the reason.
 *
 * A reader may not be gated: refusing to ANSWER a member is not what the rule is
 * for, and a plan that cannot read the current shape cannot be shown to anyone.
 * A step of an already-gated operation is not gated again: the entry point that
 * reaches it refused first, and the step itself is not a door.
 */
const NOT_GATED: Record<string, string> = {
  physicalTableExists: 'reads: does this physical table exist',
  physicalColumnExists: 'reads: does this physical column exist',
  inboundLinksTo: 'reads: which links point at this table',
  describeInboundLinks: 'reads: the same links, as prose',
  readTableRoles: 'reads: the roles recorded for this workspace',
  normalizedEntityName: 'pure: the canonical form of a name, touching nothing',
  ensureRoleColumns:
    'adds the role columns to the framework metadata store; every caller that ' +
    'records a role is gated first, and a member reaching it directly can only ' +
    'widen an internal bookkeeping table nobody reads as data',
  materializeJunction:
    'a step of creating a link table — createUserJunction / createFileJunction / ' +
    'the assistant path all refuse a member before reaching it',
  renameTablesCarryingPolicy: 'a step of renameUserEntity, which refuses first',
  renameColumnsCarryingPolicy: 'a step of renameUserColumn, which refuses first',
  dropColumnCarryingPolicy: 'a step of the column drop, which refuses first',
};

/** The symbols the package entry point re-exports from the schema-op module. */
function exportedSchemaOps(): string[] {
  const block = /export \{([^}]*)\} from '\.\/gui\/schema-ops\.js';/.exec(INDEX);
  expect(block, 'the package entry point must re-export the schema-op module').not.toBeNull();
  return block![1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Each exported FUNCTION and whether its body carries the owner rule. */
function gateByFunction(): Map<string, boolean> {
  const starts: { name: string; at: number }[] = [];
  const re = /^export (?:async )?function (\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(MODULE)) !== null) starts.push({ name: m[1], at: m.index });

  const out = new Map<string, boolean>();
  for (const [i, s] of starts.entries()) {
    const body = MODULE.slice(s.at, starts[i + 1]?.at ?? MODULE.length);
    out.set(s.name, body.includes('assertCloudOwner('));
  }
  return out;
}

describe('the exported schema-operation surface', () => {
  it('has an owner rule on every operation, or a stated reason it needs none', () => {
    const gates = gateByFunction();
    const surprises: string[] = [];

    for (const name of exportedSchemaOps()) {
      const gated = gates.get(name);
      // Not a function (a class, a constant) — no operation, nothing to gate.
      if (gated === undefined) continue;
      const excused = name in NOT_GATED;
      if (!gated && !excused) {
        surprises.push(
          `${name} is exported and changes the workspace, but carries no owner rule. ` +
            `Add "await assertCloudOwner(active.db, '<verb>')" as its FIRST statement, ` +
            `or list it in NOT_GATED with the reason it needs none.`,
        );
      }
      if (gated && excused) {
        surprises.push(
          `${name} now carries the owner rule but is still listed in NOT_GATED as ` +
            `"${NOT_GATED[name]}" — remove the entry so the list keeps meaning something.`,
        );
      }
    }

    expect(surprises.join('\n')).toBe('');
  });

  it('states a reason for every excused export, and excuses nothing that is gone', () => {
    // A pinned list whose entries no longer name anything is how an inventory
    // rots into decoration.
    const exported = new Set(exportedSchemaOps());
    for (const [name, reason] of Object.entries(NOT_GATED)) {
      expect(exported.has(name), `NOT_GATED names ${name}, which is no longer exported`).toBe(true);
      expect(reason.length, `NOT_GATED[${name}] must say why`).toBeGreaterThan(20);
    }
  });

  it('holds the two that shipped without it — they write what a table IS', () => {
    // Named, because they are the reason this file exists: the browser refused a
    // scoped member these, and the package entry point served them.
    const gates = gateByFunction();
    expect(gates.get('setTableRole'), 'setTableRole must carry the owner rule').toBe(true);
    expect(gates.get('applyShapeOp'), 'applyShapeOp must carry the owner rule').toBe(true);
    // ...and so must the neighbour that writes the same row, which always did.
    expect(gates.get('setTableDefinition')).toBe(true);
  });
});
