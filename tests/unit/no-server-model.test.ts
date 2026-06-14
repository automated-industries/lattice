/**
 * Regression guard for the v3 cloud redesign: the serve/team-server model is
 * GONE and must stay gone. v3 clouds are a shared Postgres DB that every user
 * connects to DIRECTLY as their own scoped role, with Postgres RLS as the only
 * security boundary — there is no server process, no bearer auth, no replica
 * client, no `__lattice_team_*` tables, no reconnect banner. Each prior release
 * the next change rebuilt exactly what was deleted; this test fails the build if
 * any of those markers reappears in source. (Source-only scan — docs may carry
 * deliberate "removed in 3.0" denial notes.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');

function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Each marker: a substring that must not appear anywhere in src/. The label is
// what reappearing would mean (so a failure points at the resurrected concept).
const FORBIDDEN: { marker: string; label: string }[] = [
  { marker: '--team-cloud', label: 'the deleted `serve --team-cloud` flag' },
  { marker: "case 'serve'", label: 'the deleted `lattice serve` CLI command' },
  { marker: '__lattice_team_', label: 'a deleted team-registry table (__lattice_team_*)' },
  { marker: '__lattice_api_tokens', label: 'the deleted bearer-token table' },
  { marker: '/api/teams-gui/', label: 'a deleted team-registry GUI route' },
  { marker: 'dispatchTeamRoute', label: 'the deleted team-server route dispatcher' },
  { marker: 'hosted Lattice Teams', label: 'the deleted "hosted Lattice Teams URL" wording' },
  { marker: 'cloud-reconnect', label: 'the deleted direct-cloud reconnect banner' },
  { marker: 'teamEnabled', label: 'the retired teamEnabled probe flag (use isCloud)' },
];

describe('v3 cloud redesign — the server/team model stays deleted', () => {
  const files = allTsFiles(SRC);

  it('source tree has no team-server / serve / bearer / banner markers', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const { marker, label } of FORBIDDEN) {
        if (text.includes(marker)) {
          offenders.push(`${file.replace(SRC, 'src')}: "${marker}" — ${label}`);
        }
      }
    }
    expect(offenders, `Deleted server-model markers reappeared:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });
});
