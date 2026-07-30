/**
 * The cloud surface is reachable from the package entry.
 *
 * Running a shared cloud — seeing who is on it, inviting someone, letting them
 * join, sharing a row — used to be reachable only by starting the browser app
 * and sending it a request. On a machine with no browser that left one
 * workaround: bind the app to a network address, which its own help text calls
 * unauthenticated. Removing that workaround means these operations have to be
 * ordinary function calls.
 *
 * "Ordinary function call" has a precise test, and it is the one below: import
 * the name from `latticesql` — the package entry, the specifier a consumer can
 * actually write — and get a function. Not a deep path into `src/cloud/…`, which
 * is not published and would pass while the public surface stayed empty. That
 * distinction is the whole point: the docs already told people to import these
 * from the library, and for several of them the import simply failed.
 *
 * The sibling snapshot test records the entry's whole surface and guards it
 * against shrinking. This one is narrower and states the claim directly: these
 * specific names, the ones the cloud flows are made of, are on it and callable.
 */
import { describe, it, expect } from 'vitest';
import * as lattice from '../../src/index.js';

/**
 * Every cloud operation, grouped by the flow it belongs to.
 *
 * Grouped rather than listed flat because the gap was never "one symbol is
 * missing" — it was that a whole flow had no library path. Joining was the worst
 * of the three: the token could be minted but never read and never spent, so a
 * member could not join at all without a browser. Written this way, a future
 * removal fails against the name of the flow it breaks.
 */
const CLOUD_FLOWS: Record<string, string[]> = {
  // Find out where you stand and what is wrong — the question the browser app
  // could not answer for you, because it is what stops working when the answer
  // is bad.
  'diagnose one': ['cloudStatus', 'cloudRlsInstalled', 'canManageRoles'],
  // Turn a Postgres database into a cloud, and keep it secured as it grows.
  'secure a cloud': [
    'secureCloud',
    'secureNewCloudTable',
    'reconcileCloudMemberAccess',
    'publishSharedSchema',
  ],
  // Move a local workspace into one.
  'migrate a local workspace in': [
    'openTargetLatticeForMigration',
    'migrateLatticeData',
    'archiveLocalSqlite',
    'probeCloud',
  ],
  // Provision someone a scoped role and hand them the credential for it.
  'invite a member': [
    'inviteMember',
    'mintInviteToken',
    'assertScopedMemberRole',
    'poolerAwareUser',
  ],
  // Redeem that credential and end up with a working workspace.
  'join as a member': [
    'redeemInviteToken',
    'claimMemberInvite',
    'redeemCloudInvite',
    'joinCloud',
    'createCloudWorkspace',
  ],
  // See who is on the cloud, and take someone off it.
  'manage who is on it': ['listCloudMembers', 'removeMember', 'currentDatabaseRole'],
  // Decide who can see which rows.
  'share rows': [
    'shareRow',
    'grantRow',
    'revokeRow',
    'batchRowGrants',
    'grantRowAccess',
    'batchRowAccess',
    'setRowVisibility',
  ],
};

describe('the cloud flows are callable from the package entry', () => {
  for (const [flow, symbols] of Object.entries(CLOUD_FLOWS)) {
    it(`exports every function needed to ${flow}`, () => {
      const missing = symbols.filter((name) => typeof (lattice as never)[name] !== 'function');
      expect(
        missing,
        `These names are not callable functions on the package entry:\n` +
          `${missing.join('\n')}\n\n` +
          `Someone doing this without a browser imports them from 'latticesql'. ` +
          `A missing one means that flow needs a running server again, which is ` +
          `the gap this surface exists to close.`,
      ).toEqual([]);
    });
  }

  it('reaches them through the entry point, not a deep path', () => {
    // Guards the guard. Importing `src/cloud/membership.js` directly would make
    // every assertion above pass while the published surface stayed empty —
    // exactly the state this stage found the tree in. The module under test is
    // the entry point itself, so pin that it really is one: it publishes the
    // main class, and it is a module namespace rather than a re-exported object.
    expect(typeof lattice.Lattice).toBe('function');
    expect(Object.keys(lattice).length).toBeGreaterThan(100);
  });

  it('names no symbol twice across the flows', () => {
    // A duplicate would make one flow's coverage look broader than it is, and
    // would survive a deletion by passing under the other flow's name.
    const all = Object.values(CLOUD_FLOWS).flat();
    const dupes = [...new Set(all.filter((n, i) => all.indexOf(n) !== i))];
    expect(dupes, `listed under more than one flow: ${dupes.join(', ')}`).toEqual([]);
  });
});
