import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { probeCloud } from '../../src/framework/cloud-connect.js';

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-probe-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('probeCloud()', () => {
  it('returns reachable: true + teamEnabled: false for a fresh empty target', async () => {
    const root = tempDir();
    const dbPath = join(root, 'fresh.db');
    const url = `file:${dbPath}`;
    const result = await probeCloud(url);
    expect(result.reachable).toBe(true);
    expect(result.teamEnabled).toBe(false);
    expect(result.dialect).toBe('sqlite');
  });

  it('returns reachable: true + teamEnabled: true when the target has a team identity row', async () => {
    const root = tempDir();
    const dbPath = join(root, 'team.db');
    const url = `file:${dbPath}`;

    // Seed: create a Lattice, register the team_identity table, insert the singleton row.
    const seedDb = new Lattice(url);
    seedDb.define('__lattice_team_identity', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        team_id: 'TEXT NOT NULL',
        team_name: 'TEXT NOT NULL',
        creator_email: 'TEXT NOT NULL',
        created_at: 'TEXT NOT NULL',
      },
      primaryKey: 'id',
      render: () => '',
      outputFile: '.lattice-teams/team-identity.md',
    });
    await seedDb.init();
    await seedDb.insert('__lattice_team_identity', {
      id: 'singleton',
      team_id: 'team-abc',
      team_name: 'Atlas',
      creator_email: 'alice@example.com',
      created_at: new Date().toISOString(),
    });
    seedDb.close();

    const result = await probeCloud(url);
    expect(result.reachable).toBe(true);
    expect(result.teamEnabled).toBe(true);
    expect(result.teamName).toBe('Atlas');
    expect(result.dialect).toBe('sqlite');
  });

  it('returns reachable: false for an unreachable Postgres URL', async () => {
    // Port 1 is closed
    const result = await probeCloud('postgres://u:p@127.0.0.1:1/x');
    expect(result.reachable).toBe(false);
    expect(result.dialect).toBe('postgres');
    expect(typeof result.error).toBe('string');
  });

  it('classifies postgres:// URLs as dialect=postgres regardless of reachability', async () => {
    const result = await probeCloud('postgres://localhost:5/whatever');
    expect(result.dialect).toBe('postgres');
  });

  it('classifies non-postgres URLs as dialect=sqlite', async () => {
    const result = await probeCloud(`file:${tempDir()}/x.db`);
    expect(result.dialect).toBe('sqlite');
  });

  it('never throws — errors surface in result.error', async () => {
    // Pass a garbage URL — should resolve, not reject
    const result = await probeCloud('postgres://malformed@@@/x');
    expect(result.reachable).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});
